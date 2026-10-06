/**
 * Aatmiq plugin for the DeepSeek Harness runtime (mounted by the task patch).
 *
 *  - tools/pre-execute: asks for approval before risky actions (policy.mjs)
 *  - approval/request:  the answerer: the question goes to Aatmiq, where a person approves or rejects it
 *  - web search:        a "aatmiq" provider that searches through Aatmiq (self-hosted SearXNG)
 *
 * Everything talks to Aatmiq's internal API with the per-task token from $AATMIQ_TOKEN.
 * Failures fail closed: an unanswerable approval is "unavailable", which DSH treats as a denial.
 */
import { classifyRisk } from "./policy.mjs";

export const name = "aatmiq";
export const inject = ["tools", "approval", "web"];

const POLL_SECONDS = 25;

function client(config) {
  const token = process.env.AATMIQ_TOKEN ?? "";
  const base = String(config.controlUrl).replace(/\/$/, "");
  return async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `Aatmiq answered ${res.status}`);
    return body;
  };
}

export function apply(ctx, config) {
  const call = client(config);
  const policy = { approvals: config.approvals ?? "risky", askForNetwork: !!config.askForNetwork, connectors: config.connectors ?? [] };

  // 1. Policy: decide which calls need a person.
  ctx.on("tools/pre-execute", async (exec, next) => {
    const decision = await next();
    if (decision.kind !== "allow") return decision;
    const reason = classifyRisk({ name: exec.name, args: exec.arguments }, policy);
    return reason ? { kind: "ask", reason } : decision;
  });

  // 2. Answerer: ask the person in Aatmiq and wait for the decision.
  ctx.on("approval/request", async (req) => {
    try {
      const { id } = await call("/approvals", {
        method: "POST",
        body: JSON.stringify({ callId: req.callId ?? null, toolName: req.toolName, reason: req.reason ?? null }),
        signal: req.signal,
      });
      for (;;) {
        if (req.signal?.aborted) return "cancelled";
        const r = await call(`/approvals/${encodeURIComponent(id)}?wait=${POLL_SECONDS}`, { signal: req.signal });
        if (r.status === "approved") return "allowed-once";
        if (r.status === "rejected") return "rejected";
        if (r.status === "expired") return "unavailable";
      }
    } catch (e) {
      if (req.signal?.aborted) return "cancelled";
      return "unavailable";
    }
  });

  // 3. Private web search through Aatmiq.
  ctx.effect(() => ctx.web.registerSearchProvider({
    id: "aatmiq",
    available: () => !!config.webSearch,
    async search(request, signal) {
      const r = await call("/search", { method: "POST", body: JSON.stringify({ query: request.query, maxResults: request.maxResults ?? 8 }), signal });
      return { ...(r.content ? { content: r.content } : {}), sources: r.sources ?? [], truncated: !!r.truncated };
    },
  }));
}
