# Pricing and Business Model (recommendation)

Status: **Proposal**. The numbers are starting hypotheses to validate with the first 5–10 customers.

## 1. Recommended model: **Tiered per-seat + annual platform fee + optional managed LLM**

Why this mix:
- **Per seat** is how buyers already compare ChatGPT Team, Claude Team and Cursor Business, so the comparison is easy.
- **Tiers by section** let a small company start cheap (Chat) and upgrade (Work AI, Code). The license already gates sections, so this costs almost nothing to build.
- **Platform fee** covers install, updates and support. Self-hosted products carry real support cost, and a 10-seat customer must still be profitable.
- **Managed LLM** is a separate, high-margin line for customers without an AI/infra team. It matches the "Monolith-managed" model mode in the foundation spec.

Flat per-org pricing is simpler, but it underprices growing customers and gives no upgrade path. Pure usage pricing makes no sense when the customer owns the GPUs.

## 2. Tiers (indicative)

| | **Chat** | **Work** | **Complete** | **Enterprise** |
|---|---|---|---|---|
| Sections | Chat + documents | + Work AI (agent, connectors, web search, skills) | + Code IDE (desktop + web) | Everything |
| Login | Email/pw, Google/Microsoft | same | same | + SAML/OIDC, LDAP |
| Workspaces | 3 | 10 | Unlimited | Unlimited |
| Audit log | 30 days | 90 days | 1 year | Unlimited + export |
| Support | Email | Email | Priority | SLA + dedicated contact |
| Price / seat / month (annual) | ~$10 | ~$22 | ~$35 | Custom |
| Minimum seats | 10 | 10 | 10 | 50 |

- **Platform fee:** ~$1,500–3,000 / year (includes installation and version updates). It is waived above ~100 seats.
- **Managed LLM add-on:** we set up and operate the model servers (on their hardware, or a private GPU host they choose), priced monthly by hardware tier.
- **Regional pricing:** keep separate INR price lists for the Indian market (roughly 40–60% of USD list prices), billed in INR with GST.
- **Pilot:** a 30-day paid pilot, credited to the first year. Avoid free trials for self-hosted products because each install costs support time.

These sit below the cloud tools a buyer compares against (roughly $25–40 per seat per month for team plans; verify current prices before publishing), while the pitch is *privacy + one product instead of three*.

## 3. What the license encodes
`tier`, `seats`, `sections[]`, `features[]` (sso_saml, audit_export, connectors, …), `model_mode` (managed|self), `workspace_limit`, `expires_at`, and `branding`. Changing plan = issuing a new key; no reinstall.

## 4. Name and trademark ⚠️
**"Monolith AI" is already used**: Monolith AI Ltd (London, founded 2016, engineering ML software, monolithai.com) holds a registered trademark. Selling B2B AI software under the same name risks a dispute and makes the product hard to find in search.

Options:
1. A distinct name, e.g. **Monolith Works**, **Monolyth**, **Obelisk AI**, **Vault AI**, **Keystone AI** (each still needs a trademark and domain check).
2. Keep "Monolith" as the codename. The product name is config-driven everywhere (the license `branding.name` and app config), so a rename later is cheap.

Recommendation: keep building under the codename "Monolith". Pick the final name and buy the domain before the marketing site goes live (P1).
