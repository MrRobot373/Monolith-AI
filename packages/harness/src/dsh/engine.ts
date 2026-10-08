/**
 * DeepSeek Harness engine: one `dsh --profile sdk` process per task, driven over stdio JSON-RPC.
 * The process runs in the task's folder with a scrubbed environment; models, approvals and search
 * go back to Aatmiq through the per-task token.
 */
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stripReminders } from "../../dsh-plugin/tooling.mjs";
import { resolveFromHarness } from "../files";
import type { HarnessEngine, HarnessEvent, TaskRuntime, TaskSpec } from "../types";
import { buildPatch, PROVIDER_ID } from "./patch";

/** Where the DSH CLI lives: AATMIQ_DSH_CLI (production images, see deploy/dsh), else this package's copy. */
export async function dshCli(): Promise<string> {
  if (process.env.AATMIQ_DSH_CLI) return process.env.AATMIQ_DSH_CLI;
  const pkgPath = resolveFromHarness("@deepseek-ai/dsh/package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.dsh ?? Object.values(pkg.bin ?? {})[0]);
  if (!bin) throw new Error("The DeepSeek Harness package has no CLI entry");
  return join(dirname(pkgPath), bin);
}

export interface Launcher {
  /** Start the runtime process. Process mode runs it directly; container mode wraps it. */
  spawn(args: { cli: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv; spec: TaskSpec }): ChildProcess;
}

export const processLauncher: Launcher = {
  spawn: ({ cli, argv, cwd, env, spec }) =>
    spawn(process.execPath, [cli, ...argv], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(spec.uid !== undefined ? { uid: spec.uid, gid: spec.gid ?? spec.uid } : {}),
    }),
};

type DshSessionEvent = { type: string; data?: Record<string, unknown> };
type Block = { type: string; text?: string; id?: string; name?: string };

const textOf = (content: unknown) =>
  Array.isArray(content)
    ? (content as Block[])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
    : "";

/** Translate one DSH session event into Aatmiq's vocabulary (or nothing). */
export function mapEvent(ev: DshSessionEvent): HarnessEvent | null {
  const d = ev.data ?? {};
  switch (ev.type) {
    case "user/message": {
      const src = d.source as { kind?: string } | undefined;
      if (src?.kind !== "user") return null; // runtime context and plugin notes stay internal
      return { type: "user", id: String(d.id ?? ""), text: textOf(d.content) };
    }
    case "assistant/message": {
      const m = d.message as { id?: string; content?: Block[] } | undefined;
      const usage = d.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      return {
        type: "assistant",
        id: String(m?.id ?? ""),
        text: textOf(m?.content),
        toolCalls: (m?.content ?? []).filter((b) => b.type === "tool-call").map((b) => ({ callId: String(b.id), name: String(b.name) })),
        usage: usage ? { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } : undefined,
      };
    }
    case "tool/call": {
      let args: unknown = d.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          /* keep the raw string */
        }
      }
      return { type: "tool_call", callId: String(d.callId), name: String(d.name), args };
    }
    case "tool/result": {
      const m = d.message as { toolCallId?: string; content?: Block[]; isError?: boolean } | undefined;
      // Plan reminders are for the agent, not for the person reading the step.
      return { type: "tool_result", callId: String(m?.toolCallId ?? ""), text: stripReminders(textOf(m?.content)), isError: !!m?.isError };
    }
    case "todo/write": {
      const items = (d.todos ?? d.items) as { content?: string; status?: string }[] | undefined;
      return Array.isArray(items) ? { type: "plan", items: items.map((t) => ({ content: String(t.content ?? ""), status: String(t.status ?? "pending") })) } : null;
    }
    case "session/title":
      return typeof d.title === "string" ? { type: "title", title: d.title } : null;
    case "turn/end": {
      const r = d.reason as { kind?: string; error?: { message?: string } } | undefined;
      return { type: "turn_end", reason: r?.kind ?? "completed", ...(r?.error?.message ? { error: r.error.message } : {}) };
    }
    default:
      return null;
  }
}

/**
 * The deployment's network settings, passed through so tasks work behind a corporate proxy or a
 * TLS-inspecting firewall (the CA file must be readable by task users, e.g. under /etc/ssl).
 */
const NETWORK_ENV = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
];

/** The NETWORK_ENV variables set in this process. */
export function networkEnv(): Record<string, string> {
  return Object.fromEntries(NETWORK_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k]!]));
}

/** Environment for the runtime: nothing from the API process leaks in (no database URL, no secrets). */
function runtimeEnv(spec: TaskSpec): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: spec.homeDir,
    DSH_HOME: spec.homeDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    TZ: process.env.TZ ?? "UTC",
    NODE_ENV: "production",
    DSH_PERMISSION_MODE: spec.sandbox === "off" ? "danger-full-access" : "workspace-write",
    AATMIQ_TOKEN: spec.token,
    ...networkEnv(),
  };
}

export function createDshEngine(opts: { launcher?: Launcher; initializeTimeoutMs?: number } = {}): HarnessEngine {
  const launcher = opts.launcher ?? processLauncher;
  return {
    id: "dsh",
    async start(spec, onEvent) {
      await mkdir(spec.workdir, { recursive: true });
      await mkdir(spec.homeDir, { recursive: true });
      const patchPath = join(spec.homeDir, "aatmiq.patch.yml");
      await writeFile(patchPath, buildPatch(spec));
      if (spec.uid !== undefined) {
        const gid = spec.gid ?? spec.uid;
        for (const p of [spec.workdir, spec.homeDir, patchPath]) await chown(p, spec.uid, gid);
      }
      const cli = await dshCli();
      const child = launcher.spawn({ cli, argv: ["--profile", "sdk", "--patch", patchPath], cwd: spec.workdir, env: runtimeEnv(spec), spec });

      let stderr = "";
      child.stderr?.on("data", (b: Buffer) => {
        stderr = (stderr + b.toString()).slice(-4000);
      });
      let alive = true;
      const exited = new Promise<void>((resolve) => {
        child.on("exit", (code) => {
          alive = false;
          onEvent({ type: "exit", code, ...(code ? { error: stderr.trim().split("\n").slice(-5).join("\n") } : {}) });
          resolve();
        });
        child.on("error", (e) => {
          alive = false;
          onEvent({ type: "exit", code: -1, error: e.message });
          resolve();
        });
      });

      const transport = new JsonRpcLineTransport(child.stdout!, child.stdin!);
      // The task's own session; subagents run in sessions of their own. Their steps are shown, but
      // their messages, plans and turn ends are theirs: the task ends when its own turn does and no
      // subagent is still working (a finished subagent wakes the main agent for another turn).
      // `children` holds the subagents working right now.
      const sessionId = `session-${randomUUID().replaceAll("-", "")}`;
      const children = new Set<string>();
      let held: HarnessEvent | null = null;
      let rootRunning = false;
      let settle: NodeJS.Timeout | undefined;
      const releaseHeld = () => {
        clearTimeout(settle);
        settle = setTimeout(() => {
          if (held && !rootRunning && children.size === 0) {
            const e = held;
            held = null;
            onEvent(e);
          }
        }, 3000);
      };
      transport.onNotification((method, params) => {
        if (method === "session.event") {
          const mapped = mapEvent(params.event as DshSessionEvent);
          if (!mapped) return;
          if (params.sessionId !== sessionId) {
            if (mapped.type === "tool_call" || mapped.type === "tool_result") onEvent(mapped);
            return;
          }
          if (mapped.type === "turn_end" && children.size > 0) {
            held = mapped;
            return;
          }
          if (mapped.type === "user" && held) held = null; // the main agent was woken for another turn
          onEvent(mapped);
        } else if (method === "session.status") {
          if (params.sessionId !== sessionId) {
            // A subagent that stopped working (an interrupted one never reports "finished") no
            // longer holds the task open; one that's woken again (a message from the agent) does.
            if (!children.has(String(params.sessionId)) && params.status !== "running") return;
            if (params.status === "running") children.add(String(params.sessionId));
            else children.delete(String(params.sessionId));
            if (held && children.size === 0) releaseHeld();
            return;
          }
          rootRunning = params.status === "running";
          if (rootRunning) held = null;
          onEvent({ type: "status", status: rootRunning ? "running" : "idle" });
        } else if (method === "subagent.started") {
          children.add(String(params.childSessionId));
        } else if (method === "subagent.finished") {
          children.delete(String(params.childSessionId));
          if (held && children.size === 0) releaseHeld();
        }
      });
      transport.start();

      const timeout = opts.initializeTimeoutMs ?? 60_000;
      try {
        await Promise.race([
          transport.request("initialize", { cwd: spec.workdir, provider: PROVIDER_ID, model: spec.model.key }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("The agent runtime didn't start in time.")), timeout)),
          exited.then(() => {
            throw new Error(`The agent runtime stopped while starting.${stderr ? ` ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`);
          }),
        ]);
      } catch (e) {
        child.kill("SIGKILL");
        // The runtime's own last words explain more than "input closed".
        const tail = stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 500);
        if (tail && !(e as Error).message.includes(tail)) throw new Error(`The agent runtime couldn't start: ${tail}`);
        throw e;
      }

      const runtime: TaskRuntime = {
        sessionId,
        get alive() {
          return alive;
        },
        async send(text) {
          await transport.request("session/prompt", { sessionId, contentBlocks: [{ type: "text", text }] });
        },
        async stop() {
          if (!alive) return;
          try {
            await Promise.race([transport.request("shutdown", {}), new Promise((r) => setTimeout(r, 3000))]);
          } catch {
            /* already gone */
          }
          if (alive) child.kill("SIGTERM");
          await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
          if (alive) child.kill("SIGKILL");
        },
      };
      return runtime;
    },
  };
}
