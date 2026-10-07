/**
 * Engine-neutral contract between Aatmiq and an agent harness. Today the engine is DeepSeek Harness;
 * keeping this boundary means the product never depends on DSH's (developer-preview) internals.
 */

export type ApprovalMode = "risky" | "always" | "never";

export interface ConnectorSpec {
  /** Tool namespace: tools appear as mcp__<name>__<tool>. */
  name: string;
  /** What people call it ("Gmail"), and whose account it is, for the agent's brief. */
  displayName?: string;
  account?: string | null;
  url: string;
  headers?: Record<string, string>;
  /** Tool-name globs (without the mcp__name__ prefix) that need a person's approval. "*" = all. */
  approveTools: string[];
}

export interface TaskSpec {
  taskId: string;
  /** The task's private working folder (the agent can only change files here). */
  workdir: string;
  /** Engine state for this task (session log, config). */
  homeDir: string;
  /** Model route served by Aatmiq's gateway. */
  model: { key: string; name: string; contextWindow: number; vision?: boolean };
  /** Base URL of Aatmiq's internal API, reachable from the runtime. */
  controlUrl: string;
  /** Per-task secret for the gateway and control endpoints. */
  token: string;
  approvals: ApprovalMode;
  /** Ask before commands that use the network (when the sandbox can't block it). */
  askForNetwork: boolean;
  webSearch: boolean;
  /** The browser_* tools (a headless browser run by Aatmiq). */
  browser?: boolean;
  skillsDir: string | null;
  connectors: ConnectorSpec[];
  productName: string;
  /** Extra instructions placed in the system prompt (org/project). */
  instructions?: string;
  /**
   * Run the runtime as this Unix user/group (the API must run as root). Each task gets its own,
   * so tasks can't read each other's folders or the server's files.
   */
  uid?: number;
  gid?: number;
  /** "on": commands may only change the task folder (bwrap/Landlock). "off": rely on `uid` isolation alone. */
  sandbox?: "on" | "off";
  /** Container mode: this task's limits (the container launcher reads them; process mode ignores them). */
  container?: { cpus: number; memoryMb: number; pidsLimit: number; network: "proxy" | "none" };
}

export type HarnessEvent =
  | { type: "user"; id: string; text: string }
  | { type: "assistant"; id: string; text: string; toolCalls: { callId: string; name: string }[]; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; text: string; isError: boolean }
  | { type: "plan"; items: { content: string; status: string }[] }
  | { type: "title"; title: string }
  | { type: "turn_end"; reason: string; error?: string }
  | { type: "status"; status: "running" | "idle" }
  | { type: "exit"; code: number | null; error?: string };

export interface TaskRuntime {
  readonly sessionId: string;
  /** Queue a message; resolves when the runtime accepted it. */
  send(text: string): Promise<void>;
  /** Stop the runtime (there is no mid-turn cancel in the protocol, so this ends the process). */
  stop(): Promise<void>;
  readonly alive: boolean;
}

export interface HarnessEngine {
  readonly id: string;
  start(spec: TaskSpec, onEvent: (e: HarnessEvent) => void): Promise<TaskRuntime>;
}
