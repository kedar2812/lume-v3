import { describe, expect, it } from "vitest";
import type { PermissionKey, Scope } from "../rbac/catalog";
import type { Actor } from "../rbac/engine";
import { RULES, anomalySchema, breached, isWatched, mergeAnomaly, nearLimit, showsWatermark } from "./rules";

const person = (perms: [PermissionKey, Scope | true][] = [], isOwner = false): Actor => ({
  userId: "u",
  isOwner,
  perms: new Map(perms),
  teamMemberIds: [],
  twoFactorEnabled: false,
  roleIds: [],
});
const sales = person([["leads.contact.reveal", "own"]]);
const admin = person([["leads.contact.full", "all"]]);

describe("mergeAnomaly", () => {
  it("gives the report's three defaults when nothing is stored", () => {
    expect(mergeAnomaly({})).toEqual({
      reveals: { action: "suspend", threshold: 30 },
      leadsOpened: { action: "suspend", threshold: 200 },
      queueRuns: { action: "alert", threshold: 3 },
    });
    expect(mergeAnomaly(undefined)).toEqual(mergeAnomaly({}));
  });

  it("keeps a stored action and clamps its threshold to the rule's limits", () => {
    const m = mergeAnomaly({ reveals: { action: "alert", threshold: 2 }, leadsOpened: { threshold: 99999 } });
    expect(m.reveals).toEqual({ action: "alert", threshold: RULES.reveals.min });
    expect(m.leadsOpened).toEqual({ action: "suspend", threshold: RULES.leadsOpened.max });
  });

  it("falls back to the default for an action it doesn't know, or one the rule can't take", () => {
    const m = mergeAnomaly({ reveals: { action: "explode" }, queueRuns: { action: "suspend" } });
    expect(m.reveals.action).toBe("suspend");
    expect(m.queueRuns.action).toBe("alert");
  });
});

describe("what each rule counts", () => {
  it("contacts are counted per lead: revealing the same contact again isn't another (6A final review)", () => {
    expect(RULES.reveals.distinct).toBe(true);
    expect(RULES.leadsOpened.distinct).toBe(true);
    expect(RULES.queueRuns.distinct).toBe(false);
  });
});

describe("anomalySchema", () => {
  it("refuses a pause on the send-queue rule, which only ever tells admins", () => {
    const ok = mergeAnomaly({});
    expect(anomalySchema.safeParse(ok).success).toBe(true);
    expect(anomalySchema.safeParse({ ...ok, queueRuns: { action: "suspend", threshold: 3 } }).success).toBe(
      false,
    );
    expect(anomalySchema.safeParse({ ...ok, reveals: { action: "suspend", threshold: 3 } }).success).toBe(
      false,
    );
  });
});

describe("isWatched", () => {
  it("watches everyone who can't see every contact, and never the owner", () => {
    expect(isWatched(person([], true))).toBe(false);
    expect(isWatched(admin)).toBe(false);
    expect(isWatched(person([["leads.contact.full", "team"]]))).toBe(true);
    expect(isWatched(sales)).toBe(true);
    expect(isWatched(person())).toBe(true);
  });
});

describe("breached and nearLimit", () => {
  it("breaches only past the threshold: more than 30, not 30", () => {
    expect(breached(30, 30)).toBe(false);
    expect(breached(31, 30)).toBe(true);
  });

  it("is near the limit from 80% of it", () => {
    expect(nearLimit(24, 30)).toBe(true);
    expect(nearLimit(23, 30)).toBe(false);
    expect(nearLimit(160, 200)).toBe(true);
    expect(nearLimit(159, 200)).toBe(false);
  });
});

describe("showsWatermark", () => {
  it("marks people who can't see every contact by default", () => {
    expect(showsWatermark(undefined, sales)).toBe(true);
    expect(showsWatermark("masked_roles", admin)).toBe(false);
    expect(showsWatermark("masked_roles", person([], true))).toBe(false);
  });

  it("follows the setting: everyone, or nobody", () => {
    expect(showsWatermark("everyone", admin)).toBe(true);
    expect(showsWatermark("everyone", person([], true))).toBe(true);
    expect(showsWatermark("off", sales)).toBe(false);
  });
});
