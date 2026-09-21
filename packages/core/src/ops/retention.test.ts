import { describe, expect, it } from "vitest";
import { backupName, parseBackupTime, selectBackupsToDelete } from "./retention";

const now = new Date("2026-09-21T12:00:00Z");
const H = 3_600_000;
const at = (msAgo: number) => backupName(new Date(now.getTime() - msAgo));

describe("backupName / parseBackupTime", () => {
  it("round-trips at minute precision in UTC", () => {
    const n = backupName(new Date("2026-09-21T06:05:59Z"));
    expect(n).toBe("lume-20260921T0605Z.dump.age");
    expect(parseBackupTime(n)?.toISOString()).toBe("2026-09-21T06:05:00.000Z");
    expect(parseBackupTime("notes.txt")).toBeNull();
  });
});

describe("selectBackupsToDelete (7 daily-ish days, 4 weekly, 6 monthly)", () => {
  it("keeps every 6-hourly backup from the last 7 days", () => {
    const names = Array.from({ length: 28 }, (_, i) => at(i * 6 * H));
    expect(selectBackupsToDelete(names, now)).toEqual([]);
  });

  it("keeps only the newest backup of each older week, for 4 weeks", () => {
    const week2 = [at(9 * 24 * H), at(9 * 24 * H + 6 * H), at(10 * 24 * H)]; // same ISO week
    const del = selectBackupsToDelete([at(0), ...week2], now);
    expect(del.sort()).toEqual([week2[1], week2[2]].sort());
  });

  it("keeps the newest backup per month for 6 months, deletes older", () => {
    const monthly = Array.from({ length: 10 }, (_, i) =>
      backupName(new Date(Date.UTC(2026, 8 - i, 1, 0, 0))),
    );
    const del = selectBackupsToDelete(monthly, now);
    // 1st of Sep 2026 … Dec 2025. Weekly keeps Sep–Jun (4 newest weeks that have a backup);
    // monthly keeps Sep–Apr (6 newest months). Mar, Feb, Jan 2026 and Dec 2025 go.
    expect(del).toEqual(monthly.slice(6));
  });

  it("never deletes files it does not recognise", () => {
    expect(selectBackupsToDelete(["README", "lume-bad.dump.age"], now)).toEqual([]);
  });
});
