/**
 * License client: verifies the key offline with Aatmiq's public key, checks in daily with counts only
 * (seats, token totals per section, version, health), and answers "what does the license allow?".
 * Nothing a user typed or uploaded ever leaves this server.
 */
import {
  evaluateLicense,
  hasFeature as licenseHasFeature,
  hasSection as licenseHasSection,
  importPublicKey,
  verifyLicense,
  type Feature,
  type LicenseClaims,
  type LicensedSection,
  type LicenseStatus,
} from "@aatmiq/license";
import { and, eq, gt, invitation, isNull, licenseState, organization, sql, user, usageEvent, workspace, type DB } from "@aatmiq/db";
import { randomUUID } from "node:crypto";
import type { Config } from "../config";
import { HttpError } from "../errors";

export interface LicenseInfo {
  claims: LicenseClaims | null;
  status: LicenseStatus;
  /** True when a public key is configured, so a license is required. */
  required: boolean;
  state: typeof licenseState.$inferSelect | null;
}

type PublicKey = Awaited<ReturnType<typeof importPublicKey>>;

export class LicenseService {
  private key: Promise<PublicKey> | null;
  private verified = new Map<string, Promise<LicenseClaims | null>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private cfg: Config,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.key = cfg.licensePublicKey ? importPublicKey(cfg.licensePublicKey) : null;
  }

  get required() {
    return !!this.key;
  }

  /** Verify a key with our public key. Returns null for anything invalid. */
  async verify(token: string): Promise<LicenseClaims | null> {
    if (!this.key) return null;
    let p = this.verified.get(token);
    if (!p) {
      p = this.key.then((k) => verifyLicense(token, k)).catch(() => null);
      this.verified.set(token, p);
      if (this.verified.size > 20) this.verified.delete(this.verified.keys().next().value!);
    }
    return p;
  }

  /** Throws a friendly error if the key isn't valid. */
  async verifyOrThrow(token: string): Promise<LicenseClaims> {
    if (!this.key) throw new HttpError(400, "This server isn't set up for license keys (no public key is configured).", "license_not_required");
    try {
      return await verifyLicense(token, await this.key);
    } catch (e) {
      throw new HttpError(400, (e as Error).message || "That license key isn't valid.", "invalid_license");
    }
  }

  async state() {
    const [s] = await this.db.select().from(licenseState).where(eq(licenseState.id, "current"));
    if (s) return s;
    const [created] = await this.db.insert(licenseState).values({ id: "current", instanceId: randomUUID() }).onConflictDoNothing().returning();
    return created ?? (await this.db.select().from(licenseState).where(eq(licenseState.id, "current")))[0]!;
  }

  async info(now = new Date()): Promise<LicenseInfo> {
    const [org] = await this.db.select({ key: organization.licenseKey }).from(organization).limit(1);
    const token = org?.key ?? null;
    const claims = token ? await this.verify(token) : null;
    const state = this.required ? await this.state() : null;
    const status = evaluateLicense({
      claims,
      required: this.required,
      invalid: !!token && !claims && this.required,
      revoked: state?.revoked,
      lastCheckInAt: state?.lastCheckInAt ?? null,
      now,
    });
    return { claims, status, required: this.required, state };
  }

  async hasFeature(feature: Feature) {
    const { claims, status } = await this.info();
    return licenseHasFeature(claims, feature, status.state);
  }

  async hasSection(section: LicensedSection) {
    const { claims, status } = await this.info();
    return licenseHasSection(claims, section, status.state);
  }

  /** Install a new key (setup or Admin → License). */
  async install(token: string): Promise<LicenseClaims> {
    const claims = await this.verifyOrThrow(token);
    const [org] = await this.db.select({ id: organization.id }).from(organization).limit(1);
    if (org) await this.db.update(organization).set({ licenseKey: token.trim() }).where(eq(organization.id, org.id));
    const s = await this.state();
    // A different license starts fresh; the same license re-entered keeps its check-in history.
    const prev = org ? await this.currentLid() : null;
    await this.db
      .update(licenseState)
      .set({ revoked: false, lastError: null, ...(prev && prev !== claims.lid ? { lastCheckInAt: null } : {}) })
      .where(eq(licenseState.id, s.id));
    return claims;
  }

  private async currentLid() {
    const [org] = await this.db.select({ key: organization.licenseKey }).from(organization).limit(1);
    return org?.key ? (await this.verify(org.key))?.lid ?? null : null;
  }

  /* ───────────── Seats & limits ───────────── */

  async seatsUsed() {
    const [{ active }] = (await this.db
      .select({ active: sql<number>`count(*)::int` })
      .from(user)
      .where(eq(user.status, "active"))) as [{ active: number }];
    const [{ pending }] = (await this.db
      .select({ pending: sql<number>`count(*)::int` })
      .from(invitation)
      .where(and(isNull(invitation.acceptedAt), isNull(invitation.revokedAt), gt(invitation.expiresAt, new Date())))) as [{ pending: number }];
    return { active, pending };
  }

  /** Before adding people (invite, SSO sign-up, reactivation). `extra` is how many seats the action takes. */
  async requireSeats(extra = 1, opts: { countPending?: boolean } = { countPending: true }) {
    const { claims, status } = await this.info();
    if (status.state === "development" || !claims) return;
    const { active, pending } = await this.seatsUsed();
    const used = active + (opts.countPending ? pending : 0);
    if (used + extra > claims.seats)
      throw new HttpError(
        402,
        `Your license covers ${claims.seats} people and ${used} ${used === 1 ? "seat is" : "seats are"} in use${opts.countPending && pending ? ` (including ${pending} pending invitation${pending === 1 ? "" : "s"})` : ""}. Ask Aatmiq for more seats.`,
        "seat_limit",
      );
  }

  async requireWorkspaceSlot() {
    const { claims, status } = await this.info();
    if (status.state === "development" || !claims?.workspaceLimit) return;
    const [{ n }] = (await this.db.select({ n: sql<number>`count(*)::int` }).from(workspace).where(isNull(workspace.archivedAt))) as [{ n: number }];
    if (n >= claims.workspaceLimit)
      throw new HttpError(402, `Your plan includes ${claims.workspaceLimit} workspaces. Archive one or upgrade to add more.`, "workspace_limit");
  }

  /* ───────────── Check-in ───────────── */

  async checkIn(): Promise<{ ok: boolean; error?: string }> {
    const [org] = await this.db.select({ key: organization.licenseKey }).from(organization).limit(1);
    if (!this.required || !org?.key || !this.cfg.licenseServerUrl) return { ok: false, error: "Check-ins are off" };
    const s = await this.state();
    const claims = await this.verify(org.key);
    const since = s.lastCheckInAt ?? (claims ? new Date(claims.iat * 1000) : new Date(0));
    const usage = (
      await this.db
        .select({
          section: usageEvent.section,
          inputTokens: sql<number>`coalesce(sum(${usageEvent.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${usageEvent.outputTokens}), 0)::int`,
          requests: sql<number>`count(*)::int`,
        })
        .from(usageEvent)
        .where(gt(usageEvent.createdAt, since))
        .groupBy(usageEvent.section)
    ).map((u) => ({ ...u, section: String(u.section) }));
    const { active } = await this.seatsUsed();
    const [{ workspaces }] = (await this.db.select({ workspaces: sql<number>`count(*)::int` }).from(workspace)) as [{ workspaces: number }];
    await this.db.update(licenseState).set({ lastAttemptAt: new Date() }).where(eq(licenseState.id, s.id));
    try {
      const res = await this.fetchImpl(new URL("/v1/check-in", this.cfg.licenseServerUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: org.key,
          instanceId: s.instanceId,
          version: this.cfg.version,
          activeSeats: active,
          usage,
          health: { workspaces, node: process.version, uptimeSeconds: Math.round(process.uptime()) },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        token?: string;
        release?: (typeof licenseState.$inferSelect)["release"];
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `License server answered ${res.status}`);
      if (body.status === "revoked") {
        await this.db.update(licenseState).set({ revoked: true, lastCheckInAt: new Date(), lastError: null }).where(eq(licenseState.id, s.id));
        return { ok: true };
      }
      // Accept a renewed key only if it is genuine and for the same license.
      if (body.token && body.token !== org.key) {
        const next = await this.verify(body.token);
        if (next && claims && next.lid === claims.lid) await this.db.update(organization).set({ licenseKey: body.token });
      }
      await this.db
        .update(licenseState)
        .set({ revoked: false, lastCheckInAt: new Date(), lastError: null, release: body.release ?? null })
        .where(eq(licenseState.id, s.id));
      return { ok: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : "Check-in failed";
      await this.db.update(licenseState).set({ lastError: error.slice(0, 300) }).where(eq(licenseState.id, s.id));
      return { ok: false, error };
    }
  }

  /** Check in when due (per the license's interval), and retry hourly after failures. */
  async checkInIfDue() {
    const { claims, state } = await this.info();
    if (!claims || !state) return;
    const due = !state.lastCheckInAt || Date.now() - state.lastCheckInAt.getTime() >= claims.checkInHours * 3600_000;
    if (due) await this.checkIn();
  }

  start() {
    if (!this.required || this.timer) return;
    const tick = () => void this.checkInIfDue().catch(() => {});
    tick();
    this.timer = setInterval(tick, 3600_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
