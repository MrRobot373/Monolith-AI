/**
 * Aatmiq plugin for the DeepSeek Harness runtime (mounted by the task patch).
 *
 *  - tools/pre-execute: asks for approval before risky actions (policy.mjs)
 *  - tools/execute:     fixes common argument slips before the tool checks them (tooling.mjs)
 *  - tools/post-execute: reminds the agent to keep its plan current
 *  - approval/request:  the answerer: the question goes to Aatmiq, where a person approves or rejects it
 *  - web search:        a "aatmiq" provider that searches through Aatmiq (self-hosted SearXNG)
 *
 * Everything talks to Aatmiq's internal API with the per-task token from $AATMIQ_TOKEN.
 * Failures fail closed: an unanswerable approval is "unavailable", which DSH treats as a denial.
 */
import { classifyRisk } from "./policy.mjs";
import { cleanArgs, planReminder } from "./tooling.mjs";

export const name = "aatmiq";
export const inject = ["tools", "approval", "web"];

const POLL_SECONDS = 25;
const SANDBOX_MODE = process.env.DSH_PERMISSION_MODE || "workspace-write";

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

  // 2. Arguments: models add `sandbox_permissions` to every call (often with made-up values) and
  //    misname todo fields. Fix what's unambiguous; the tool still checks the result.
  ctx.on("tools/execute", (exec, next) => {
    const args = cleanArgs(exec.name, exec.arguments, SANDBOX_MODE);
    if (args !== exec.arguments) exec.arguments = Object.freeze(args);
    return next();
  });

  // 3. Plan: after a few steps without a todo_write, remind the agent (in the tool result) to
  //    update it, so the progress people see stays true. Kept per agent and per turn.
  const plans = new WeakMap();
  const planOf = (agent) => {
    const key = agent ?? ctx;
    if (!plans.has(key)) plans.set(key, { turn: null, todos: null, since: 0, due: null });
    return plans.get(key);
  };
  ctx.on("agent/pre-step", (step, next) => {
    const p = planOf(step.agent);
    if (p.turn !== step.turn) Object.assign(p, { turn: step.turn, todos: null, since: 0, due: null });
    return next();
  });
  ctx.on("tools/post-execute", async (exec, result, next) => {
    const decision = await next();
    const p = planOf(exec.agent);
    if (exec.name === "todo_write") {
      if (!result.isError) Object.assign(p, { todos: exec.arguments?.todos ?? null, since: 0, due: null });
      return decision;
    }
    if (!p.todos) return decision;
    p.since += 1;
    p.due = planReminder(p.todos, p.since) ?? p.due;
    if (!p.due || result.isError || decision.kind !== "accept" || Object.hasOwn(decision, "value")) return decision;
    const content = [...(decision.content ?? result.content ?? []), { type: "text", text: p.due }];
    p.due = null;
    return { ...decision, content };
  });

  // 4. Answerer: ask the person in Aatmiq and wait for the decision.
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

  // 5. Private web search through Aatmiq.
  ctx.effect(() => ctx.web.registerSearchProvider({
    id: "aatmiq",
    available: () => !!config.webSearch,
    async search(request, signal) {
      const r = await call("/search", { method: "POST", body: JSON.stringify({ query: request.query, maxResults: request.maxResults ?? 8 }), signal });
      return { ...(r.content ? { content: r.content } : {}), sources: r.sources ?? [], truncated: !!r.truncated };
    },
  }));
}
