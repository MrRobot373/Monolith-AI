/**
 * Checks every connector in the catalog against the real service, with Aatmiq's own code:
 *  - open servers (auth "none"): connect, list tools and call one read-only tool;
 *  - OAuth servers: the discovery Aatmiq runs when an admin adds the connector (protected-resource
 *    and authorization-server metadata), and whether Aatmiq can get a client (registration
 *    endpoint or client metadata documents for "dynamic"; the expected identity provider for "admin");
 *  - token servers: that they refuse a request without a token.
 * It never registers clients or signs in, so nothing is created at the services.
 *
 * Usage (from apps/api, so imports resolve):
 *   NODE_USE_ENV_PROXY=1 npx tsx ../../tests/connectors/check.mts [--md out.md] [--json out.json]
 */
import { writeFileSync } from "node:fs";
import { CONNECTOR_CATALOG, type CatalogConnector } from "../../packages/shared/src/connectors";
import { discoverOAuth } from "../../apps/api/src/services/connectors";
import { probeMcp } from "../../apps/api/src/services/mcp";

/** One read-only call per open server, to prove tools really run. */
const SAMPLE_CALLS: Record<string, { tool: string; args: Record<string, unknown> }> = {
  deepwiki: { tool: "read_wiki_structure", args: { repoName: "facebook/react" } },
  "microsoft-learn": { tool: "microsoft_docs_search", args: { query: "Entra ID app registration redirect URI" } },
  "aws-knowledge": { tool: "aws___search_documentation", args: { search_phrase: "S3 bucket versioning", limit: 2 } },
  huggingface: { tool: "hub_repo_search", args: { query: "whisper", limit: 2 } },
};

/** Where the admin's OAuth app lives for "admin" entries. */
const EXPECTED_IDP: Record<string, RegExp> = {
  gmail: /accounts\.google\.com/,
  "google-calendar": /accounts\.google\.com/,
  "google-drive": /accounts\.google\.com/,
  "google-docs": /accounts\.google\.com/,
  "google-sheets": /accounts\.google\.com/,
  "google-slides": /accounts\.google\.com/,
  box: /box\.com/,
  slack: /slack\.com/,
  zoom: /zoom\.us/,
  asana: /asana\.com/,
  hubspot: /hubspot\.com/,
  github: /github\.com/,
};

interface Row {
  id: string;
  name: string;
  auth: string;
  client?: string;
  ok: boolean;
  detail: string;
  ms: number;
}

async function callTool(url: string, tool: string, args: Record<string, unknown>) {
  const base = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const signal = AbortSignal.timeout(30_000);
  const init = await fetch(url, {
    method: "POST",
    headers: base,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aatmiq", version: "1" } } }),
    signal,
  });
  const session = init.headers.get("mcp-session-id");
  await init.text();
  const h = { ...base, ...(session ? { "mcp-session-id": session } : {}) };
  await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal }).then((r) => r.text());
  const r = await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }), signal });
  const text = await r.text();
  const line = text.split("\n").find((l) => l.startsWith("data:") && l.includes('"id":2')) ?? text;
  const msg = JSON.parse(line.replace(/^data:\s*/, ""));
  if (msg.error) throw new Error(msg.error.message);
  if (msg.result?.isError) throw new Error(JSON.stringify(msg.result.content).slice(0, 200));
  const out = (msg.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join(" ");
  return out.replace(/\s+/g, " ").trim();
}

async function check(c: CatalogConnector): Promise<Row> {
  const t0 = Date.now();
  const row = { id: c.id, name: c.name, auth: c.auth, client: c.client };
  try {
    if (c.auth === "none") {
      const p = await probeMcp(c.url, {}, 20_000);
      const sample = SAMPLE_CALLS[c.id];
      let called = "";
      if (sample) {
        if (!p.tools.some((t) => t.name === sample.tool)) throw new Error(`${p.tools.length} tools, but no ${sample.tool} (has ${p.tools.map((t) => t.name).slice(0, 6).join(", ")})`);
        const out = await callTool(c.url, sample.tool, sample.args);
        if (!out) throw new Error(`${sample.tool} returned nothing`);
        called = `; ${sample.tool} answered (${out.length} chars)`;
      }
      return { ...row, ok: true, detail: `${p.tools.length} tools${called}`, ms: Date.now() - t0 };
    }
    if (c.auth === "token") {
      try {
        await probeMcp(c.url, {}, 20_000);
        return { ...row, ok: false, detail: "answered without a token", ms: Date.now() - t0 };
      } catch (e) {
        const m = (e as Error).message;
        const refused = /refused the credentials/.test(m);
        return { ...row, ok: refused, detail: refused ? "asks for a token (401) as expected" : m, ms: Date.now() - t0 };
      }
    }
    const d = await discoverOAuth(c.url);
    const as = new URL(d.authorizationEndpoint).host;
    if (c.client === "admin") {
      const want = EXPECTED_IDP[c.id];
      const ok = !want || want.test(d.authorizationEndpoint);
      return { ...row, ok, detail: `${ok ? "" : "unexpected sign-in server: "}sign-in at ${as}; admin brings an OAuth app`, ms: Date.now() - t0 };
    }
    const how = d.registrationEndpoint ? "registers itself (DCR)" : d.metadataDocuments ? "client metadata document" : null;
    return { ...row, ok: !!how, detail: how ? `sign-in at ${as}; ${how}` : `sign-in at ${as}, but no way to get a client automatically`, ms: Date.now() - t0 };
  } catch (e) {
    return { ...row, ok: false, detail: (e as Error).message.slice(0, 160), ms: Date.now() - t0 };
  }
}

const rows: Row[] = [];
const queue = [...CONNECTOR_CATALOG];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) rows.push(await check(c));
  }),
);
rows.sort((a, b) => CONNECTOR_CATALOG.findIndex((c) => c.id === a.id) - CONNECTOR_CATALOG.findIndex((c) => c.id === b.id));
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id.padEnd(18)} ${`${r.auth}${r.client ? `/${r.client}` : ""}`.padEnd(14)} ${String(r.ms).padStart(5)}ms  ${r.detail}`);
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} passed`);
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const json = arg("--json");
if (json) writeFileSync(json, JSON.stringify({ checkedAt: new Date().toISOString(), rows }, null, 1));
process.exit(rows.every((r) => r.ok) ? 0 : 1);
