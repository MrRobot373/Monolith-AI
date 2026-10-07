/**
 * The internal API a Work AI runtime calls back into, authenticated by its per-task token.
 *
 *   POST /api/internal/work/llm/v1/chat/completions   OpenAI-compatible model gateway (quota, metering, live text)
 *   POST /api/internal/work/approvals                  ask a person before a risky action
 *   GET  /api/internal/work/approvals/:id?wait=25      long-poll for the decision
 *   POST /api/internal/work/search                     private web search (self-hosted SearXNG)
 */
import { eq, sql, usageEvent, workTask } from "@aatmiq/db";
import { estimateUsage, fetchWithKeys, openAiBase } from "@aatmiq/model-gateway";
import { estimateTokens } from "@aatmiq/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse, type AppContext } from "../context";
import { HttpError } from "../errors";
import { resolveModel } from "../services/models";
import { quotaFor } from "../services/quota";
import { getWorkSettings } from "../services/work";

const BASE = "/api/internal/work";
/** Statuses worth retrying: the server is busy or briefly broken, not refusing the request. */
const TRANSIENT = new Set([408, 425, 500, 502, 503, 504, 529]);
const RETRY_DELAYS_MS = [1500, 4000, 8000];
/** How long a model server may take to start answering, and to go quiet mid-answer. */
const FIRST_BYTE_MS = 150_000;
const STALL_MS = 150_000;
const internal = { config: { rateLimit: false } } as const;

/** OpenAI-style error body, so the runtime reports a readable message. */
function llmError(reply: FastifyReply, status: number, message: string, type = "aatmiq_error") {
  return reply.status(status).send({ error: { message, type } });
}

type OpenAiChunk = {
  choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};

export async function workInternalRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, box, work } = ctx;

  const taskOf = (req: FastifyRequest) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const t = token ? work.fromToken(token) : null;
    if (!t) throw new HttpError(401, "This task isn't running.", "unauthorized");
    return t;
  };

  app.post(`${BASE}/llm/v1/chat/completions`, { ...internal, bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
    const t = taskOf(req);
    const refuse = (status: number, message: string) => {
      work.reportError(t.taskId, message);
      return llmError(reply, status, message);
    };
    if (!(await ctx.license.hasSection("work"))) return refuse(403, "Work AI isn't included in your organization's license.");
    const [task] = await db.select({ modelId: workTask.modelId, codeWorkspaceId: workTask.codeWorkspaceId }).from(workTask).where(eq(workTask.id, t.taskId));
    let resolved: Awaited<ReturnType<typeof resolveModel>>;
    try {
      resolved = await resolveModel(db, box, t.workspaceId, task?.codeWorkspaceId ? "code" : "work", task?.modelId, t.userId);
    } catch (e) {
      return refuse(400, e instanceof Error ? e.message : "No model is available.");
    }
    const { model: m, provider } = resolved;
    // The workspace pays for its own models; a group pays for a model only it gives.
    const { status: quota, groupId } = await quotaFor(db, t.workspaceId, t.userId, m);
    if (!quota.result.allowed)
      return refuse(402, quota.scope.kind === "group" ? `You've used your share of the ${quota.scope.name} group's tokens for this period. Ask your admin for more.` : "You've used your token allowance for this period. Ask your admin for more tokens.");
    const body = (req.body ?? {}) as Record<string, unknown> & { messages?: unknown[]; stream?: boolean };
    const inputGuess = estimateTokens(JSON.stringify(body.messages ?? []));
    const started = Date.now();

    const meter = async (usage: { inputTokens: number; outputTokens: number; estimated: boolean }, status: "ok" | "error" | "aborted") => {
      await db.insert(usageEvent).values({
        workspaceId: t.workspaceId,
        userId: t.userId,
        modelId: m.id,
        groupId,
        section: "work",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimated: usage.estimated,
        latencyMs: Date.now() - started,
        status,
      });
      await db
        .update(workTask)
        .set({
          inputTokens: sql`${workTask.inputTokens} + ${usage.inputTokens}`,
          outputTokens: sql`${workTask.outputTokens} + ${usage.outputTokens}`,
        })
        .where(eq(workTask.id, t.taskId));
    };

    // The demo model can't use tools: it explains that and finishes the turn.
    if (provider.type === "mock") {
      const text =
        "I'm the built-in demo model, so I can't run commands, edit files or use tools. Ask your admin to connect a real model (for example through Ollama or vLLM) and enable it for Work AI.";
      const usage = { ...estimateUsage([], text), inputTokens: inputGuess };
      await meter(usage, "ok");
      work.pulse(t.taskId, "delta", { text });
      const id = `chatcmpl-demo-${Date.now()}`;
      const usageJson = { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens };
      if (!body.stream) {
        return reply.send({ id, object: "chat.completion", model: m.id, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: usageJson });
      }
      reply.hijack();
      reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (o: unknown) => reply.raw.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: m.id, ...(o as object) })}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: text } }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      chunk({ choices: [], usage: usageJson });
      reply.raw.end("data: [DONE]\n\n");
      return;
    }

    const abort = new AbortController();
    let upstream: Response | null = null;
    let lastNetworkError = "";
    // Busy or briefly failing model servers ("temporarily overloaded") get a few calm retries here,
    // before the runtime ever sees an error.
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
      try {
        // fetchWithKeys moves to the provider's next API key when one hits its limit.
        // A server that hasn't started answering after a while is stuck in a queue: try again.
        const attemptAbort = new AbortController();
        const slow = setTimeout(() => attemptAbort.abort(new Error("no answer in time")), FIRST_BYTE_MS);
        try {
          upstream = await fetchWithKeys(provider, `${openAiBase(provider)}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...body, model: m.modelKey, ...(body.stream ? { stream_options: { include_usage: true } } : {}) }),
            signal: AbortSignal.any([abort.signal, attemptAbort.signal]),
          });
        } finally {
          clearTimeout(slow);
        }
        if (!TRANSIENT.has(upstream.status) || attempt === RETRY_DELAYS_MS.length) break;
        const after = Number(upstream.headers.get("retry-after"));
        await upstream.body?.cancel().catch(() => undefined);
        await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 && after <= 10 ? after * 1000 : RETRY_DELAYS_MS[attempt]));
      } catch (e) {
        lastNetworkError = e instanceof Error ? e.message : "network error";
        upstream = null;
        if (abort.signal.aborted || attempt === RETRY_DELAYS_MS.length) break;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
    if (!upstream) return refuse(502, `The model server couldn't be reached (${lastNetworkError}).`);
    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 300);
      await meter({ inputTokens: 0, outputTokens: 0, estimated: true }, "error");
      return refuse(upstream.status >= 400 ? upstream.status : 502, `The model server answered ${upstream.status}${detail ? `: ${detail}` : ""}`);
    }

    work.clearError(t.taskId);
    if (!body.stream) {
      const json = (await upstream.json()) as { choices?: { message?: { content?: string } }[]; usage?: OpenAiChunk["usage"] };
      const text = json.choices?.[0]?.message?.content ?? "";
      if (text) work.pulse(t.taskId, "delta", { text });
      await meter(
        json.usage?.prompt_tokens != null
          ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens ?? 0, estimated: false }
          : { inputTokens: inputGuess, outputTokens: estimateTokens(text), estimated: true },
        "ok",
      );
      return reply.send(json);
    }

    // Stream through unchanged; read along for the text (shown live) and usage (metered).
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache" });
    let finished = false;
    res.on("close", () => {
      if (!finished) abort.abort();
    });
    const decoder = new TextDecoder();
    let buf = "";
    let output = "";
    let usage: { inputTokens: number; outputTokens: number; estimated: boolean } | null = null;
    const readLine = (line: string) => {
      if (!line.startsWith("data:")) return;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as OpenAiChunk;
        const delta = json.choices?.[0]?.delta;
        const text = delta?.content;
        if (text) {
          output += text;
          work.pulse(t.taskId, "delta", { text });
        }
        // Reasoning models (gpt-oss, deepseek, qwen3…) think before answering; show that live too.
        const thinking = delta?.reasoning ?? delta?.reasoning_content;
        if (thinking) work.pulse(t.taskId, "reasoning", { text: thinking });
        if (json.usage && typeof json.usage.prompt_tokens === "number") {
          usage = { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens ?? 0, estimated: false };
        }
      } catch {
        /* not JSON: passed through anyway */
      }
    };
    let status: "ok" | "error" | "aborted" = "ok";
    // A stream that goes quiet for too long is cut, so the runtime retries instead of waiting forever.
    let stall = setTimeout(() => abort.abort(), STALL_MS);
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(stall);
        stall = setTimeout(() => abort.abort(), STALL_MS);
        res.write(chunk);
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          readLine(buf.slice(0, nl).trim());
          buf = buf.slice(nl + 1);
        }
      }
      readLine(buf.trim());
    } catch {
      status = abort.signal.aborted ? "aborted" : "error";
    }
    clearTimeout(stall);
    finished = true;
    res.end();
    await meter(usage ?? { inputTokens: inputGuess, outputTokens: estimateTokens(output), estimated: true }, status);
  });

  const approvalSchema = z.object({
    callId: z.string().max(200).nullable().optional(),
    toolName: z.string().min(1).max(200),
    reason: z.string().max(500).nullable().optional(),
  });
  app.post(`${BASE}/approvals`, internal, async (req) => {
    const t = taskOf(req);
    const b = parse(approvalSchema, req.body);
    const a = await work.requestApproval(t.taskId, { callId: b.callId ?? null, toolName: b.toolName, reason: b.reason ?? null });
    return { id: a.id };
  });

  app.get<{ Params: { id: string }; Querystring: { wait?: string } }>(`${BASE}/approvals/:id`, internal, async (req, reply) => {
    const t = taskOf(req);
    const wait = Math.max(0, Math.min(25, Number(req.query.wait ?? 0) || 0));
    const status = await work.waitForApproval(t.taskId, req.params.id, wait);
    if (!status) return reply.status(404).send({ error: "Approval not found" });
    return { status };
  });

  const searchSchema = z.object({ query: z.string().trim().min(1).max(500), maxResults: z.number().int().min(1).max(20).default(8) });
  app.post(`${BASE}/search`, internal, async (req, reply) => {
    taskOf(req);
    const b = parse(searchSchema, req.body);
    const settings = await getWorkSettings(db);
    if (!settings.searxngUrl) return reply.status(503).send({ error: "Web search isn't set up. An admin can add a SearXNG server in Admin → Work AI." });
    const url = new URL("search", settings.searxngUrl.replace(/\/?$/, "/"));
    url.searchParams.set("q", b.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", "1");
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`SearXNG answered ${r.status}`);
      const json = (await r.json()) as { results?: { url?: string; title?: string; content?: string }[]; answers?: unknown[] };
      const sources = (json.results ?? [])
        .filter((x) => typeof x.url === "string")
        .slice(0, b.maxResults)
        .map((x) => ({ url: x.url!, title: x.title ?? x.url!, snippet: (x.content ?? "").slice(0, 600) }));
      const answers = (json.answers ?? []).filter((a): a is string => typeof a === "string");
      return { sources, ...(answers.length ? { content: answers.join("\n") } : {}), truncated: (json.results?.length ?? 0) > sources.length };
    } catch (e) {
      return reply.status(502).send({ error: `Web search failed: ${e instanceof Error ? e.message : "unknown error"}` });
    }
  });
}
