/**
 * Aatmiq license keys: Ed25519-signed JWTs issued by the license server and verified offline
 * by every deployment. They carry only commercial terms, never customer content.
 */
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from "jose";

export const LICENSE_ISSUER = "aatmiq-license";
export const LICENSE_ALG = "EdDSA";

export const SECTIONS = ["chat", "work", "code"] as const;
export type LicensedSection = (typeof SECTIONS)[number];

/** Optional capabilities gated by the license (`hasFeature`). */
export const FEATURES = {
  sso: "Google and Microsoft sign-in",
  oidc: "Custom single sign-on (OIDC: Okta, Keycloak, Entra…)",
  audit_export: "Audit log export",
  connectors: "Connectors for Work AI",
  managed_models: "Aatmiq-managed models",
} as const;
export type Feature = keyof typeof FEATURES;

export const TIERS = {
  chat: { label: "Chat", sections: ["chat"], features: ["sso"], workspaceLimit: 3 },
  work: { label: "Work", sections: ["chat", "work"], features: ["sso", "connectors"], workspaceLimit: 10 },
  complete: { label: "Complete", sections: ["chat", "work", "code"], features: ["sso", "connectors"], workspaceLimit: null },
  enterprise: { label: "Enterprise", sections: ["chat", "work", "code"], features: ["sso", "oidc", "audit_export", "connectors"], workspaceLimit: null },
} as const satisfies Record<string, { label: string; sections: LicensedSection[]; features: Feature[]; workspaceLimit: number | null }>;
export type Tier = keyof typeof TIERS;

export interface LicenseTerms {
  /** License id (one per issued license; renewals keep it). */
  lid: string;
  /** Customer id and display name. */
  cid: string;
  customer: string;
  tier: Tier;
  seats: number;
  sections: LicensedSection[];
  features: Feature[];
  modelMode: "self" | "managed";
  workspaceLimit: number | null;
  branding?: { accent?: string; name?: string } | null;
  /** Hours between check-ins. */
  checkInHours: number;
}

export interface LicenseClaims extends LicenseTerms {
  /** Seconds since epoch. */
  iat: number;
  exp: number;
}

export class LicenseError extends Error {
  constructor(
    message: string,
    readonly reason: "malformed" | "signature" | "issuer" | "claims",
  ) {
    super(message);
  }
}

export async function generateSigningKeys() {
  const { privateKey, publicKey } = await generateKeyPair(LICENSE_ALG, { crv: "Ed25519", extractable: true });
  return { privatePem: await exportPKCS8(privateKey), publicPem: await exportSPKI(publicKey) };
}

/** Accepts a PEM (real or "\n"-escaped newlines, as env files often have) or the base64 body alone. */
export function normalizePem(input: string, kind: "PUBLIC KEY" | "PRIVATE KEY"): string {
  const s = input.trim().replace(/\\n/g, "\n");
  if (s.includes("-----BEGIN")) return s;
  const body = s.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----`;
}

/** The public key on one line, handy for an environment variable. */
export function publicKeyOneLine(pem: string): string {
  return pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
}

export const importPublicKey = (pem: string) => importSPKI(normalizePem(pem, "PUBLIC KEY"), LICENSE_ALG);
export const importPrivateKey = (pem: string) => importPKCS8(normalizePem(pem, "PRIVATE KEY"), LICENSE_ALG);

export async function signLicense(terms: LicenseTerms, opts: { privateKey: CryptoKey; kid: string; expiresAt: Date; issuedAt?: Date }) {
  return new SignJWT({ ...terms })
    .setProtectedHeader({ alg: LICENSE_ALG, kid: opts.kid, typ: "aatmiq-license+jwt" })
    .setIssuer(LICENSE_ISSUER)
    .setSubject(terms.lid)
    .setIssuedAt(opts.issuedAt ?? new Date())
    .setExpirationTime(opts.expiresAt)
    .sign(opts.privateKey);
}

/**
 * Check the signature and shape. Expiry is NOT enforced here: an expired license still verifies,
 * and `evaluateLicense` decides what an expired license may still do (grace period).
 */
export async function verifyLicense(token: string, publicKey: CryptoKey): Promise<LicenseClaims> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token.trim(), publicKey, {
      algorithms: [LICENSE_ALG],
      issuer: LICENSE_ISSUER,
      currentDate: new Date(0), // ignore exp/nbf here, see above
    }));
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") throw new LicenseError("This license key wasn't issued by Aatmiq.", "signature");
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") throw new LicenseError("This license key wasn't issued by Aatmiq.", "issuer");
    throw new LicenseError("That doesn't look like a valid license key.", "malformed");
  }
  const p = payload as Partial<LicenseClaims>;
  const ok =
    typeof p.lid === "string" &&
    typeof p.cid === "string" &&
    typeof p.customer === "string" &&
    typeof p.tier === "string" &&
    p.tier in TIERS &&
    Number.isInteger(p.seats) &&
    Array.isArray(p.sections) &&
    Array.isArray(p.features) &&
    typeof p.iat === "number" &&
    typeof p.exp === "number";
  if (!ok) throw new LicenseError("This license key is missing required details.", "claims");
  return {
    lid: p.lid!,
    cid: p.cid!,
    customer: p.customer!,
    tier: p.tier as Tier,
    seats: p.seats!,
    sections: p.sections!.filter((s): s is LicensedSection => (SECTIONS as readonly string[]).includes(s)),
    features: p.features!.filter((f): f is Feature => f in FEATURES),
    modelMode: p.modelMode === "managed" ? "managed" : "self",
    workspaceLimit: typeof p.workspaceLimit === "number" ? p.workspaceLimit : null,
    branding: p.branding ?? null,
    checkInHours: typeof p.checkInHours === "number" && p.checkInHours > 0 ? p.checkInHours : 24,
    iat: p.iat!,
    exp: p.exp!,
  };
}

/* ───────────── What a license allows right now ───────────── */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** After expiry: full function for this long (with a warning), then users are stopped. */
export const EXPIRY_GRACE_DAYS = 14;
/** Without a successful check-in: full function, then a warning, then admin changes are blocked. */
export const CHECK_IN_WARN_DAYS = 14;
export const CHECK_IN_LOCK_DAYS = 30;

export type LicenseState =
  | "development" // no license and no public key configured: dev/demo installs
  | "missing" // a license is required but none has been entered
  | "invalid"
  | "valid"
  | "check_in_overdue" // works, with a warning
  | "admin_locked" // check-in missing too long: people can work, admin changes are blocked
  | "expiring_grace" // expired, still working for a short grace period
  | "expired"
  | "revoked";

export interface LicenseStatus {
  state: LicenseState;
  /** People can sign in and use the product. */
  canUse: boolean;
  /** Admins can change settings (except entering a new license, which always works). */
  canAdmin: boolean;
  /** A short message for admins (and, when `canUse` is false, for everyone). */
  message: string | null;
  daysLeft: number | null;
}

export function evaluateLicense(input: {
  claims: LicenseClaims | null;
  required: boolean;
  invalid?: boolean;
  revoked?: boolean;
  lastCheckInAt: Date | null;
  now?: Date;
}): LicenseStatus {
  const now = (input.now ?? new Date()).getTime();
  const c = input.claims;
  if (!c) {
    if (input.invalid) return { state: "invalid", canUse: false, canAdmin: true, message: "The license key isn't valid. Enter a new key in Admin → License.", daysLeft: null };
    if (!input.required) return { state: "development", canUse: true, canAdmin: true, message: null, daysLeft: null };
    return { state: "missing", canUse: false, canAdmin: true, message: "Enter your license key in Admin → License to start using Aatmiq.", daysLeft: null };
  }
  if (input.revoked) return { state: "revoked", canUse: false, canAdmin: true, message: "This license was revoked. Contact Aatmiq to restore access.", daysLeft: null };

  const exp = c.exp * 1000;
  if (now >= exp) {
    const stopAt = exp + EXPIRY_GRACE_DAYS * DAY_MS;
    if (now < stopAt) {
      const daysLeft = Math.ceil((stopAt - now) / DAY_MS);
      return {
        state: "expiring_grace",
        canUse: true,
        canAdmin: true,
        message: `The license expired. Aatmiq stops working in ${daysLeft} day${daysLeft === 1 ? "" : "s"} unless it is renewed.`,
        daysLeft,
      };
    }
    return { state: "expired", canUse: false, canAdmin: true, message: "The license has expired. Enter a renewed key in Admin → License.", daysLeft: 0 };
  }

  const last = (input.lastCheckInAt?.getTime() ?? c.iat * 1000) + c.checkInHours * 3600_000;
  const overdueDays = (now - last) / DAY_MS;
  const daysToExpiry = Math.ceil((exp - now) / DAY_MS);
  if (overdueDays > CHECK_IN_LOCK_DAYS)
    return {
      state: "admin_locked",
      canUse: true,
      canAdmin: false,
      message: "This server hasn't reached the Aatmiq license server for over 30 days. Admin changes are paused until it checks in.",
      daysLeft: daysToExpiry,
    };
  if (overdueDays > CHECK_IN_WARN_DAYS)
    return {
      state: "check_in_overdue",
      canUse: true,
      canAdmin: true,
      message: `This server hasn't reached the Aatmiq license server for ${Math.floor(overdueDays)} days. Allow outbound HTTPS to it to avoid interruptions.`,
      daysLeft: daysToExpiry,
    };
  return {
    state: "valid",
    canUse: true,
    canAdmin: true,
    message: daysToExpiry <= 30 ? `The license renews or expires in ${daysToExpiry} day${daysToExpiry === 1 ? "" : "s"}.` : null,
    daysLeft: daysToExpiry,
  };
}

export function hasFeature(claims: LicenseClaims | null, feature: Feature, state: LicenseState): boolean {
  if (state === "development") return true;
  return !!claims?.features.includes(feature);
}

export function hasSection(claims: LicenseClaims | null, section: LicensedSection, state: LicenseState): boolean {
  if (state === "development") return true;
  return !!claims?.sections.includes(section);
}
