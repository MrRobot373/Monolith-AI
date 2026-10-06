/**
 * A minimal MCP client (streamable HTTP) for checking a connector from Admin → Connectors:
 * connect, initialize and list the tools it offers. The agent runtime has its own client.
 */

export interface McpTool {
  name: string;
  description?: string;
}

async function readRpc(res: Response, id: number): Promise<Record<string, unknown>> {
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const messages: Record<string, unknown>[] = [];
  if (type.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        messages.push(JSON.parse(line.slice(5).trim()));
      } catch {
        /* skip */
      }
    }
  } else if (text.trim()) {
    const json = JSON.parse(text);
    messages.push(...(Array.isArray(json) ? json : [json]));
  }
  const reply = messages.find((m) => m.id === id);
  if (!reply) throw new Error("The server didn't answer the request.");
  const err = reply.error as { message?: string } | undefined;
  if (err) throw new Error(err.message ?? "The server returned an error.");
  return (reply.result ?? {}) as Record<string, unknown>;
}

export async function probeMcp(url: string, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<{ serverName: string | null; tools: McpTool[] }> {
  const signal = AbortSignal.timeout(timeoutMs);
  const base = { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers };
  let session: string | null = null;
  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(url, { method: "POST", headers: { ...base, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body), signal });
    if (res.status === 401 || res.status === 403) throw new Error(`The server refused the credentials (${res.status}).`);
    if (!res.ok && res.status !== 202) throw new Error(`The server answered ${res.status}.`);
    session = res.headers.get("mcp-session-id") ?? session;
    return res;
  };
  const init = await readRpc(
    await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aatmiq", version: "1" } },
    }),
    1,
  );
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }).then((r) => r.body?.cancel());
  const list = await readRpc(await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), 2);
  const tools = ((list.tools as { name: string; description?: string }[] | undefined) ?? []).map((t) => ({ name: t.name, description: t.description?.slice(0, 300) }));
  const info = init.serverInfo as { name?: string } | undefined;
  if (session) await fetch(url, { method: "DELETE", headers: { ...base, "mcp-session-id": session }, signal }).catch(() => undefined);
  return { serverName: info?.name ?? null, tools };
}
