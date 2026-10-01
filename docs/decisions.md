# Decision Log

| # | Date | Decision | Alternatives considered | Reason |
|---|---|---|---|---|
| D1 | 2026-09-28 | Agent engine = DeepSeek Harness (dsh), wrapped by our own adapter | Build own loop; OpenHands | Open (MIT), plugin-based, Node. Adapter protects against preview-stage breaking changes |
| D2 | 2026-09-28 | IDE = **fork of Code-OSS** (separate repo) | OpenVSCode Server embed; custom Monaco | Full VS Code parity and deepest customization (Cursor/Windsurf approach) |
| D3 | 2026-09-28 | Delivery = **web app + desktop app** | Web only | Desktop IDE for developers; web for everyone. One Code-OSS fork builds both |
| D4 | 2026-09-28 | Super Admin = **central license server**; deployments send license/aggregate counts only | Fully offline; both | Customer visibility + billing while preserving data privacy. Offline signed license can be added in P4 |
| D5 | 2026-09-28 | Execution = **one Docker container per user** | K8s pods; shared host | Isolation for Work AI + IDE terminals; K8s later via Helm |
| D6 | 2026-09-28 | Stack = **TypeScript everywhere** (Next.js, Fastify, Postgres+pgvector, Redis) | Python API; Go API | One language; matches DSH and VS Code |
| D7 | 2026-09-28 | Login = email+password, Google/Microsoft SSO, SAML/OIDC | + LDAP | Covers startups to mid-size; LDAP deferred |
| D8 | 2026-09-28 | Build order = **Foundation + Chat first**, then Work AI, then IDE | IDE first; Work AI first | Fastest path to a sellable demo |
| D9 | 2026-09-28 | Models = mixed: Ollama/vLLM local **and** OpenAI-compatible private endpoints | GPU-only; CPU-only | Customers have varied hardware |
| D10 | 2026-09-28 | Extensions from Open VSX (+ private registry) | MS Marketplace | MS Marketplace terms disallow forks |
| D11 | 2026-09-28 | Brand = black/gray/white + configurable accent (default cyan) | — | White-label per customer |
| D12 | 2026-09-28 | Tenancy = one org per install with **multiple workspaces (teams)**, each with its own models, budget and connectors | Single-team org | Teams need separate models and budgets |
| D13 | 2026-09-28 | Over-quota = **request more tokens in-app**; admins approve/deny; paused agent tasks resume | Hard stop | Keeps work flowing, admin stays in control |
| D14 | 2026-09-28 | Models: Super Admin curates catalog; **Aatmiq-managed** orgs → Super Admin config; **self-managed** orgs → Org Admin | Fixed list | Supports both customer types; no content passes through our cloud |
| D15 | 2026-09-28 | Pricing = tiered per-seat (Chat / Work / Complete / Enterprise) + platform fee + managed LLM add-on (proposal) | Flat per org; usage-based | Familiar to buyers, upgrade path, covers support cost |
| D16 | 2026-09-28 | Product name = **Aatmiq** ("your own AI"); name stays config-driven | Monolith AI (UK trademark conflict); Onelith; Ekanta; Ekastra | No conflicts found; .com and .ai both likely free; meaning sells privacy |
| D17 | 2026-09-28 | Add **Workspace Admin** role | Org Admin only | Delegation for team budgets and token requests |
| D18 | 2026-09-28 | Only Org Admins/Owners invite new people to the org; Workspace Admins add existing users | WS Admins invite | Seat and license control stays with org |
| D19 | 2026-09-28 | Default user quota = workspace budget ÷ members, auto-recalculated unless manually overridden | Fixed default | Fair by default, adjustable |
| D20 | 2026-09-28 | Prompt/response logging off by default; visible notice + acknowledgement when enabled | Always on; never | Compliance option without surprising users |
| D22 | 2026-10-01 | SSO = our own OIDC client (code + PKCE, ID token verified via JWKS) for Google, Microsoft Entra (single tenant only) and generic OIDC; sessions issued by Better Auth through a one-time ticket | Better Auth SSO plugin; SAML first | Full control over invite/auto-join/domain rules and seats; every session rule still applies; OIDC covers most IdPs. SAML moves to P4 |
| D23 | 2026-10-01 | An inactive license (expired past grace, revoked, missing) makes the product **read-only** rather than locking people out | Hard lock | People keep access to their own history; only changes are refused |
| D24 | 2026-10-01 | License server is a separate app + console with its own database; shared design system extracted to `packages/ui` | Console inside the product | Our cloud and customer deployments never share code paths or data |
| D21 | 2026-09-28 | UI direction = **native pro-tool look** (references: Rune agent workspace, Google Antigravity, VS Code-style IDEs): framed window, neutral charcoal palette, white primary actions, serif display type (Newsreader) + Inter UI, cyan only as a small accent | Cyan-heavy glow style (first version, rejected by owner) | Owner feedback; calmer, more premium, fits enterprise buyers |
