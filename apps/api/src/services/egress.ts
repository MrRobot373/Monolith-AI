/**
 * The browser's only way out: an HTTP proxy (CONNECT for HTTPS, absolute URLs for HTTP) that
 * refuses private and internal addresses, so a page the agent opens can't reach the database, the
 * cloud metadata service or anything else on the organization's network, unless an admin lists
 * that host. It connects to exactly the address it checked (no DNS-rebinding gap); behind a
 * corporate proxy (HTTPS_PROXY) public sites go through that one, while internal hosts an admin
 * allowed are reached directly (a corporate proxy usually can't reach them).
 *
 * In container mode task containers use it too: they send their task token as the proxy password,
 * and a task whose admin setting gives it no internet is refused (loopback, this machine's own
 * browser, needs no token).
 */
import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";

const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) PRIVATE.addSubnet(net, bits, "ipv6");

/** True for loopback, private, link-local, CGNAT, documentation, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return PRIVATE.check(ip, "ipv4");
  if (v !== 6) return true;
  const lower = ip.toLowerCase();
  // IPv4 inside IPv6 (::ffff:10.0.0.1, 64:ff9b::a00:1): judge the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1] ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return PRIVATE.check(mapped, "ipv4");
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
    return PRIVATE.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."), "ipv4");
  }
  return PRIVATE.check(lower, "ipv6");
}

/** "intranet.acme.com" matches exactly; "*.acme.com" matches its subdomains; an IP matches itself. */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return allowed.some((a) => {
    const p = a.trim().toLowerCase();
    if (!p) return false;
    if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
    return h === p;
  });
}

export class EgressBlocked extends Error {}

export interface EgressOptions {
  /** Hosts the admin allows even though they're internal. Read on every request. */
  allowedHosts: () => string[];
  /** Corporate proxy to go through (http://host:port), or null to connect directly. */
  upstream: string | null;
  /** Resolve names (tests replace it). */
  resolve?: (host: string) => Promise<string[]>;
  /** Where to listen: 127.0.0.1 and any port by default; container mode listens for task containers. */
  host?: string;
  /** For clients other than this machine: whether the task with this token may go out. Unset: none may. */
  authorize?: (token: string) => boolean;
  port?: number;
  log?: (msg: string) => void;
}

export interface EgressProxy {
  url: string;
  /** Where to connect for a host, or EgressBlocked with the reason. */
  check(host: string): Promise<string | null>;
  /** The reason a host was refused in the last minute (to explain a failed page load). */
  recentBlock(host: string): string | null;
  /** The latest refusal, to explain a page that failed without saying where it was going. */
  lastBlock(): { host: string; reason: string; at: number } | null;
  close(): Promise<void>;
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export async function startEgressProxy(opts: EgressOptions): Promise<EgressProxy> {
  const resolve = opts.resolve ?? defaultResolve;
  const blocks = new Map<string, { reason: string; at: number }>();
  let last: { host: string; reason: string; at: number } | null = null;
  const upstream = opts.upstream ? new URL(opts.upstream) : null;

  /** The address to connect to (null: let the upstream proxy resolve it). Throws EgressBlocked. */
  async function check(rawHost: string): Promise<string | null> {
    const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
    const allowed = hostAllowed(host, opts.allowedHosts());
    if (isIP(host)) {
      if (!allowed && isPrivateAddress(host)) throw new EgressBlocked(`${host} is a private or internal address`);
      return host;
    }
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
      if (!allowed) throw new EgressBlocked(`${host} is an internal name`);
    }
    let addrs: string[];
    try {
      addrs = await resolve(host);
    } catch {
      // Behind a corporate proxy local DNS may not know public names: that proxy resolves them.
      if (upstream) return null;
      throw new EgressBlocked(`${host} couldn't be found`);
    }
    if (!addrs.length) throw new EgressBlocked(`${host} couldn't be found`);
    // Every answer must be public: one private record is enough to refuse (no mixed-answer tricks).
    if (!allowed && addrs.some(isPrivateAddress)) throw new EgressBlocked(`${host} points to a private or internal address`);
    return addrs[0]!;
  }

  const refuse = (host: string, e: unknown) => {
    const reason = e instanceof EgressBlocked ? e.message : "it couldn't be reached";
    blocks.set(host.toLowerCase(), { reason, at: Date.now() });
    last = { host: host.toLowerCase(), reason, at: Date.now() };
    if (blocks.size > 1000) blocks.clear();
    opts.log?.(`browser: refused ${host}: ${reason}`);
    return reason;
  };

  function tunnelVia(host: string, port: number, onSocket: (s: Socket) => void, onError: (e: Error) => void) {
    const s = connect(Number(upstream!.port || 80), upstream!.hostname);
    let buf = "";
    const auth = upstream!.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(upstream!.username)}:${decodeURIComponent(upstream!.password)}`).toString("base64")}\r\n` : "";
    s.once("connect", () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`));
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      if (!/^HTTP\/1\.[01] 200/.test(buf)) return onError(new Error(`upstream proxy said ${buf.split("\r\n")[0]}`));
      const rest = Buffer.from(buf.slice(end + 4), "latin1");
      if (rest.length) s.unshift(rest);
      onSocket(s);
    };
    s.on("data", onData);
    s.on("error", onError);
  }

  /** Null when the client may use the proxy; otherwise the status to refuse it with. */
  function denied(req: IncomingMessage): "407 Proxy Authentication Required" | "403 Forbidden" | null {
    const ip = req.socket.remoteAddress ?? "";
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return null;
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers["proxy-authorization"] ?? "")?.[1];
    const token = basic ? Buffer.from(basic, "base64").toString().split(":").slice(1).join(":") : "";
    if (!token) return "407 Proxy Authentication Required";
    return opts.authorize?.(token) ? null : "403 Forbidden";
  }
  const NO_TOKEN = "Proxy-Authenticate: Basic realm=\"aatmiq\"\r\n";
  const NO_INTERNET = encodeURIComponent("this task has no internet access");

  async function onConnect(req: IncomingMessage, client: Duplex, head: Buffer) {
    client.on("error", () => undefined);
    const no = denied(req);
    if (no) return client.end(`HTTP/1.1 ${no}\r\n${no.startsWith("407") ? NO_TOKEN : `X-Aatmiq-Blocked: ${NO_INTERNET}\r\n`}Content-Length: 0\r\n\r\n`);
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? "");
    if (!m) return client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    const [, host, portStr] = m;
    const port = Number(portStr);
    let address: string | null;
    try {
      address = await check(host!);
    } catch (e) {
      return client.end(`HTTP/1.1 403 Forbidden\r\nX-Aatmiq-Blocked: ${encodeURIComponent(refuse(host!, e))}\r\nContent-Length: 0\r\n\r\n`);
    }
    const ready = (s: Socket) => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) s.write(head);
      s.pipe(client).pipe(s);
      s.on("error", () => client.destroy());
      client.on("close", () => s.destroy());
    };
    const fail = () => client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    if (upstream && !(address && isPrivateAddress(address))) tunnelVia(host!, port, ready, fail);
    else {
      const s = connect(port, address!, () => ready(s));
      s.on("error", fail);
    }
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    const no = denied(req);
    if (no) {
      res.writeHead(Number(no.slice(0, 3)), no.startsWith("407") ? { "proxy-authenticate": 'Basic realm="aatmiq"' } : { "x-aatmiq-blocked": NO_INTERNET }).end();
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? "");
      if (target.protocol !== "http:") throw new Error();
    } catch {
      res.writeHead(400).end();
      return;
    }
    let address: string | null;
    try {
      address = await check(target.hostname);
    } catch (e) {
      const reason = refuse(target.hostname, e);
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "x-aatmiq-blocked": encodeURIComponent(reason) }).end(`Blocked: ${reason}.`);
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const up = upstream && !(address && isPrivateAddress(address))
      ? httpRequest({ host: upstream.hostname, port: Number(upstream.port || 80), method: req.method, path: target.href, headers })
      : httpRequest({ host: address!, port: Number(target.port || 80), method: req.method, path: target.pathname + target.search, headers: { ...headers, host: target.host } });
    up.on("response", (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  }

  const server: Server = createServer((req, res) => void onRequest(req, res));
  server.on("connect", (req, socket, head) => void onConnect(req, socket, head));
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    check,
    recentBlock(host) {
      const b = blocks.get(host.toLowerCase());
      return b && Date.now() - b.at < 60_000 ? b.reason : null;
    },
    lastBlock: () => last,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
