/**
 * A tiny OpenID Connect provider for tests (API and browser). It shows a sign-in form, or signs in
 * `login_hint` directly, and issues RS256 ID tokens. Never use it outside tests.
 *
 *   node apps/api/test/mock-idp.mjs 11600
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export async function startMockIdp({ port = 0, clientId = "aatmiq-test", clientSecret = "test-secret", emailVerified = true } = {}) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "mock-1", alg: "RS256", use: "sig" };
  const codes = new Map();
  const state = { emailVerified, logins: 0 };
  let issuer = "";

  const html = (body) => `<!doctype html><meta charset="utf-8"><title>Mock IdP</title><body style="font-family:sans-serif;max-width:360px;margin:60px auto">${body}</body>`;
  const readBody = async (req) => {
    let b = "";
    for await (const c of req) b += c;
    return new URLSearchParams(b);
  };
  const issueCode = (q, email, name) => {
    const code = randomBytes(16).toString("base64url");
    codes.set(code, { email, name, nonce: q.get("nonce"), challenge: q.get("code_challenge"), redirectUri: q.get("redirect_uri"), clientId: q.get("client_id") });
    const back = new URL(q.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state"));
    return back.toString();
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/.well-known/openid-configuration")
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
      });
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize" && req.method === "GET") {
      if (url.searchParams.get("client_id") !== clientId) return json(400, { error: "unknown client" });
      const hint = url.searchParams.get("login_hint");
      if (hint) {
        res.writeHead(302, { location: issueCode(url.searchParams, hint, hint.split("@")[0]) });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(
        html(`<h2>Mock identity provider</h2>
        <form method="post" action="/authorize?${url.searchParams.toString()}">
          <label>Email <input name="email" type="email" required></label><br><br>
          <label>Name <input name="name"></label><br><br>
          <button type="submit">Sign in</button>
          <button type="submit" name="deny" value="1" formnovalidate>Cancel</button>
        </form>`),
      );
    }
    if (url.pathname === "/authorize" && req.method === "POST") {
      const form = await readBody(req);
      if (form.get("deny")) {
        const back = new URL(url.searchParams.get("redirect_uri"));
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("error_description", "You cancelled the sign-in.");
        back.searchParams.set("state", url.searchParams.get("state"));
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      const email = String(form.get("email"));
      res.writeHead(302, { location: issueCode(url.searchParams, email, form.get("name") || email.split("@")[0]) });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = await readBody(req);
      const auth = req.headers.authorization ?? "";
      const [id, secret] = auth.startsWith("Basic ")
        ? Buffer.from(auth.slice(6), "base64").toString().split(":").map(decodeURIComponent)
        : [form.get("client_id"), form.get("client_secret")];
      if (id !== clientId || secret !== clientSecret) return json(401, { error: "invalid_client", error_description: "Wrong client secret." });
      const c = codes.get(form.get("code"));
      codes.delete(form.get("code"));
      if (!c) return json(400, { error: "invalid_grant", error_description: "Code expired." });
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (challenge !== c.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE check failed." });
      if (form.get("redirect_uri") !== c.redirectUri) return json(400, { error: "invalid_grant", error_description: "redirect_uri mismatch." });
      state.logins++;
      const idToken = await new SignJWT({ email: c.email, email_verified: state.emailVerified, name: c.name, nonce: c.nonce })
        .setProtectedHeader({ alg: "RS256", kid: "mock-1" })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setSubject(`sub-${c.email}`)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return json(200, { access_token: "mock-access", token_type: "Bearer", id_token: idToken, expires_in: 300 });
    }
    json(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${server.address().port}`;
  return { issuer, clientId, clientSecret, state, close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const idp = await startMockIdp({ port: Number(process.argv[2] ?? 11600) });
  console.log(`mock idp on ${idp.issuer} (client ${idp.clientId} / ${idp.clientSecret})`);
}
