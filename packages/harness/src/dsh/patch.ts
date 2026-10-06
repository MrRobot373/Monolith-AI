/**
 * Builds the Cordis patch that turns DSH's stock `sdk` profile into an Aatmiq task runtime:
 * models come from Aatmiq's gateway, approvals and web search go through Aatmiq, and anything
 * that could reach a third-party cloud or change the runtime itself is switched off.
 */
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import type { TaskSpec } from "../types";

export const PROVIDER_ID = "aatmiq";
export const PLUGIN_PATH = fileURLToPath(new URL("../../dsh-plugin/aatmiq.mjs", import.meta.url));

/** Rows from the stock profile that must not run inside a private, multi-user deployment. */
export const DISABLED_ROWS = [
  // Third-party clouds: DeepSeek accounts, models and web search.
  "deepseek-account",
  "llm-deepseek",
  "llm-deepseek-account",
  "web-search-deepseek",
  // The agent must not install or reconfigure plugins at runtime.
  "tool-plugin-manager",
  "plugin-manager",
  "config-editor",
  "settings",
  "hmr",
  // No telemetry export.
  "otel",
  "session-telemetry-otel",
  // In-process code runtimes (not covered by the shell sandbox).
  "ptc-runtime",
  "workflow-ptc",
  "tool-workflow",
  "tool-ralph",
];

export function buildPatch(spec: TaskSpec): string {
  const rows: Record<string, unknown>[] = [
    {
      id: "llm-pi-ai",
      name: "@deepseek-ai/dsh-llm-pi-ai",
      config: {
        providers: {
          [PROVIDER_ID]: {
            displayName: spec.productName,
            api: "openai-completions",
            baseURL: `${spec.controlUrl}/llm/v1`,
            apiKeyEnv: "AATMIQ_TOKEN",
            retryPolicy: { mode: "normal", maxRetries: 2 },
            models: [{ id: spec.model.key, name: spec.model.name, contextWindow: spec.model.contextWindow }],
          },
        },
      },
    },
    { id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model", config: { provider: PROVIDER_ID, model: spec.model.key } },
    {
      id: "system-prompt",
      name: "@deepseek-ai/dsh-system-prompt",
      config: {
        personaPrefix: [
          `You are ${spec.productName}, a private AI assistant that carries out tasks for people in their organization.`,
          "You work inside a private folder on the organization's own servers: you can run commands, read and write files there, and use the tools you are given.",
          "Explain what you are doing in plain language. When you produce a document, report or data file, save it in the working folder so the person can download it.",
          spec.instructions ? `\nOrganization instructions:\n${spec.instructions}` : "",
        ]
          .filter(Boolean)
          .join(" "),
        personaSuffix: "Your working folder is {{cwd}}.",
      },
    },
    { id: "web", name: "@deepseek-ai/dsh-web", config: { searchProvider: PROVIDER_ID, fetchProvider: "http" } },
    {
      id: "skill-filesystem",
      name: "@deepseek-ai/dsh-skill-filesystem",
      config: { includeDefaultRoots: false, customSkillDirs: spec.skillsDir ? [spec.skillsDir] : [], watch: false },
    },
    ...DISABLED_ROWS.map((id) => ({ id, disabled: true })),
  ];

  const inserts: Record<string, unknown>[] = [
    {
      id: "aatmiq",
      name: PLUGIN_PATH,
      config: {
        controlUrl: spec.controlUrl,
        taskId: spec.taskId,
        approvals: spec.approvals,
        askForNetwork: spec.askForNetwork,
        webSearch: spec.webSearch,
        connectors: spec.connectors.map((c) => ({ name: c.name, approveTools: c.approveTools })),
      },
    },
    ...spec.connectors.map((c) => ({
      id: `mcp-${c.name}`,
      name: "@deepseek-ai/dsh-mcp-client",
      config: { serverName: c.name, transport: "streamable-http", url: c.url, ...(c.headers && Object.keys(c.headers).length ? { headers: c.headers } : {}) },
    })),
  ];
  rows.push({ insert: inserts });
  return stringify(rows, { lineWidth: 0 });
}
