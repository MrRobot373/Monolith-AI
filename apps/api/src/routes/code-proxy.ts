/**
 * /code/ide/* → the signed-in person's own IDE server (HTTP and WebSocket).
 *
 * It sits in front of Fastify (raw Node handlers) so request bodies and upgrades pass through
 * untouched. Every request is checked against the Aatmiq session; Aatmiq's cookies are removed
 * before forwarding, so nothing running inside the IDE (extensions, terminals) can pick them up.
 *
 * With IDE_URL the IDE lives on its own host and nowhere else:
 *  - opening a workspace returns a one-time ticket (2 minutes) on the IDE host; the IDE host trades
 *    it for its own cookie, tied to the Aatmiq session that asked (signing out ends both);
 *  - the IDE host serves only the IDE: Aatmiq's pages and API answer 404 there, and the browser
 *    never holds an Aatmiq session for it, so an extension can't act on Aatmiq as the person.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { request } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { FastifyRequest } from "fastify";
import { eq, session as sessionTable } from "@aatmiq/db";
import { getSessionUser, userById, type AppContext, type SessionUser } from "../context";
import { randomToken, sha256 } from "../crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { HttpError } from "../errors";
import { codeDistDir, IDE_BASE_PATH } from "../services/code";
import { canUseCode } from "./code";

const SESSION_TTL_MS = 30_000;
/** The IDE host's own cookie (only with IDE_URL). Never forwarded to the IDE. */
const IDE_COOKIE = "aatmiq_ide";
const IDE_SESSION_HOURS = 12;
const TICKET_MINUTES = 2;
const HANDOFF = `${IDE_BASE_PATH}/__aatmiq/session`;
const ideTicketId = (hash: string) => `ide-ticket:${hash}`;
const ideSessionId = (hash: string) => `ide-session:${hash}`;

/** The host a request was made to (the web app's proxy passes it on as X-Forwarded-Host). */
export function requestHost(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-host"];
  const h = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim() || req.headers.host || "";
  return h.toLowerCase();
}

/**
 * The address that opens a folder in the IDE. With IDE_URL it carries a one-time ticket for the
 * IDE host, bound to the Aatmiq session that asked.
 */
export async function ideOpenUrl(ctx: AppContext, userId: string, sessionId: string, folder: string): Promise<string> {
  const next = `${IDE_BASE_PATH}/?folder=${encodeURIComponent(folder)}`;
  if (!ctx.cfg.ideUrl) return next;
  const ticket = randomToken(24);
  const actx = await ctx.auth.$context;
  await actx.internalAdapter.createVerificationValue({
    identifier: ideTicketId(sha256(ticket)),
    value: JSON.stringify({ userId, sessionId }),
    expiresAt: new Date(Date.now() + TICKET_MINUTES * 60_000),
  });
  return `${ctx.cfg.ideUrl}${HANDOFF}?ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(next)}`;
}

/** The IDE's own shipped files (/code/ide/<quality>-<commit>/static/…): public code, served directly. */
const STATIC = new RegExp(`^${IDE_BASE_PATH}/[a-z]+-[0-9a-f]{40}/static/((?:out|resources|extensions|node_modules)/[^?#]*)`);
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm",
  ".map": "application/json", ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(url: string, res: ServerResponse): Promise<boolean> {
  const m = STATIC.exec(url);
  if (!m) return false;
  const root = codeDistDir();
  const rel = normalize(decodeURIComponent(m[1]!));
  const file = join(root, rel);
  if (!file.startsWith(root + sep) || rel.includes("..")) {
    res.writeHead(404).end();
    return true;
  }
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) {
    res.writeHead(404).end();
    return true;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": String(st.size),
    // The commit is in the path, so these never change.
    "cache-control": "public, max-age=31536000, immutable",
    // Webview frames (and their service worker) load from here.
    ...(rel.includes("contrib/webview/browser/pre/") ? { "service-worker-allowed": "/" } : {}),
  });
  createReadStream(file).pipe(res);
  return true;
}

/** Only the IDE's own cookies go through. */
function ideCookies(cookie: string | undefined) {
  if (!cookie) return undefined;
  const kept = cookie
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.startsWith("vscode"));
  return kept.length ? kept.join("; ") : undefined;
}

export function createCodeProxy(ctx: AppContext) {
  // Static assets come in bursts of hundreds; remember sessions briefly.
  const cache = new Map<string, { user: SessionUser | null; allowed: boolean; at: number }>();

  const ideHost = ctx.cfg.ideUrl ? new URL(ctx.cfg.ideUrl).host.toLowerCase() : null;
  const onIdeHost = (req: IncomingMessage) => !!ideHost && requestHost(req) === ideHost;
  const cookieValue = (req: IncomingMessage, name: string) => new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? "")?.[1] ?? "";

  /** The person behind an IDE-host cookie, while the Aatmiq session it came from is still valid. */
  async function ideHostUser(token: string): Promise<SessionUser | null> {
    const actx = await ctx.auth.$context;
    const v = await actx.internalAdapter.findVerificationValue(ideSessionId(sha256(token)));
    if (!v || v.expiresAt < new Date()) return null;
    const { userId, sessionId } = JSON.parse(v.value) as { userId: string; sessionId: string };
    const [s] = await ctx.db.select({ userId: sessionTable.userId, expiresAt: sessionTable.expiresAt }).from(sessionTable).where(eq(sessionTable.id, sessionId));
    if (!s || s.userId !== userId || s.expiresAt < new Date()) return null;
    return userById(ctx, userId);
  }

  async function who(req: IncomingMessage): Promise<{ user: SessionUser | null; allowed: boolean }> {
    const ide = onIdeHost(req);
    const key = ide ? cookieValue(req, IDE_COOKIE) : (/(?:__Secure-)?better-auth\.session_token=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "");
    if (!key) return { user: null, allowed: false };
    const cacheKey = `${ide ? "ide" : "app"}:${key}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit;
    const found = ide ? await ideHostUser(decodeURIComponent(key)) : await getSessionUser(ctx, { headers: req.headers } as FastifyRequest);
    // Until the required two-step sign-in is set up, the person is treated as signed out here.
    const user = found?.twoFactorSetupRequired ? null : found;
    const allowed = user ? await canUseCode(ctx, user) : false;
    const entry = { user, allowed, at: Date.now() };
    cache.set(cacheKey, entry);
    if (cache.size > 5000) cache.clear();
    return entry;
  }

  function sameOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      // On the IDE host only the IDE host itself may open connections.
      if (ideHost) return o.host.toLowerCase() === ideHost;
      const app = new URL(ctx.cfg.appUrl);
      return o.host === req.headers.host || o.host === app.host;
    } catch {
      return false;
    }
  }

  /** Cookie for the IDE host. Cross-site frames need SameSite=None (so Secure, and Partitioned). */
  function ideCookie(token: string, maxAge: number) {
    const u = new URL(ctx.cfg.ideUrl!);
    const secure = u.protocol === "https:" || u.hostname === "localhost" || u.hostname.endsWith(".localhost");
    const attrs = [`${IDE_COOKIE}=${encodeURIComponent(token)}`, `Path=${IDE_BASE_PATH}`, "HttpOnly", `Max-Age=${maxAge}`];
    attrs.push(...(secure ? ["Secure", "SameSite=None", "Partitioned"] : ["SameSite=Lax"]));
    return attrs.join("; ");
  }

  /** IDE host: trade a one-time ticket from Aatmiq for the IDE host's own session. */
  async function handoff(req: IncomingMessage, res: ServerResponse) {
    const q = new URL(req.url ?? "", "http://x").searchParams;
    const ticket = q.get("ticket") ?? "";
    const next = q.get("next") ?? "";
    const actx = await ctx.auth.$context;
    const v = ticket ? await actx.internalAdapter.consumeVerificationValue(ideTicketId(sha256(ticket))) : null;
    if (!v || v.expiresAt < new Date()) return signInPage(res, "This link has expired.");
    const token = randomToken(32);
    await actx.internalAdapter.createVerificationValue({
      identifier: ideSessionId(sha256(token)),
      value: v.value,
      expiresAt: new Date(Date.now() + IDE_SESSION_HOURS * 3600_000),
    });
    // Only paths inside the IDE: never an address elsewhere.
    const safeNext = next.startsWith(`${IDE_BASE_PATH}/`) && !next.startsWith(`${HANDOFF}`) ? next : `${IDE_BASE_PATH}/`;
    res.writeHead(302, { location: safeNext, "set-cookie": ideCookie(token, IDE_SESSION_HOURS * 3600), "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end();
  }

  /** Shown on the IDE host without a session: the IDE is opened from Aatmiq. */
  function signInPage(res: ServerResponse, why = "") {
    const back = `${ctx.cfg.appUrl}/app/code`;
    res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Open from Aatmiq</title>` +
        `<body style="font:15px system-ui;background:#0c0c0c;color:#ddd;display:grid;place-items:center;min-height:100vh;margin:0">` +
        `<div style="max-width:420px;padding:24px;text-align:center"><p>${why} Open your workspace from Aatmiq → Code.</p>` +
        `<p><a style="color:#22d3ee" href="${back}">Go to Aatmiq Code</a></p></div>`,
    );
  }

  async function http(req: IncomingMessage, res: ServerResponse) {
    try {
      if ((req.method === "GET" || req.method === "HEAD") && (await serveStatic(req.url ?? "", res))) return;
      if (onIdeHost(req) && (req.url ?? "").split("?")[0] === HANDOFF) return await handoff(req, res);
      const { user, allowed } = await who(req);
      if (!user && onIdeHost(req)) {
        if ((req.headers.accept ?? "").includes("text/html")) return signInPage(res);
        res.writeHead(401, { "content-type": "text/plain" });
        return res.end("Please sign in");
      }
      if (!user) {
        const wantsPage = (req.headers.accept ?? "").includes("text/html");
        res.writeHead(wantsPage ? 302 : 401, wantsPage ? { location: "/login?next=%2Fapp%2Fcode" } : { "content-type": "text/plain" });
        return res.end(wantsPage ? undefined : "Please sign in");
      }
      if (!allowed) {
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("Code isn't enabled for you.");
      }
      const server = await ctx.code.ensure(user.id);
      ctx.code.touch(server);
      const headers = { ...req.headers, cookie: ideCookies(req.headers.cookie) };
      if (!headers.cookie) delete headers.cookie;
      const up = request({ socketPath: server.socket, method: req.method, path: req.url, headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      });
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end("The IDE isn't responding.");
      });
      req.pipe(up);
    } catch (e) {
      const status = e instanceof HttpError ? e.statusCode : 500;
      if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  // Upgraded sockets aren't tracked by the HTTP server; end them ourselves on shutdown.
  const open = new Set<Duplex>();

  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    const fail = (code: number, text: string) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    };
    try {
      if (!sameOrigin(req)) return fail(403, "Forbidden");
      const { user, allowed } = await who(req);
      if (!user) return fail(401, "Unauthorized");
      if (!allowed) return fail(403, "Forbidden");
      const server = await ctx.code.ensure(user.id);
      const up = connect(server.socket, () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i]!;
          if (k.toLowerCase() === "cookie") {
            const c = ideCookies(req.rawHeaders[i + 1]);
            if (c) lines.push(`${k}: ${c}`);
          } else lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
        }
        up.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length) up.write(head);
        socket.pipe(up).pipe(socket);
      });
      server.connections++;
      let closed = false;
      const done = () => {
        if (closed) return;
        closed = true;
        server.connections--;
        ctx.code.touch(server);
        socket.destroy();
        up.destroy();
      };
      up.on("error", done);
      up.on("close", done);
      socket.on("error", done);
      socket.on("close", done);
    } catch {
      fail(502, "Bad Gateway");
    }
  }

  const isIdePath = (url: string | undefined) => !!url && (url === IDE_BASE_PATH || url.startsWith(`${IDE_BASE_PATH}/`) || url.startsWith(`${IDE_BASE_PATH}?`));

  /**
   * Who answers a request: the IDE proxy, Aatmiq (Fastify), or nobody. With IDE_URL, the IDE host
   * serves only the IDE (and a health check), and the app host no longer serves the IDE.
   */
  function route(req: IncomingMessage): "ide" | "app" | "none" {
    if (onIdeHost(req)) return isIdePath(req.url) ? "ide" : req.url === "/api/health" ? "app" : "none";
    if (isIdePath(req.url)) return ideHost ? "none" : "ide";
    return "app";
  }

  function refuse(req: IncomingMessage, res: ServerResponse) {
    const text = onIdeHost(req) ? "Not found" : `The editor is at ${ctx.cfg.ideUrl}. Open it from Aatmiq → Code.`;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
  }

  return {
    route,
    refuse,
    http,
    closeAll() {
      for (const s of open) s.destroy();
      open.clear();
    },
    attach(server: Server) {
      server.on("upgrade", (req, socket, head) => {
        if (route(req) === "ide") void upgrade(req, socket, head);
        else socket.destroy();
      });
    },
  };
}
