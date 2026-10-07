/**
 * Connector sign-in (MCP authorization, OAuth 2.1) and the credentials the MCP proxy adds.
 *
 *  1. Discovery: the server's 401 names its protected-resource metadata (RFC 9728), which names the
 *     authorization server; its metadata (RFC 8414 / OpenID) gives the endpoints.
 *  2. Client: the admin's OAuth app, else dynamic client registration (RFC 7591), else a client
 *     metadata document URL when the server supports it and Aatmiq has a public https address.
 *  3. Each person signs in (authorization code + PKCE, `resource` per RFC 8707); tokens are stored
 *     encrypted per person and refreshed when they expire.
 *
 * The agent runtime never sees these tokens: its MCP traffic goes through Aatmiq's proxy.
 */
import { and, connector, connectorAccount, eq, type ConnectorOAuthMeta, type DB } from "@aatmiq/db";
import { catalogEntry } from "@aatmiq/shared";
import { createHash, randomBytes } from "node:crypto";
import type { SecretBox } from "../crypto";

export class ConnectorError extends Error {}

type Connector = typeof connector.$inferSelect;
type Fetch = typeof fetch;

const b64url = (buf: Buffer) => buf.toString("base64url");
const TIMEOUT = 15_000;

/** Issuers that reject the RFC 8707 `resource` parameter or need extra parameters for refresh tokens. */
function issuerQuirks(issuer: string) {
  const host = (() => {
    try {
      return new URL(issuer).host;
    } catch {
      return "";
    }
  })();
  return {
    google: host === "accounts.google.com",
    sendResource: !["accounts.google.com", "github.com", "slack.com"].includes(host),
  };
}

async function getJson(url: string, fetchImpl: Fetch): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!r.ok) return null;
    const j = (await r.json()) as unknown;
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Discovered endpoints may only be https, unless the connector itself is plain http (local servers, tests). */
function checkEndpoint(u: unknown, connectorUrl: string): string {
  if (typeof u !== "string") throw new ConnectorError("The service's sign-in details are incomplete.");
  const url = new URL(u);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && connectorUrl.startsWith("http:"))) throw new ConnectorError("The service's sign-in address isn't secure (https).");
  return url.toString();
}

export type Discovery = Omit<ConnectorOAuthMeta, "client" | "redirectUri"> & { registrationEndpoint?: string; metadataDocuments: boolean };

/** Find how a connector's server wants clients to sign in. */
export async function discoverOAuth(serverUrl: string, fetchImpl: Fetch = fetch): Promise<Discovery> {
  const u = new URL(serverUrl);
  let prm: Record<string, unknown> | null = null;
  try {
    const r = await fetchImpl(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aatmiq", version: "1" } } }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const challenge = r.headers.get("www-authenticate") ?? "";
    const meta = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    if (meta) prm = await getJson(new URL(meta, serverUrl).toString(), fetchImpl);
    await r.body?.cancel().catch(() => undefined);
  } catch {
    throw new ConnectorError("The service couldn't be reached.");
  }
  const path = u.pathname.replace(/\/$/, "");
  prm ??= (path ? await getJson(`${u.origin}/.well-known/oauth-protected-resource${path}`, fetchImpl) : null) ?? (await getJson(`${u.origin}/.well-known/oauth-protected-resource`, fetchImpl));
  const issuer = (Array.isArray(prm?.authorization_servers) && typeof prm.authorization_servers[0] === "string" ? prm.authorization_servers[0] : u.origin) as string;
  const iu = new URL(issuer);
  const ipath = iu.pathname.replace(/\/$/, "");
  const candidates = [
    `${iu.origin}/.well-known/oauth-authorization-server${ipath}`,
    `${iu.origin}/.well-known/openid-configuration${ipath}`,
    ...(ipath ? [`${iu.origin}${ipath}/.well-known/openid-configuration`, `${iu.origin}${ipath}/.well-known/oauth-authorization-server`] : []),
  ];
  let as: Record<string, unknown> | null = null;
  for (const c of candidates) {
    as = await getJson(c, fetchImpl);
    if (as?.authorization_endpoint) break;
    as = null;
  }
  // GitHub publishes no metadata for its OAuth server.
  if (!as && iu.host === "github.com") as = { authorization_endpoint: "https://github.com/login/oauth/authorize", token_endpoint: "https://github.com/login/oauth/access_token" };
  if (!as) throw new ConnectorError("This service doesn't support signing in with OAuth. Use a token instead.");
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  return {
    resource: typeof prm?.resource === "string" ? prm.resource : serverUrl,
    issuer,
    authorizationEndpoint: checkEndpoint(as.authorization_endpoint, serverUrl),
    tokenEndpoint: checkEndpoint(as.token_endpoint, serverUrl),
    ...(as.revocation_endpoint ? { revocationEndpoint: checkEndpoint(as.revocation_endpoint, serverUrl) } : {}),
    ...(as.registration_endpoint ? { registrationEndpoint: checkEndpoint(as.registration_endpoint, serverUrl) } : {}),
    scopesSupported: strings(prm?.scopes_supported) ?? strings(as.scopes_supported),
    tokenAuthMethods: strings(as.token_endpoint_auth_methods_supported),
    metadataDocuments: as.client_id_metadata_document_supported === true,
  };
}

export interface ConnectorsOptions {
  db: DB;
  box: SecretBox;
  appUrl: string;
  productName: () => Promise<string>;
  fetch?: Fetch;
}

type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: Date | null; scope: string | null; label: string | null };

export function createConnectors(opts: ConnectorsOptions) {
  const { db, box } = opts;
  const fetchImpl = opts.fetch ?? fetch;
  const redirectUri = `${opts.appUrl}/api/connectors/oauth/callback`;
  const metadataUrl = `${opts.appUrl}/api/connectors/oauth/client.json`;
  const refreshing = new Map<string, Promise<string>>();

  /** The client to sign in with: the admin's app, a registered one, or a metadata document URL. Saved on the connector. */
  async function ensureClient(c: Connector): Promise<{ meta: ConnectorOAuthMeta; clientId: string; clientSecret: string | null }> {
    const secret = c.oauthClientSecretEnc ? box.decrypt(c.oauthClientSecretEnc) : null;
    const known = c.oauthMeta;
    if (known && c.oauthClientId && (known.client === "admin" || known.redirectUri === redirectUri)) return { meta: known, clientId: c.oauthClientId, clientSecret: secret };
    const d = await discoverOAuth(c.url, fetchImpl);
    const base = { resource: d.resource, issuer: d.issuer, authorizationEndpoint: d.authorizationEndpoint, tokenEndpoint: d.tokenEndpoint, revocationEndpoint: d.revocationEndpoint, scopesSupported: d.scopesSupported, tokenAuthMethods: d.tokenAuthMethods };
    let meta: ConnectorOAuthMeta;
    let clientId: string;
    let clientSecret: string | null = null;
    if (c.oauthClientId && (!known || known.client === "admin")) {
      meta = { ...base, client: "admin" };
      clientId = c.oauthClientId;
      clientSecret = secret;
    } else if (d.registrationEndpoint) {
      const method = !d.tokenAuthMethods || d.tokenAuthMethods.includes("none") ? "none" : "client_secret_post";
      const r = await fetchImpl(d.registrationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: await opts.productName(),
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: method,
        }),
        signal: AbortSignal.timeout(TIMEOUT),
      }).catch(() => null);
      const j = (await r?.json().catch(() => null)) as { client_id?: string; client_secret?: string; error_description?: string } | null;
      if (!r?.ok || !j?.client_id) throw new ConnectorError(`The service didn't accept Aatmiq as an app${j?.error_description ? ` (${j.error_description})` : ""}. An admin can enter an OAuth app's client ID instead.`);
      meta = { ...base, client: "dynamic", redirectUri };
      clientId = j.client_id;
      clientSecret = j.client_secret ?? null;
    } else if (d.metadataDocuments && opts.appUrl.startsWith("https://")) {
      meta = { ...base, client: "metadata", redirectUri };
      clientId = metadataUrl;
    } else {
      throw new ConnectorError("This service needs an OAuth app: an admin has to create one at the service and enter its client ID and secret.");
    }
    await db
      .update(connector)
      .set({ oauthMeta: meta, oauthClientId: clientId, oauthClientSecretEnc: clientSecret ? box.encrypt(clientSecret) : null, updatedAt: new Date() })
      .where(eq(connector.id, c.id));
    return { meta, clientId, clientSecret };
  }

  function scopesFor(c: Connector) {
    return (c.oauthScopes ?? catalogEntry(c.catalogId)?.scopes ?? "").trim();
  }

  /** Where to send a person to connect their account, plus what to remember until they come back. */
  async function startSignIn(c: Connector) {
    const { meta, clientId } = await ensureClient(c);
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const quirks = issuerQuirks(meta.issuer);
    const url = new URL(meta.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    const scope = scopesFor(c);
    if (scope) url.searchParams.set("scope", scope);
    if (quirks.sendResource) url.searchParams.set("resource", meta.resource);
    if (quirks.google) {
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
    }
    return { url: url.toString(), state, verifier };
  }

  async function tokenRequest(c: Connector, params: Record<string, string>): Promise<Tokens> {
    const { meta, clientId, clientSecret } = await ensureClient(c);
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const basic = clientSecret && meta.tokenAuthMethods?.includes("client_secret_basic") && !meta.tokenAuthMethods.includes("client_secret_post");
    if (basic) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
    else {
      body.set("client_id", clientId);
      if (clientSecret) body.set("client_secret", clientSecret);
    }
    if (issuerQuirks(meta.issuer).sendResource) body.set("resource", meta.resource);
    const r = await fetchImpl(meta.tokenEndpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT) }).catch(() => null);
    const text = (await r?.text().catch(() => "")) ?? "";
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(text) as Record<string, unknown>;
    } catch {
      j = Object.fromEntries(new URLSearchParams(text)); // GitHub answers form-encoded without Accept
    }
    // Slack's user-token flow nests the token.
    const t = (j.authed_user && typeof j.authed_user === "object" ? (j.authed_user as Record<string, unknown>) : j) as Record<string, unknown>;
    if (!r?.ok || typeof t.access_token !== "string" || j.ok === false) {
      const why = String(j.error_description ?? j.error ?? (r ? `status ${r.status}` : "no answer"));
      throw new ConnectorError(`The service refused the sign-in (${why}).`);
    }
    const expiresIn = Number(t.expires_in);
    return {
      accessToken: t.access_token,
      refreshToken: typeof t.refresh_token === "string" ? t.refresh_token : null,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
      scope: typeof t.scope === "string" ? t.scope : null,
      label: labelFrom(j),
    };
  }

  async function save(connectorId: string, userId: string, t: Tokens, keepRefresh?: string | null) {
    const values = {
      accessTokenEnc: box.encrypt(t.accessToken),
      refreshTokenEnc: t.refreshToken ? box.encrypt(t.refreshToken) : keepRefresh ? box.encrypt(keepRefresh) : null,
      expiresAt: t.expiresAt,
      scope: t.scope,
      status: "ok",
      updatedAt: new Date(),
      ...(t.label ? { label: t.label } : {}),
    };
    await db
      .insert(connectorAccount)
      .values({ connectorId, userId, ...values })
      .onConflictDoUpdate({ target: [connectorAccount.connectorId, connectorAccount.userId], set: values });
  }

  /** Finish a person's sign-in: trade the code for tokens and store them. */
  async function finishSignIn(c: Connector, userId: string, code: string, verifier: string) {
    const t = await tokenRequest(c, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    await save(c.id, userId, t);
    return t;
  }

  /** A usable access token for this person, refreshed when it's about to expire. */
  async function accessToken(c: Connector, userId: string, force = false): Promise<string> {
    const key = `${c.id}:${userId}`;
    const running = refreshing.get(key);
    if (running) return running;
    const [acc] = await db
      .select()
      .from(connectorAccount)
      .where(and(eq(connectorAccount.connectorId, c.id), eq(connectorAccount.userId, userId)));
    if (!acc || acc.status !== "ok") throw new ConnectorError(`Connect your ${c.displayName} account first.`);
    const fresh = acc.expiresAt === null || acc.expiresAt.getTime() > Date.now() + 60_000;
    if (fresh && !force) return box.decrypt(acc.accessTokenEnc);
    if (!acc.refreshTokenEnc) {
      if (fresh) return box.decrypt(acc.accessTokenEnc);
      await db.update(connectorAccount).set({ status: "expired", updatedAt: new Date() }).where(eq(connectorAccount.id, acc.id));
      throw new ConnectorError(`Your ${c.displayName} connection expired. Connect it again in Work AI → Connections.`);
    }
    const refreshToken = box.decrypt(acc.refreshTokenEnc);
    const p = (async () => {
      try {
        const t = await tokenRequest(c, { grant_type: "refresh_token", refresh_token: refreshToken });
        await save(c.id, userId, t, refreshToken);
        return t.accessToken;
      } catch (e) {
        await db.update(connectorAccount).set({ status: "expired", updatedAt: new Date() }).where(eq(connectorAccount.id, acc.id));
        throw new ConnectorError(`Your ${c.displayName} connection expired (${e instanceof Error ? e.message : "refresh failed"}). Connect it again in Work AI → Connections.`);
      } finally {
        refreshing.delete(key);
      }
    })();
    refreshing.set(key, p);
    return p;
  }

  /** Headers that authenticate a call to the connector's server for this person. */
  async function upstreamHeaders(c: Connector, userId: string, forceRefresh = false): Promise<Record<string, string>> {
    if (c.auth === "oauth") return { authorization: `Bearer ${await accessToken(c, userId, forceRefresh)}` };
    if (c.auth === "token" && c.headersEnc) return JSON.parse(box.decrypt(c.headersEnc)) as Record<string, string>;
    return {};
  }

  /** Disconnect a person: revoke the token when the service offers it, then forget it. */
  async function disconnect(c: Connector, userId: string) {
    const [acc] = await db
      .select()
      .from(connectorAccount)
      .where(and(eq(connectorAccount.connectorId, c.id), eq(connectorAccount.userId, userId)));
    if (!acc) return;
    const meta = c.oauthMeta;
    if (meta?.revocationEndpoint && c.oauthClientId) {
      const body = new URLSearchParams({ token: box.decrypt(acc.refreshTokenEnc ?? acc.accessTokenEnc), client_id: c.oauthClientId });
      if (c.oauthClientSecretEnc) body.set("client_secret", box.decrypt(c.oauthClientSecretEnc));
      await fetchImpl(meta.revocationEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(TIMEOUT) }).catch(() => undefined);
    }
    await db.delete(connectorAccount).where(eq(connectorAccount.id, acc.id));
  }

  /** The client metadata document (for services that accept a URL as the client id). */
  async function clientMetadata() {
    return {
      client_id: metadataUrl,
      client_name: await opts.productName(),
      client_uri: opts.appUrl,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  return { redirectUri, ensureClient, startSignIn, finishSignIn, accessToken, upstreamHeaders, disconnect, clientMetadata, scopesFor };
}

export type Connectors = ReturnType<typeof createConnectors>;

/** Who signed in, for display: an id_token's email, or what the token response names. */
function labelFrom(j: Record<string, unknown>): string | null {
  if (typeof j.id_token === "string") {
    try {
      const claims = JSON.parse(Buffer.from(j.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string; name?: string };
      if (claims.email || claims.name) return claims.email ?? claims.name ?? null;
    } catch {
      /* not a JWT */
    }
  }
  const team = j.team && typeof j.team === "object" ? (j.team as { name?: string }).name : undefined;
  for (const v of [j.email, j.account, j.username, j.user_name, team, j.workspace_name]) if (typeof v === "string" && v) return v;
  return null;
}
