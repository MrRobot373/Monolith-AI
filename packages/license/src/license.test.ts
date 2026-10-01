import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  evaluateLicense,
  generateSigningKeys,
  importPrivateKey,
  importPublicKey,
  LicenseError,
  publicKeyOneLine,
  signLicense,
  TIERS,
  verifyLicense,
  type LicenseTerms,
} from "./index";

const terms: LicenseTerms = {
  lid: "lic_1",
  cid: "cus_1",
  customer: "Acme Labs",
  tier: "work",
  seats: 25,
  sections: [...TIERS.work.sections],
  features: [...TIERS.work.features],
  modelMode: "self",
  workspaceLimit: 10,
  branding: { accent: "#22D3EE" },
  checkInHours: 24,
};

describe("license keys", () => {
  it("signs and verifies offline, including a one-line public key", async () => {
    const keys = await generateSigningKeys();
    const token = await signLicense(terms, { privateKey: await importPrivateKey(keys.privatePem), kid: "k1", expiresAt: new Date(Date.now() + 365 * DAY_MS) });
    const claims = await verifyLicense(token, await importPublicKey(publicKeyOneLine(keys.publicPem)));
    expect(claims).toMatchObject({ lid: "lic_1", seats: 25, tier: "work", sections: ["chat", "work"] });
  });

  it("rejects keys signed by someone else, tampered keys and junk", async () => {
    const ours = await generateSigningKeys();
    const theirs = await generateSigningKeys();
    const forged = await signLicense({ ...terms, seats: 9999 }, { privateKey: await importPrivateKey(theirs.privatePem), kid: "x", expiresAt: new Date(Date.now() + DAY_MS) });
    const pub = await importPublicKey(ours.publicPem);
    await expect(verifyLicense(forged, pub)).rejects.toMatchObject({ reason: "signature" });
    const good = await signLicense(terms, { privateKey: await importPrivateKey(ours.privatePem), kid: "k", expiresAt: new Date(Date.now() + DAY_MS) });
    const [h, p, s] = good.split(".");
    const tampered = [h, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), seats: 9999 })).toString("base64url"), s].join(".");
    await expect(verifyLicense(tampered, pub)).rejects.toBeInstanceOf(LicenseError);
    await expect(verifyLicense("hello", pub)).rejects.toMatchObject({ reason: "malformed" });
  });

  it("still verifies an expired key (grace is decided separately)", async () => {
    const keys = await generateSigningKeys();
    const token = await signLicense(terms, { privateKey: await importPrivateKey(keys.privatePem), kid: "k", issuedAt: new Date(Date.now() - 400 * DAY_MS), expiresAt: new Date(Date.now() - DAY_MS) });
    const c = await verifyLicense(token, await importPublicKey(keys.publicPem));
    expect(c.exp * 1000).toBeLessThan(Date.now());
  });
});

describe("evaluateLicense", () => {
  const now = new Date("2026-10-01T00:00:00Z");
  const at = (days: number) => Math.floor((now.getTime() + days * DAY_MS) / 1000);
  const claims = { ...terms, iat: at(-10), exp: at(200) };

  it("development mode without a license or key", () => {
    expect(evaluateLicense({ claims: null, required: false, lastCheckInAt: null, now }).state).toBe("development");
    const missing = evaluateLicense({ claims: null, required: true, lastCheckInAt: null, now });
    expect(missing).toMatchObject({ state: "missing", canUse: false, canAdmin: true });
  });

  it("valid, then warns, then locks admin changes when check-ins stop", () => {
    const day = (d: number) => new Date(now.getTime() - d * DAY_MS);
    expect(evaluateLicense({ claims, required: true, lastCheckInAt: day(2), now }).state).toBe("valid");
    expect(evaluateLicense({ claims, required: true, lastCheckInAt: day(20), now })).toMatchObject({ state: "check_in_overdue", canUse: true, canAdmin: true });
    expect(evaluateLicense({ claims, required: true, lastCheckInAt: day(40), now })).toMatchObject({ state: "admin_locked", canUse: true, canAdmin: false });
  });

  it("gives 14 days of grace after expiry, then stops", () => {
    const grace = evaluateLicense({ claims: { ...claims, exp: at(-3) }, required: true, lastCheckInAt: now, now });
    expect(grace).toMatchObject({ state: "expiring_grace", canUse: true, daysLeft: 11 });
    expect(evaluateLicense({ claims: { ...claims, exp: at(-15) }, required: true, lastCheckInAt: now, now })).toMatchObject({ state: "expired", canUse: false });
  });

  it("revoked stops at once; renewal notice in the last 30 days", () => {
    expect(evaluateLicense({ claims, required: true, revoked: true, lastCheckInAt: now, now }).canUse).toBe(false);
    expect(evaluateLicense({ claims: { ...claims, exp: at(12) }, required: true, lastCheckInAt: now, now }).message).toContain("12 days");
  });
});
