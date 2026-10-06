/**
 * Engine-neutral contract between Aatmiq and an agent harness. Today the engine is DeepSeek Harness;
 * keeping this boundary means the product never depends on DSH's (developer-preview) internals.
 */

export type ApprovalMode = "risky" | "always" | "never";

export interface ConnectorSpec {
  /** Tool namespace: tools appear as mcp__<name>__<tool>. */
  name: string;
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
  model: { key: string; name: string; contextWindow: number };
  /** Base URL of Aatmiq's internal API, reachable from the runtime. */
  controlUrl: string;
  /** Per-task secret for the gateway and control endpoints. */
  token: string;
  approvals: ApprovalMode;
  /** Ask before commands that use the network (when the sandbox can't block it). */
  askForNetwork: boolean;
  webSearch: boolean;
  skillsDir: string | null;
  connectors: ConnectorSpec[];
  productName: string;
  /** Extra instructions placed in the system prompt (org/project). */
  instructions?: string;
}

export type HarnessEvent =
  | { type: "user"; id: string; text: string }
  | { type: "assistant"; id: string; text: string; toolCalls: { callId: string; name: string }[]; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; text: string; isError: boolean }
  | { type: "plan"; items: { content: string; status: string }[] }
  | { type: "title"; title: string }
  | { type: "turn_end"; reason: string }
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
