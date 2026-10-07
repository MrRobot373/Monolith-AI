/**
 * Connectors (MCP servers the agent uses as tools).
 *
 *   Admin    GET/POST /api/admin/connectors, PATCH/DELETE /api/admin/connectors/:id,
 *            POST /api/admin/connectors/:id/test, GET /api/admin/connectors/catalog
 *   People   GET /api/connectors, POST /api/connectors/:id/connect → {url},
 *            DELETE /api/connectors/:id/connection, GET /api/connectors/oauth/callback
 *   Public   GET /api/connectors/oauth/client.json (OAuth client metadata document)
 *   Runtime  /api/internal/work/mcp/:name (per-task token): the MCP proxy. It adds the connector's
 *            credentials (the person's own OAuth token, or the shared headers), so the agent
 *            runtime never holds them.
 */
import { and, asc, connector, connectorAccount, eq, sql } from "@aatmiq/db";
import { APPROVAL_PRESETS, catalogEntry, CONNECTOR_CATALOG, connectorSchema, connectorUpdateSchema } from "@aatmiq/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, parse, requireOrgCap, requireUser, type AppContext } from "../context";
import { badRequest, HttpError, notFound } from "../errors";
import { ConnectorError } from "../services/connectors";
import { probeMcp } from "../services/mcp";

const STATE_COOKIE = "aatmiq_connector_oauth";
const STATE_TTL_MS = 10 * 60 * 1000;
const FORWARD_REQUEST = ["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const FORWARD_RESPONSE = ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control"];

function readCookie(req: FastifyRequest, name: string) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? "");
  return m ? decodeURIComponent(m[1]!) : null;
}

type Row = typeof connector.$inferSelect;

export async function connectorRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, box, cfg, connectors, work } = ctx;
  const secure = cfg.appUrl.startsWith("https://");
  const stateCookie = (value: string, maxAge: number) =>
    `${STATE_COOKIE}=${encodeURIComponent(value)}; Path=/api/connectors/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  const accountCounts = async () =>
    new Map(
      (
        await db
          .select({ id: connectorAccount.connectorId, n: sql<number>`count(*)::int` })
          .from(connectorAccount)
          .where(eq(connectorAccount.status, "ok"))
          .groupBy(connectorAccount.connectorId)
      ).map((r) => [r.id, r.n]),
    );

  const adminView = (c: Row, accounts = 0) => {
    const { headersEnc, oauthClientSecretEnc, oauthMeta, ...rest } = c;
    let headerNames: string[] = [];
    try {
      headerNames = headersEnc ? Object.keys(JSON.parse(box.decrypt(headersEnc))) : [];
    } catch {
      headerNames = [];
    }
    const entry = catalogEntry(c.catalogId);
    return {
      ...rest,
      headerNames,
      // A registered (dynamic) client is Aatmiq's own; only an admin-entered one is shown as such.
      oauthClientId: oauthMeta?.client === "dynamic" || oauthMeta?.client === "metadata" ? null : c.oauthClientId,
      hasClientSecret: !!oauthClientSecretEnc && oauthMeta?.client !== "dynamic",
      oauthClient: oauthMeta?.client ?? null,
      description: entry?.description ?? null,
      category: entry?.category ?? null,
      accounts,
    };
  };

  /* ───────────── Admin ───────────── */

  app.get("/api/admin/connectors/catalog", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.work.manage");
    return { catalog: CONNECTOR_CATALOG, redirectUri: connectors.redirectUri, presets: APPROVAL_PRESETS };
  });

  app.get("/api/admin/connectors", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.work.manage");
    const counts = await accountCounts();
    return (await db.select().from(connector).orderBy(asc(connector.displayName))).map((c) => adminView(c, counts.get(c.id) ?? 0));
  });

  app.post("/api/admin/connectors", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.work.manage");
    const b = parse(connectorSchema, req.body);
    const [exists] = await db.select({ id: connector.id }).from(connector).where(eq(connector.name, b.name));
    if (exists) throw badRequest("A connector with that name already exists.");
    const entry = catalogEntry(b.catalogId);
    const auth = b.auth ?? entry?.auth ?? (b.headers && Object.keys(b.headers).length ? "token" : "none");
    if (auth === "token" && !(b.headers && Object.keys(b.headers).length)) throw badRequest("Enter the token (or header) this service needs.");
    const { headers, oauthClientSecret, ...rest } = b;
    const [c] = await db
      .insert(connector)
      .values({
        ...rest,
        catalogId: entry?.id ?? null,
        auth,
        approveTools: (req.body as { approveTools?: string }).approveTools !== undefined ? b.approveTools : (entry?.approveTools ?? (auth === "none" ? APPROVAL_PRESETS.none : APPROVAL_PRESETS.changes)),
        headersEnc: auth === "token" && headers && Object.keys(headers).length ? box.encrypt(JSON.stringify(headers)) : null,
        oauthClientId: auth === "oauth" ? (b.oauthClientId ?? null) : null,
        oauthClientSecretEnc: auth === "oauth" && oauthClientSecret ? box.encrypt(oauthClientSecret) : null,
        oauthScopes: auth === "oauth" ? (b.oauthScopes ?? null) : null,
        oauthMeta: null,
      })
      .returning();
    await audit(ctx, { actor: u, action: "work.connector.added", targetType: "connector", targetId: c!.id, meta: { name: b.name, url: b.url, auth, catalogId: entry?.id } });
    return adminView(c!);
  });

  app.patch<{ Params: { id: string } }>("/api/admin/connectors/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.work.manage");
    const { headers, oauthClientId, oauthClientSecret, ...b } = parse(connectorUpdateSchema, req.body);
    const [old] = await db.select().from(connector).where(eq(connector.id, req.params.id));
    if (!old) throw notFound("Connector not found");
    // A new address or OAuth app means signing in again from scratch.
    const resetOAuth = (b.url !== undefined && b.url !== old.url) || oauthClientId !== undefined || (b.auth !== undefined && b.auth !== old.auth);
    const [c] = await db
      .update(connector)
      .set({
        ...b,
        ...(headers !== undefined ? { headersEnc: Object.keys(headers).length ? box.encrypt(JSON.stringify(headers)) : null } : {}),
        ...(oauthClientId !== undefined ? { oauthClientId, oauthClientSecretEnc: oauthClientSecret ? box.encrypt(oauthClientSecret) : null } : {}),
        ...(resetOAuth ? { oauthMeta: null, ...(oauthClientId === undefined && old.oauthMeta?.client !== "admin" ? { oauthClientId: null, oauthClientSecretEnc: null } : {}) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(connector.id, old.id))
      .returning();
    if (resetOAuth) await db.delete(connectorAccount).where(eq(connectorAccount.connectorId, old.id));
    await audit(ctx, { actor: u, action: "work.connector.updated", targetType: "connector", targetId: old.id, meta: { ...b, headersChanged: headers !== undefined, oauthClientChanged: oauthClientId !== undefined } });
    return adminView(c!, (await accountCounts()).get(old.id) ?? 0);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/connectors/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.work.manage");
    const [c] = await db.delete(connector).where(eq(connector.id, req.params.id)).returning();
    if (!c) throw notFound("Connector not found");
    await audit(ctx, { actor: u, action: "work.connector.deleted", targetType: "connector", targetId: c.id, meta: { name: c.name } });
    return { ok: true };
  });

  /** Check a connector: list its tools (with the admin's own sign-in for OAuth), or check sign-in is ready. */
  app.post<{ Params: { id: string } }>("/api/admin/connectors/:id/test", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.work.manage");
    const [c] = await db.select().from(connector).where(eq(connector.id, req.params.id));
    if (!c) throw notFound("Connector not found");
    try {
      if (c.auth === "oauth") {
        const [mine] = await db
          .select({ id: connectorAccount.id })
          .from(connectorAccount)
          .where(and(eq(connectorAccount.connectorId, c.id), eq(connectorAccount.userId, u.id), eq(connectorAccount.status, "ok")));
        if (!mine) {
          const { meta } = await connectors.ensureClient(c);
          return { ok: true, signIn: true, issuer: meta.issuer, tools: [], note: "Sign-in is ready. Connect your own account (Work AI → Connections) to list its tools." };
        }
      }
      const r = await probeMcp(c.url, await connectors.upstreamHeaders(c, u.id));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't connect.", tools: [] };
    }
  });

  /* ───────────── People ───────────── */

  app.get("/api/connectors", async (req) => {
    const u = await requireUser(ctx, req);
    const rows = await db.select().from(connector).where(eq(connector.enabled, true)).orderBy(asc(connector.displayName));
    const mine = new Map(
      (await db.select().from(connectorAccount).where(eq(connectorAccount.userId, u.id))).map((a) => [a.connectorId, a]),
    );
    return rows.map((c) => {
      const a = mine.get(c.id);
      const entry = catalogEntry(c.catalogId);
      return {
        id: c.id,
        name: c.name,
        displayName: c.displayName,
        catalogId: c.catalogId,
        description: entry?.description ?? null,
        category: entry?.category ?? null,
        auth: c.auth,
        connected: c.auth !== "oauth" || a?.status === "ok",
        account: a ? { label: a.label, status: a.status, connectedAt: a.createdAt } : null,
      };
    });
  });

  const connectSchema = z.object({ returnTo: z.string().max(300).optional() });
  app.post<{ Params: { id: string } }>("/api/connectors/:id/connect", async (req, reply) => {
    const u = await requireUser(ctx, req);
    const b = parse(connectSchema, req.body);
    const [c] = await db.select().from(connector).where(and(eq(connector.id, req.params.id), eq(connector.enabled, true)));
    if (!c) throw notFound("Connector not found");
    if (c.auth !== "oauth") throw badRequest("This connector doesn't need you to sign in.");
    let start;
    try {
      start = await connectors.startSignIn(c);
    } catch (e) {
      throw new HttpError(409, e instanceof ConnectorError ? e.message : "Couldn't start signing in.", "connector_setup");
    }
    const returnTo = b.returnTo && /^\/(?!\/)/.test(b.returnTo) ? b.returnTo : "/app/work/connections";
    const sealed = box.encrypt(JSON.stringify({ state: start.state, verifier: start.verifier, connectorId: c.id, userId: u.id, returnTo, exp: Date.now() + STATE_TTL_MS }));
    reply.header("set-cookie", stateCookie(sealed, STATE_TTL_MS / 1000));
    return { url: start.url };
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/connectors/oauth/callback", async (req, reply) => {
    let st: { state: string; verifier: string; connectorId: string; userId: string; returnTo: string; exp: number };
    const back = (returnTo: string, q: Record<string, string>) =>
      reply.header("set-cookie", stateCookie("", 0)).redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}${new URLSearchParams(q)}`);
    try {
      st = JSON.parse(box.decrypt(readCookie(req, STATE_COOKIE) ?? ""));
    } catch {
      return back("/app/work/connections", { connector_error: "Your sign-in took too long. Please try again." });
    }
    if (st.exp < Date.now() || !req.query.state || req.query.state !== st.state) return back(st.returnTo, { connector_error: "Your sign-in took too long. Please try again." });
    const u = await requireUser(ctx, req).catch(() => null);
    if (!u || u.id !== st.userId) return back(st.returnTo, { connector_error: "Sign in to Aatmiq as the same person, then connect again." });
    const [c] = await db.select().from(connector).where(eq(connector.id, st.connectorId));
    if (!c) return back(st.returnTo, { connector_error: "That connector was removed." });
    if (req.query.error) return back(st.returnTo, { connector_error: req.query.error_description || `${c.displayName} didn't connect (${req.query.error}).` });
    if (!req.query.code) return back(st.returnTo, { connector_error: `${c.displayName} didn't finish signing in.` });
    try {
      await connectors.finishSignIn(c, u.id, req.query.code, st.verifier);
    } catch (e) {
      req.log.warn({ err: e }, "connector sign-in failed");
      return back(st.returnTo, { connector_error: e instanceof ConnectorError ? e.message : `${c.displayName} didn't connect.` });
    }
    await audit(ctx, { actor: u, action: "work.connector.connected", targetType: "connector", targetId: c.id, meta: { name: c.name } });
    return back(st.returnTo, { connected: c.name });
  });

  app.delete<{ Params: { id: string } }>("/api/connectors/:id/connection", async (req) => {
    const u = await requireUser(ctx, req);
    const [c] = await db.select().from(connector).where(eq(connector.id, req.params.id));
    if (!c) throw notFound("Connector not found");
    await connectors.disconnect(c, u.id);
    await audit(ctx, { actor: u, action: "work.connector.disconnected", targetType: "connector", targetId: c.id, meta: { name: c.name } });
    return { ok: true };
  });

  app.get("/api/connectors/oauth/client.json", async () => connectors.clientMetadata());

  /* ───────────── MCP proxy for the agent runtime ───────────── */

  const rpcError = (reply: FastifyReply, id: unknown, message: string, status = 200) =>
    reply.status(status).header("content-type", "application/json").send({ jsonrpc: "2.0", id: id ?? null, error: { code: -32001, message } });

  const proxy = async (req: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const t = token ? work.fromToken(token) : null;
    if (!t) return reply.status(401).send({ error: "This task isn't running." });
    const body = req.method === "POST" ? req.body : undefined;
    const rpcId = body && typeof body === "object" && !Array.isArray(body) ? (body as { id?: unknown }).id : undefined;
    const [c] = await db.select().from(connector).where(and(eq(connector.name, req.params.name), eq(connector.enabled, true)));
    if (!c) return rpcError(reply, rpcId, "This connector isn't available any more.", 404);

    const abort = new AbortController();
    req.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    const send = async (forceRefresh: boolean) => {
      const headers: Record<string, string> = {};
      for (const h of FORWARD_REQUEST) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      Object.assign(headers, await connectors.upstreamHeaders(c, t.userId, forceRefresh));
      return fetch(c.url, { method: req.method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: abort.signal });
    };
    let upstream: Response;
    try {
      upstream = await send(false);
      if (upstream.status === 401 && c.auth === "oauth") {
        await upstream.body?.cancel().catch(() => undefined);
        upstream = await send(true);
      }
    } catch (e) {
      if (e instanceof ConnectorError) return rpcError(reply, rpcId, e.message);
      return rpcError(reply, rpcId, `${c.displayName} couldn't be reached (${e instanceof Error ? e.message : "network error"}).`, 502);
    }
    if (upstream.status === 401 || upstream.status === 403) {
      await upstream.body?.cancel().catch(() => undefined);
      const why = c.auth === "oauth" ? `${c.displayName} refused the sign-in. Connect it again in Work AI → Connections.` : `${c.displayName} refused the credentials. An admin can update them in Admin → Work AI.`;
      return rpcError(reply, rpcId, why);
    }
    reply.hijack();
    const res = reply.raw;
    const out: Record<string, string> = {};
    for (const h of FORWARD_RESPONSE) {
      const v = upstream.headers.get(h);
      if (v) out[h] = v;
    }
    res.writeHead(upstream.status, out);
    if (!upstream.body) return res.end();
    try {
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
    } catch {
      /* the client or the server went away */
    }
    res.end();
  };
  const route = { config: { rateLimit: false }, bodyLimit: 16 * 1024 * 1024 } as const;
  app.post<{ Params: { name: string } }>("/api/internal/work/mcp/:name", route, proxy);
  app.get<{ Params: { name: string } }>("/api/internal/work/mcp/:name", route, proxy);
  app.delete<{ Params: { name: string } }>("/api/internal/work/mcp/:name", route, proxy);
}
