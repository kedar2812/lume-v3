import type { FleetHealth } from "@lume/core";
import { describe, expect, it } from "vitest";
import { fleetStatus, problemsOf } from "./fleet";

const now = new Date("2026-10-16T12:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
const well: FleetHealth = {
  uptimeS: 86_400,
  dbBytes: 400_000_000,
  diskFreePct: 40,
  errors24h: 0,
  queue: { waiting: 1, retrying: 0, failed24h: 0 },
  remindersLate: 0,
  restoreTest: { at: ago(30), ok: true },
  problems: [],
  sourcesNeedingAttention: 0,
};
const keys = (h: FleetHealth) => problemsOf(h, now).map((p) => p.key);

describe("problemsOf (spec 2026-10-16 fleet §2.2)", () => {
  it("finds nothing in a healthy LUME", () => {
    expect(problemsOf(well, now)).toEqual([]);
  });
  it("disk: amber under 15%, red under 5%, nothing at 15%", () => {
    expect(keys({ ...well, diskFreePct: 15 })).toEqual([]);
    expect(problemsOf({ ...well, diskFreePct: 14 }, now)[0]).toMatchObject({
      key: "disk",
      severity: "amber",
      short: "Disk filling",
    });
    expect(problemsOf({ ...well, diskFreePct: 4 }, now)[0]).toMatchObject({
      key: "disk",
      severity: "red",
      short: "Disk almost full",
    });
    expect(problemsOf({ ...well, diskFreePct: 4 }, now)[0]!.words).toMatch(
      /^The server’s disk is almost full: 4% free\./,
    );
    expect(keys({ ...well, diskFreePct: null })).toEqual([]);
  });
  it("failed jobs, from the count or the key, once", () => {
    expect(problemsOf({ ...well, queue: { ...well.queue, failed24h: 3 } }, now)[0]!.words).toMatch(
      /^3 background jobs failed/,
    );
    expect(keys({ ...well, problems: ["jobs_failed"], queue: { ...well.queue, failed24h: 1 } })).toEqual([
      "jobs_failed",
    ]);
  });
  it("errors: 20 or more in a day", () => {
    expect(keys({ ...well, errors24h: 19 })).toEqual([]);
    expect(keys({ ...well, errors24h: 20 })).toEqual(["errors"]);
  });
  it("the restore test: failed, or older than 8 days; none yet on a new install is nothing", () => {
    expect(keys({ ...well, restoreTest: { at: ago(30), ok: false } })).toEqual(["restore_test"]);
    expect(keys({ ...well, restoreTest: { at: ago(8 * 24 + 1), ok: true } })).toEqual(["restore_test"]);
    expect(keys({ ...well, restoreTest: { at: ago(8 * 24 - 1), ok: true } })).toEqual([]);
    expect(keys({ ...well, restoreTest: null })).toEqual([]);
  });
  it("every problem key LUME sends has its own words, saying what to do", () => {
    const all = problemsOf(
      {
        ...well,
        problems: [
          "reminders_late",
          "sweeper_stopped",
          "jobs_unreadable",
          "digest_failing",
          "source",
          "restore_test",
        ],
        sourcesNeedingAttention: 2,
      },
      now,
    );
    expect(all.map((p) => p.key)).toEqual([
      "reminders_late",
      "sweeper_stopped",
      "jobs_unreadable",
      "digest_failing",
      "source",
      "restore_test",
    ]);
    for (const p of all) expect(p.words).toMatch(/\.$/);
    expect(all.find((p) => p.key === "source")!.words).toMatch(/^2 lead sources need attention/);
  });
  it("red ones come first", () => {
    expect(keys({ ...well, problems: ["reminders_late"], diskFreePct: 3 })).toEqual([
      "disk",
      "reminders_late",
    ]);
  });
});

describe("fleetStatus", () => {
  it("down after 24 hours of silence, whatever its last health said", () => {
    expect(fleetStatus({ lastCheckInAt: ago(25), health: well }, now)).toBe("down");
    expect(fleetStatus({ lastCheckInAt: ago(23), health: well }, now)).toBe("ok");
  });
  it("no health yet on an older LUME; needs a look with any problem; never checked in is null", () => {
    expect(fleetStatus({ lastCheckInAt: ago(2), health: null }, now)).toBe("none");
    expect(fleetStatus({ lastCheckInAt: ago(2), health: { ...well, diskFreePct: 10 } }, now)).toBe("look");
    expect(fleetStatus({ lastCheckInAt: null, health: null }, now)).toBeNull();
  });
});
