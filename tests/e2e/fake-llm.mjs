// Fake model server: speaks Ollama (/api/tags) and OpenAI-compatible (/v1/*) with streaming + usage.
import { createServer } from "node:http";
const MODELS = ["qwen3:8b", "deepseek-v4:32b", "gemma3:12b"];
createServer(async (req, res) => {
  if (req.url === "/api/tags") return res.end(JSON.stringify({ models: MODELS.map((name) => ({ name })) }));
  if (req.url === "/v1/models") return res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
  if (req.url === "/v1/embeddings") {
    let body = ""; for await (const c of req) body += c;
    const { input } = JSON.parse(body);
    const vec = (t) => { const v = new Array(64).fill(0); for (const w of t.toLowerCase().split(/\W+/)) if (w) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 64] += 1; const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
    return res.end(JSON.stringify({ data: [].concat(input).map((t, index) => ({ index, embedding: vec(t) })), usage: { prompt_tokens: 10 } }));
  }
  if (req.url === "/v1/chat/completions") {
    let body = ""; for await (const c of req) body += c;
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
      await new Promise((r) => setTimeout(r, slow ? 60 : 8));
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
      await new Promise((r) => setTimeout(r, 5));
    }
    finish("stop");
  };
  if (last.role === "tool") {
    const out = textOf(last.content).replace(/\s+/g, " ").trim().slice(0, 300);
    return say(`Done. The tool returned: ${out}`);
  }
  // Only the latest real user request matters (runtime context messages are skipped).
  const user = [...msgs].reverse().find((m) => m.role === "user" && !/^Current runtime context/.test(textOf(m.content)));
  const ask = textOf(user?.content ?? "");
  let call = null;
  let m;
  if ((m = /run: (.+)/s.exec(ask)) && has("bash")) call = ["bash", { description: "Run the requested command", command: m[1].trim() }];
  else if ((m = /write (\S+): (.+)/s.exec(ask)) && has("write")) call = ["write", { file_path: m[1], content: m[2].trim() }];
  else if ((m = /search: (.+)/.exec(ask)) && has("web_search")) call = ["web_search", { queries: [m[1].trim()] }];
  else if ((m = /fetch: (\S+)/.exec(ask)) && has("web_fetch")) call = ["web_fetch", { url: m[1] }];
  else if ((m = /use (\w+) (\{.*\})/s.exec(ask)) && has(m[1])) call = [m[1], JSON.parse(m[2])];
  if (!call) return say(`**${j.model}** (agent) here. You asked: "${ask.slice(0, 200)}". I can run commands, write files and search the web.`);
  const args = JSON.stringify(call[1]);
  send({ choices: [{ index: 0, delta: { content: `I'll use ${call[0]}.` } }] });
  send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: call[0], arguments: "" } }] } }] });
  for (let i = 0; i < args.length; i += 20) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 20) } }] } }] });
  finish("tool_calls");
}
