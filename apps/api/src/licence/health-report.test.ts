import { describe, expect, it } from "vitest";
import type { Health } from "../modules/health/service";
import { ErrorWindow, healthReport, toFleetHealth } from "./health-report";

/** What a LUME tells its licence server about itself (spec 2026-10-16 fleet §1.1): counts and fixed keys only. */
const now = new Date("2026-10-16T12:00:00Z");
const read: Health = {
  checkedAt: now.toISOString(),
  followUps: { lastSweepAt: now.toISOString(), pending: 12, late: 2, firedToday: 30 },
  queue: { waiting: 4, active: 1, retrying: 0, failed24h: 3 },
  digest: { lastSentAt: null, sentToday: 0, failures24h: 0 },
  noTouch: { enabled: false, lastRunAt: null, createdToday: 0 },
  sources: [
    {
      id: "s1",
      name: "Instagram leads — Dubai",
      type: "google_sheet",
      status: "needs_attention",
      lastSyncAt: null,
    },
  ],
  restoreTest: { at: "2026-10-14T03:15:00.000Z", ok: true },
  problems: [
    { key: "reminders_late", words: "2 reminders are late." },
    { key: "jobs_failed", words: "3 background jobs failed." },
    { key: "source:s1", words: "Instagram leads — Dubai needs attention. Open Integrations." },
    { key: "source:s2", words: "Website form needs attention." },
  ],
};

describe("toFleetHealth", () => {
  it("keeps counts and problem keys, and never a source's name", () => {
    const h = toFleetHealth(read, { uptimeS: 3600, dbBytes: 5e8, diskFreePct: 38, errors24h: 1 });
    expect(h).toEqual({
      uptimeS: 3600,
      dbBytes: 500_000_000,
      diskFreePct: 38,
      errors24h: 1,
      queue: { waiting: 4, retrying: 0, failed24h: 3 },
      remindersLate: 2,
      restoreTest: { at: "2026-10-14T03:15:00.000Z", ok: true },
      problems: ["reminders_late", "jobs_failed", "source"],
      sourcesNeedingAttention: 2,
    });
    expect(JSON.stringify(h)).not.toMatch(/Instagram|Website|Dubai/);
  });
  it("says no restore test when there's been none", () => {
    expect(
      toFleetHealth(
        { ...read, restoreTest: { at: null, ok: null } },
        { uptimeS: 1, dbBytes: 1, diskFreePct: null, errors24h: 0 },
      ).restoreTest,
    ).toBeNull();
  });
});

describe("healthReport", () => {
  it("is null, never a throw, when the database can't be read", async () => {
    const broken = { query: () => Promise.reject(new Error("gone")) };
    expect(await healthReport(broken as never, { now, startedAt: now, errors24h: 0 })).toBeNull();
  });
});

describe("ErrorWindow", () => {
  it("counts server errors in the last 24 hours, by the hour", () => {
    const w = new ErrorWindow();
    const at = (h: number) => new Date(now.getTime() - h * 3_600_000);
    w.add(at(30));
    w.add(at(23.5));
    w.add(at(2));
    w.add(at(0));
    expect(w.count(now)).toBe(3);
    expect(w.count(new Date(now.getTime() + 24 * 3_600_000))).toBe(1);
  });
});
