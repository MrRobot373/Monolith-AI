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
}).listen(11500, () => console.log("fake llm on 11500"));
