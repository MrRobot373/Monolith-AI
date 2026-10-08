// Fake model server: speaks Ollama (/api/tags) and OpenAI-compatible (/v1/*) with streaming + usage.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
const MODELS = ["qwen3:8b", "deepseek-v4:32b", "gemma3:12b"];
// A GPU's pace for load tests: FAKE_LLM_FIRST_MS before the first word, FAKE_LLM_WORD_MS per word.
const FIRST_MS = Number(process.env.FAKE_LLM_FIRST_MS ?? 0);
const WORD_MS = process.env.FAKE_LLM_WORD_MS ? Number(process.env.FAKE_LLM_WORD_MS) : null;
const stats = { requests: 0, inflight: 0, maxInflight: 0 };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
createServer(async (req, res) => {
  // How busy the "model" is (load tests read and reset it).
  if (req.url === "/stats") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(stats));
  }
  if (req.url === "/stats/reset") {
    Object.assign(stats, { requests: 0, maxInflight: stats.inflight });
    return res.end("{}");
  }
  if (req.url === "/v1/chat/completions") {
    stats.requests++;
    stats.inflight++;
    stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
    res.on("close", () => stats.inflight--);
    if (FIRST_MS) await pause(FIRST_MS);
  }
  if (req.url === "/api/tags") return res.end(JSON.stringify({ models: MODELS.map((name) => ({ name })) }));
  if (req.url === "/v1/models") return res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
  if (req.url === "/v1/embeddings") {
    let body = ""; for await (const c of req) body += c;
    const { input } = JSON.parse(body);
    const vec = (t) => { const v = new Array(64).fill(0); for (const w of t.toLowerCase().split(/\W+/)) if (w) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 64] += 1; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
    return res.end(JSON.stringify({ data: [].concat(input).map((t, index) => ({ index, embedding: vec(t) })), usage: { prompt_tokens: 10 } }));
  }
  if (req.url?.startsWith("/searx/search")) {
    res.setHeader("content-type", "application/json");
    const q = new URL(req.url, "http://x").searchParams.get("q") ?? "";
    return res.end(JSON.stringify({ results: [
      { url: "https://intranet.example/travel-policy", title: "Travel policy 2026", content: `Economy class for flights under 6 hours (${q}).` },
      { url: "https://example.org/guide", title: "A public guide", content: "Background reading." },
    ] }));
  }
  if (req.url === "/mcp") return fakeMcp(req, res);
  // A sign-up page for the browser tool.
  if (req.url === "/signup" || req.url?.startsWith("/signup?")) {
    const q = new URL(req.url, "http://x").searchParams.get("name");
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(q ? `<title>Done</title><h1>Welcome, ${q.replace(/[<>&]/g, "")}!</h1>` : `<title>Sign up</title><h1>Join the newsletter</h1><form action="/signup"><label>Name <input name="name"></label><button>Sign up</button></form>`);
  }
  if (req.url?.startsWith("/oauth") || req.url?.startsWith("/.well-known/oauth")) return fakeOAuthMcp(req, res);
  if (req.url === "/v1/chat/completions") {
    let body = ""; for await (const c of req) body += c;
    // Keys named "exhausted-…" behave like a key past its usage limit (for key rotation tests).
    if (/^Bearer exhausted-/.test(req.headers.authorization ?? "")) {
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "you've reached your weekly usage limit" }));
    }
    const j = JSON.parse(body);
    if (Array.isArray(j.tools) && j.tools.length) return agentReply(j, res);
    const last = j.messages.at(-1).content;
    const slow = last.includes("slow");
    const sys = j.messages.find((m) => m.role === "system")?.content ?? "";
    const src = /<sources>\n\[1\] ([^\n]+)\n([^\n]+)/.exec(sys);
    const instr = /personal ones\):\n([^\n]+)/.exec(sys);
    const pre = instr ? `Following the project instructions ("${instr[1].slice(0, 60)}"). ` : "";
    const text = pre + (src
      ? `From **${src[1]}**: ${src[2].slice(0, 120)} [1]`
      : slow
      ? Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ")
      : `**${j.model}** here. You asked: "${last}". Here is a list:\n\n- one\n- two\n\n\`\`\`python\nprint("hello")\n\`\`\``);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const w of text.match(/\S+\s*/g)) {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      await pause(WORD_MS ?? (slow ? 60 : 8));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 25 } })}\n\n`);
    return res.end("data: [DONE]\n\n");
  }
  res.statusCode = 404; res.end();
}).listen(Number(process.env.FAKE_LLM_PORT ?? 11500), () => console.log("fake llm on 11500"));

/**
 * Agent mode (the request offers tools). Scripted by the latest user message:
 *   "run: <command>"            → bash tool call
 *   "write <path>: <content>"   → write tool call
 *   "search: <query>"           → web_search tool call
 *   "fetch: <url>"              → web_fetch tool call
 *   "use <tool> <json args>"    → any tool call
 * After a tool result arrives it answers with a short summary that quotes the result.
 */
function textOf(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p.text ?? ""))).join("");
  return "";
}
async function agentReply(j, res) {
  const msgs = j.messages;
  const last = msgs.at(-1);
  const has = (n) => j.tools.some((t) => (t.function?.name ?? t.name) === n);
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const finish = (reason) => {
    send({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
    send({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } });
    res.end("data: [DONE]\n\n");
  };
  const say = async (text) => {
    for (const w of text.match(/\S+\s*/g) ?? [text]) {
      send({ choices: [{ index: 0, delta: { content: w } }] });
      await pause(WORD_MS ?? 5);
    }
    finish("stop");
  };
  // Only the latest real user request matters (runtime context and reminders are skipped;
  // a restarted task's earlier conversation is ignored).
  const clean = (m) => textOf(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  const askIdx = msgs.findLastIndex((m) => m.role === "user" && clean(m) && !/^Current runtime context/.test(clean(m)));
  const ask = askIdx >= 0 ? clean(msgs[askIdx]).split("</earlier-conversation>").at(-1).trim() : "";
  const toolsSoFar = msgs.slice(askIdx + 1).filter((m) => m.role === "tool").length;
  let m0;
  const callTool = (name, args, preface) => {
    const a = JSON.stringify(args);
    if (preface) send({ choices: [{ index: 0, delta: { content: preface } }] });
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}_${toolsSoFar}`, type: "function", function: { name, arguments: "" } }] } }] });
    for (let i = 0; i < a.length; i += 20) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(i, i + 20) } }] } }] });
    finish("tool_calls");
  };
  // "demo: …" walks through a small multi-step job: a plan, a command, a file, then an answer.
  if (/^demo:/.test(ask)) {
    const plan = (done) => ({ todos: ["Collect the sales numbers", "Write the report", "Summarize the result"].map((content, i) => ({ content, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })) });
    const script = [
      () => callTool("todo_write", plan(0), "Let me plan this."),
      () => callTool("bash", { description: "Create the data", command: "printf 'region,sales\\nNorth,120\\nSouth,95\\n' > sales.csv && cat sales.csv" }),
      () => callTool("todo_write", plan(1)),
      () => callTool("write", { file_path: "report.md", content: "# Sales report\n\n| Region | Sales |\n|---|---|\n| North | 120 |\n| South | 95 |\n\nNorth leads by 25.\n" }),
      () => callTool("todo_write", plan(3)),
    ];
    if (toolsSoFar < script.length) return script[toolsSoFar]();
    return say("I created **sales.csv** and **report.md**. North leads South by 25 (120 vs 95). Open the Files panel to download the report.");
  }
  // "browse: URL" fills in the page's Name field and submits it (the submission needs approval),
  // then takes a screenshot. Element numbers come from the page view, as a real model would read them.
  if ((m0 = /^browse: (\S+)/.exec(ask)) && has("browser_open")) {
    const lastTool = textOf(last.content);
    const name = Number(/\[(\d+)\] textbox "Name"/.exec(msgs.slice(askIdx).filter((x) => x.role === "tool").map((x) => textOf(x.content)).join("\n"))?.[1] ?? 1);
    const script = [
      () => callTool("browser_open", { url: m0[1] }, "Let me open the page."),
      () => (/textbox "Name"/.test(lastTool) ? callTool("browser_type", { element: name, text: "Ada Lovelace", submit: true }) : say(`I couldn't use the page: ${lastTool.slice(0, 300)}`)),
      () => callTool("browser_type", { element: name, text: "Ada Lovelace", submit: true, confirm_submit: true }, "That submits the sign-up form; asking first."),
      () => callTool("browser_screenshot", {}),
    ];
    if (toolsSoFar < script.length) return script[toolsSoFar]();
    const page = msgs.slice(askIdx).filter((x) => x.role === "tool").map((x) => textOf(x.content)).find((t) => t.includes("Welcome")) ?? "";
    return say(`Signed up. The page says: ${/Welcome[^\n]*/.exec(page)?.[0] ?? "(no confirmation)"}. ${lastTool.trim()}`);
  }
  if (last.role === "tool") {
    const out = textOf(last.content).replace(/\s+/g, " ").trim().slice(0, 300);
    return say(`Done. The tool returned: ${out}`);
  }
  let call = null;
  let m;
  if ((m = /run: (.+?)(?:\n\n|$)/s.exec(ask)) && has("bash")) call = ["bash", { description: "Run the requested command", command: m[1].trim() }];
  else if ((m = /write (\S+): (.+)/s.exec(ask)) && has("write")) call = ["write", { file_path: m[1], content: m[2].trim() }];
  else if ((m = /search: (.+)/.exec(ask)) && has("web_search")) call = ["web_search", { queries: [m[1].trim()] }];
  else if ((m = /fetch: (\S+)/.exec(ask)) && has("web_fetch")) call = ["web_fetch", { url: m[1] }];
  else if ((m = /use (\S+) (\{.*\})/s.exec(ask)) && has(m[1])) call = [m[1], JSON.parse(m[2])];
  if (!call) return say(`**${j.model}** (agent) here. You asked: "${ask.slice(0, 200)}". I can run commands, write files and search the web.`);
  const args = JSON.stringify(call[1]);
  send({ choices: [{ index: 0, delta: { content: `I'll use ${call[0]}.` } }] });
  send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: call[0], arguments: "" } }] } }] });
  for (let i = 0; i < args.length; i += 20) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 20) } }] } }] });
  finish("tool_calls");
}

/** A tiny MCP server (streamable HTTP, JSON responses) with a notes tool, for connector tests. */
const notes = [];
async function fakeMcp(req, res) {
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  let body = ""; for await (const c of req) body += c;
  const msg = JSON.parse(body);
  if (msg.id === undefined) { res.statusCode = 202; return res.end(); }
  const reply = (result) => { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fake" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })); };
  if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1.0" } });
  if (msg.method === "tools/list") return reply({ tools: [
    { name: "create_note", description: "Save a note for the team", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "list_notes", description: "List saved notes", inputSchema: { type: "object", properties: {} } },
  ] });
  if (msg.method === "tools/call") {
    if (msg.params.name === "create_note") { notes.push(msg.params.arguments?.text ?? ""); return reply({ content: [{ type: "text", text: `Saved note #${notes.length}: ${msg.params.arguments?.text}` }] }); }
    return reply({ content: [{ type: "text", text: notes.length ? notes.join("\n") : "No notes yet." }] });
  }
  return reply({});
}

// An MCP server behind OAuth 2.1 (MCP authorization): discovery, dynamic registration, PKCE.
const BASE = `http://localhost:${process.env.FAKE_LLM_PORT ?? 11500}`;
const oauth = { challenge: "" };
async function fakeOAuthMcp(req, res) {
  let raw = ""; for await (const c of req) raw += c;
  const json = (status, obj, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, BASE);
  if (url.pathname === "/.well-known/oauth-protected-resource/oauth/mcp") return json(200, { resource: `${BASE}/oauth/mcp`, authorization_servers: [`${BASE}/oauth`] });
  if (url.pathname === "/.well-known/oauth-authorization-server/oauth")
    return json(200, { issuer: `${BASE}/oauth`, authorization_endpoint: `${BASE}/oauth/authorize`, token_endpoint: `${BASE}/oauth/token`, registration_endpoint: `${BASE}/oauth/register`, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
  if (url.pathname === "/oauth/register") return json(201, { client_id: "e2e-client" });
  if (url.pathname === "/oauth/authorize") {
    oauth.challenge = url.searchParams.get("code_challenge") ?? "";
    res.writeHead(302, { location: `${url.searchParams.get("redirect_uri")}?code=e2e-code&state=${url.searchParams.get("state")}` });
    return res.end();
  }
  if (url.pathname === "/oauth/token") {
    const f = Object.fromEntries(new URLSearchParams(raw));
    if (f.grant_type === "authorization_code" && createHash("sha256").update(f.code_verifier ?? "").digest("base64url") === oauth.challenge)
      return json(200, { access_token: "mail-token-1", refresh_token: "mail-refresh", expires_in: 3600, token_type: "Bearer", email: "asha@acme.test" });
    if (f.grant_type === "refresh_token") return json(200, { access_token: "mail-token-2", expires_in: 3600, token_type: "Bearer" });
    return json(400, { error: "invalid_grant" });
  }
  if (url.pathname === "/oauth/mcp") {
    const token = /^Bearer (mail-token-\d)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) return json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/oauth/mcp"` });
    if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
    const msg = JSON.parse(raw);
    if (msg.id === undefined) { res.statusCode = 202; return res.end(); }
    const reply = (result) => json(200, { jsonrpc: "2.0", id: msg.id, result }, { "mcp-session-id": "mail" });
    if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mail", version: "1.0" } });
    if (msg.method === "tools/list") return reply({ tools: [{ name: "get_inbox", description: "Latest emails", inputSchema: { type: "object", properties: {} } }] });
    if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: `3 unread emails for asha@acme.test (via ${token})` }] });
    return reply({});
  }
  res.writeHead(404); res.end();
}
