// Deterministic outside world for the model matrix: a SearXNG-style search, an intranet page and a
// small CRM exposed as an MCP server (streamable HTTP, JSON responses).
import { createServer } from "node:http";

const PORT = Number(process.env.FIXTURES_PORT ?? 11600);

const SEARCH = [
  {
    match: /zephyr|northwind|e-?bike/i,
    results: [
      {
        url: "https://news.example.com/northwind-zephyr-x2-launch",
        title: "Northwind announces the Zephyr X2 e-bike",
        content: "Northwind Cycles will launch the Zephyr X2 e-bike on 14 March 2027. It will cost $2,450 in the US.",
      },
      {
        url: "https://reviews.example.org/zephyr-x2-first-ride",
        title: "Zephyr X2 first ride: light and quick",
        content: "The Zephyr X2 weighs 17 kg and has a range of 120 km per charge with its 540 Wh battery.",
      },
    ],
  },
];

const PAGE = `<!doctype html><html><head><title>Expense policy</title></head><body>
<h1>Travel and expense policy</h1>
<p>Policy code: <strong>EXP-2026-B</strong>. Applies from 1 January 2026.</p>
<ul><li>Meals are reimbursed up to <strong>$45 per day</strong>.</li>
<li>Hotels are reimbursed up to $180 per night.</li>
<li>Economy class for flights under 6 hours.</li></ul>
</body></html>`;

const CUSTOMERS = {
  "acme corp": {
    id: "C-1042",
    name: "Acme Corp",
    plan: "Pro",
    contact: "ops@acme.example",
    balance_due: "$1,250.00",
    invoices: [
      { number: "INV-2026-0311", amount: "$750.00", due: "2026-09-15", status: "overdue" },
      { number: "INV-2026-0342", amount: "$500.00", due: "2026-10-01", status: "open" },
    ],
  },
};
let ticketSeq = 5000;

const TOOLS = [
  {
    name: "lookup_customer",
    description: "Find a customer by name. Returns their id, plan, contact email and balance due.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Customer name" } }, required: ["name"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_open_invoices",
    description: "List a customer's unpaid invoices.",
    inputSchema: { type: "object", properties: { customer_id: { type: "string" } }, required: ["customer_id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_ticket",
    description: "Open a support ticket for a customer.",
    inputSchema: {
      type: "object",
      properties: { customer_id: { type: "string" }, subject: { type: "string" }, priority: { type: "string", enum: ["low", "normal", "high"] } },
      required: ["customer_id", "subject"],
    },
  },
];

function callTool(name, args = {}) {
  const text = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });
  const fail = (m) => ({ isError: true, content: [{ type: "text", text: m }] });
  if (name === "lookup_customer") {
    const c = CUSTOMERS[String(args.name ?? "").toLowerCase().replace(/[.,]/g, "").trim()] ?? Object.values(CUSTOMERS).find((x) => x.name.toLowerCase().includes(String(args.name ?? "").toLowerCase().split(" ")[0]));
    if (!c) return fail(`No customer named "${args.name}".`);
    const { invoices, ...rest } = c;
    return text({ ...rest, open_invoices: invoices.length });
  }
  if (name === "list_open_invoices") {
    const c = Object.values(CUSTOMERS).find((x) => x.id === args.customer_id);
    return c ? text(c.invoices) : fail(`Unknown customer id "${args.customer_id}". Look the customer up first.`);
  }
  if (name === "create_ticket") {
    const c = Object.values(CUSTOMERS).find((x) => x.id === args.customer_id || x.name.toLowerCase() === String(args.customer_id ?? "").toLowerCase());
    if (!c) return fail(`Unknown customer id "${args.customer_id}". Look the customer up first.`);
    ticketSeq += 1;
    return text(`Ticket T-${ticketSeq} created for ${c.name} (priority ${args.priority ?? "normal"}): ${args.subject}`);
  }
  return fail(`Unknown tool ${name}`);
}

async function mcp(req, res) {
  if (req.method === "DELETE") return res.writeHead(200).end();
  if (req.method !== "POST") return res.writeHead(405).end();
  let body = "";
  for await (const c of req) body += c;
  const msg = JSON.parse(body);
  if (msg.id === undefined) return res.writeHead(202).end();
  const reply = (result) => {
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "crm-session" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  };
  if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "crm", version: "1.0" } });
  if (msg.method === "tools/list") return reply({ tools: TOOLS });
  if (msg.method === "tools/call") return reply(callTool(msg.params.name, msg.params.arguments));
  return reply({});
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/searx/search") {
    const q = url.searchParams.get("q") ?? "";
    const hit = SEARCH.find((s) => s.match.test(q));
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ results: hit?.results ?? [{ url: "https://example.org/nothing", title: "No relevant results", content: `Nothing found for ${q}.` }] }));
  }
  if (url.pathname === "/docs/policy.html") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  if (url.pathname === "/mcp") return mcp(req, res);
  res.writeHead(404).end("not found");
}).listen(PORT, () => console.log(`fixtures on ${PORT}`));
