import { describe, expect, it } from "vitest";
import {
  modelUpdateSchema,
  defaultUserQuota,
  evaluateQuota,
  formatTokens,
  orgCan,
  periodEnd,
  periodStart,
  workspaceCan,
} from "./index";

describe("permissions", () => {
  it("owner can manage license, admin cannot", () => {
    expect(orgCan("owner", "org.license.manage")).toBe(true);
    expect(orgCan("admin", "org.license.manage")).toBe(false);
    expect(orgCan("admin", "org.users.invite")).toBe(true);
  });
  it("members cannot invite to the org (D18)", () => {
    expect(orgCan("member", "org.users.invite")).toBe(false);
  });
  it("workspace admins manage their workspace only", () => {
    expect(workspaceCan("member", "admin", "workspace.requests.decide")).toBe(true);
    expect(workspaceCan("member", "member", "workspace.requests.decide")).toBe(false);
    expect(workspaceCan("member", null, "workspace.use")).toBe(false);
  });
  it("org admins hold every workspace capability", () => {
    expect(workspaceCan("admin", null, "workspace.members.manage")).toBe(true);
  });
});

describe("periods", () => {
  const now = new Date("2026-09-30T15:00:00Z"); // Wednesday
  it("computes day/week/month starts", () => {
    expect(periodStart("day", now).toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(periodStart("week", now).toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(periodStart("month", now).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(periodEnd("month", now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("quota", () => {
  it("splits workspace budget evenly (D19)", () => {
    expect(defaultUserQuota(1_000_000, 3)).toBe(333_333);
    expect(defaultUserQuota(null, 3)).toBeNull();
    expect(defaultUserQuota(100, 0)).toBe(100);
  });
  it("allows when unlimited", () => {
    const r = evaluateQuota({
      userLimit: null, userBonus: 0, userUsed: 999,
      workspaceLimit: null, workspaceBonus: 0, workspaceUsed: 999,
    });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBeNull();
  });
  it("blocks on the most restrictive level", () => {
    const r = evaluateQuota({
      userLimit: 100, userBonus: 0, userUsed: 100,
      workspaceLimit: 10_000, workspaceBonus: 0, workspaceUsed: 100,
    });
    expect(r).toMatchObject({ allowed: false, blockedBy: "user", remaining: 0 });
  });
  it("counts approved bonus tokens", () => {
    const r = evaluateQuota({
      userLimit: 100, userBonus: 50, userUsed: 120,
      workspaceLimit: null, workspaceBonus: 0, workspaceUsed: 0,
    });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(30);
    expect(r.warning).toBe("80");
  });
  it("workspace exhaustion blocks everyone", () => {
    const r = evaluateQuota({
      userLimit: 1000, userBonus: 0, userUsed: 10,
      workspaceLimit: 500, workspaceBonus: 0, workspaceUsed: 500,
    });
    expect(r.blockedBy).toBe("workspace");
  });
  it("formats token counts", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(null)).toBe("Unlimited");
  });
});

describe("update schemas", () => {
  it("partial model updates do not reset other fields", () => {
    expect(modelUpdateSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(modelUpdateSchema.parse({ sections: ["chat"] })).toEqual({ sections: ["chat"] });
  });
});
