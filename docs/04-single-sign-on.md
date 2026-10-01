# Single sign-on

People sign in with their company account (Google Workspace, Microsoft Entra ID, or any OpenID Connect provider such as Okta, Keycloak, Auth0, JumpCloud or OneLogin). When someone leaves the company and IT disables their account, they lose access to Aatmiq too.

Admins configure it in **Admin → Authentication**. Only org owners and admins can do this.

## Licensing

| Provider | Needs license feature | Plans |
|---|---|---|
| Google, Microsoft | `sso` | Chat, Work, Complete, Enterprise |
| Other (OpenID Connect) | `oidc` | Enterprise |

In development mode (no license public key configured) every provider is available.

## Setting up a provider

Every provider uses the same redirect URI, shown in the dialog: `https://<your Aatmiq address>/api/auth/sso/callback`.

- **Google Workspace:** Google Cloud Console → APIs & Services → Credentials → *Create OAuth client ID*. Choose type **Web application** and add the redirect URI. Paste the client ID and secret. If you allow exactly one email domain, Google's account chooser is also limited to it.
- **Microsoft Entra ID:** Entra admin center → App registrations → *New registration*. Choose **single tenant**, platform **Web**, and add the redirect URI. Then create a client secret under *Certificates & secrets*. Paste the **Directory (tenant) ID**, the **Application (client) ID** and the secret value. Multi-tenant IDs (`common`, `organizations`) are refused, because any Microsoft directory could then vouch for any email address.
- **Other (OIDC):** create a web application with the authorization code flow, allow the redirect URI, and grant the `openid email profile` scopes. Paste the issuer URL (for example `https://acme.okta.com`), the client ID and the secret. Aatmiq reads `/.well-known/openid-configuration` from the issuer. The **Test** button checks that this server can reach it.

Client secrets are encrypted at rest with `APP_SECRET`.

## Who can sign in

1. **Someone who signed in with this provider before** is matched by the provider's stable subject ID.
2. **Someone with an existing Aatmiq account** (for example a password account) is matched by email, and the provider is linked to that account.
3. **Someone with a pending invitation** for that email has the invitation accepted: their role and workspaces come from the invitation. Invite links show the SSO buttons too.
4. **Auto-join** (optional, per provider, only together with an allowed-domains list): anyone with an allowed domain gets a Member account in the chosen workspace on first sign-in. This uses a license seat.
5. Everyone else is turned away: *"There's no account for … Ask your admin for an invitation."*

**Allowed email domains** restrict a provider to addresses like `@acme.com`.

The following are always refused:
- deactivated accounts
- addresses whose `email_verified` claim is `false` (Google must say `true`)
- forged or expired sign-in state

## Require single sign-on

When this is on, password sign-in (and accepting an invitation with a password) stops working for everyone **except the org owner**. That keeps a way in if the identity provider is down.

The sign-in page then shows only the SSO buttons, plus a small "Organization owner? Sign in with a password" link. Disabling or removing the last provider turns the requirement off automatically, so nobody is locked out.

## How it works

The flow is the authorization code flow with PKCE, a state value and a nonce.

1. `GET /api/auth/sso/:id/start` stores the state, nonce, PKCE verifier and return path in an encrypted, HttpOnly cookie that lasts 10 minutes. It then redirects to the provider.
2. `GET /api/auth/sso/callback` checks the cookie and the state. It exchanges the code using `client_secret_basic` (or `client_secret_post` if that's the only method offered). It then verifies the ID token signature against the provider's JWKS and checks the issuer, audience, nonce and expiry, with 60 s of clock tolerance.
3. It then applies the rules above and creates a one-time **login ticket**. The ticket lasts 2 minutes, is stored hashed, and can be used only once.
4. `GET /api/auth/sso/ticket` is a small Better Auth plugin endpoint. It exchanges the ticket for a normal session cookie. All session rules (for example "deactivated users can't start a session") apply to SSO exactly as they do to passwords.

Provider access tokens are never stored. Audit events: `auth.sso_login`, `user.sso_created`, `auth.sso_added`, `auth.sso_updated`, `auth.sso_removed`, `auth.sso_required_on`, `auth.sso_required_off`.

## Not done yet

- **SAML 2.0.** Most IdPs that offer SAML also offer OIDC, so OIDC covers the common cases. SAML is planned for P4 Enterprise.
- **SCIM provisioning** and **LDAP** (P4).
