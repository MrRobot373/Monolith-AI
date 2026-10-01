/**
 * Minimal OpenID Connect client (authorization code + PKCE) for Google, Microsoft Entra ID and any
 * standards-compliant provider (Okta, Keycloak, Auth0, JumpCloud…). The ID token is verified with
 * the provider's published keys; we never store provider access tokens.
 */
import type { ssoConnection } from "@aatmiq/db";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

type Connection = typeof ssoConnection.$inferSelect;

export const GOOGLE_ISSUER = "https://accounts.google.com";
export const microsoftIssuer = (tenantId: string) => `https://login.microsoftonline.com/${tenantId}/v2.0`;

export class SsoError extends Error {}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 3600_000) return hit.doc;
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  } catch {
    throw new SsoError(`Couldn't reach ${new URL(url).host}. Check the issuer URL and that this server can reach it.`);
  }
  if (!res.ok) throw new SsoError(`The provider's configuration (${url}) answered ${res.status}. Check the issuer URL.`);
  const doc = (await res.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new SsoError("The provider's configuration is missing required endpoints.");
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

export function clearSsoCaches() {
  discoveryCache.clear();
  jwksCache.clear();
}

const b64url = (b: Buffer) => b.toString("base64url");

export function newAuthRequest() {
  const verifier = b64url(randomBytes(32));
  return {
    state: b64url(randomBytes(16)),
    nonce: b64url(randomBytes(16)),
    verifier,
    challenge: b64url(createHash("sha256").update(verifier).digest()),
  };
}

export async function authorizationUrl(
  conn: Connection,
  opts: { redirectUri: string; state: string; nonce: string; challenge: string; loginHint?: string },
  fetchImpl?: typeof fetch,
) {
  const d = await discover(conn.issuer, fetchImpl);
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", conn.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("nonce", opts.nonce);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (conn.type === "google" && conn.domains.length === 1) u.searchParams.set("hd", conn.domains[0]!);
  if (conn.type === "google" || conn.type === "microsoft") u.searchParams.set("prompt", "select_account");
  if (opts.loginHint) u.searchParams.set("login_hint", opts.loginHint);
  return u.toString();
}

export interface SsoIdentity {
  subject: string;
  email: string;
  name: string;
  claims: JWTPayload;
}

/** Exchange the code, verify the ID token and return who signed in. */
export async function completeSignIn(
  conn: Connection,
  clientSecret: string,
  opts: { code: string; verifier: string; nonce: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<SsoIdentity> {
  const d = await discover(conn.issuer, fetchImpl);
  const body = new URLSearchParams({ grant_type: "authorization_code", code: opts.code, redirect_uri: opts.redirectUri, code_verifier: opts.verifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  const methods = d.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  if (methods.includes("client_secret_basic")) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(conn.clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
  } else {
    body.set("client_id", conn.clientId);
    body.set("client_secret", clientSecret);
  }
  const res = await fetchImpl(d.token_endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  const tok = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !tok.id_token) throw new SsoError(tok.error_description || tok.error || `The provider refused the sign-in (${res.status}).`);

  let jwks = jwksCache.get(d.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(d.jwks_uri));
    jwksCache.set(d.jwks_uri, jwks);
  }
  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(tok.id_token, jwks, { issuer: d.issuer, audience: conn.clientId, clockTolerance: 60 }));
  } catch (e) {
    throw new SsoError(`The provider's identity token couldn't be verified (${(e as Error).message}).`);
  }
  if (claims.nonce !== opts.nonce) throw new SsoError("The sign-in response didn't match this browser. Please try again.");
  if (!claims.sub) throw new SsoError("The provider didn't say who signed in.");

  const raw = typeof claims.email === "string" ? claims.email : conn.type === "microsoft" && typeof claims.preferred_username === "string" ? claims.preferred_username : "";
  const email = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new SsoError("The provider didn't share an email address. Allow the email scope for this app.");
  // Google always states verification; other providers may omit it, but an explicit "false" is refused.
  if (claims.email_verified === false || (conn.type === "google" && claims.email_verified !== true))
    throw new SsoError("This email address isn't verified with your provider.");
  const name =
    (typeof claims.name === "string" && claims.name.trim()) ||
    [claims.given_name, claims.family_name].filter((x) => typeof x === "string").join(" ").trim() ||
    email.split("@")[0]!;
  return { subject: String(claims.sub), email, name, claims };
}

export function emailDomainAllowed(conn: Connection, email: string) {
  if (!conn.domains.length) return true;
  const domain = email.split("@")[1] ?? "";
  return conn.domains.some((d) => d.toLowerCase() === domain);
}
