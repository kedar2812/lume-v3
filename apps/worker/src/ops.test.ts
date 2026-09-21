import { describe, expect, it, vi } from "vitest";
import { makeOpsJobs, type Exec } from "./ops";

const now = new Date("2026-09-21T12:00:00Z");
const base = { remote: "offsite:/b", scriptsDir: "/app/scripts", env: { X: "1" }, now: () => now };

describe("ops.backup", () => {
  it("dumps, lists the remote, and deletes only what retention selects", async () => {
    const calls: string[][] = [];
    const exec: Exec = vi.fn(async (file, args) => {
      calls.push([file, ...args]);
      if (file === "rclone" && args[0] === "lsf") {
        // Today's backup + the 1st of each of the last 6 months fill the 4 weekly and 6 monthly slots,
        // so the January 2025 backup is the only one retention may drop.
        const monthly = ["09", "08", "07", "06", "05", "04"].map((m) => `lume-2026${m}01T0000Z.dump.age`);
        return (
          ["lume-20250101T0000Z.dump.age", "lume-20260921T1200Z.dump.age", ...monthly, "notes.txt"].join(
            "\n",
          ) + "\n"
        );
      }
      return '{"backup":"lume-20260921T1200Z.dump.age","bytes":10}\n';
    });
    const jobs = makeOpsJobs({ ...base, exec, recordRestoreTest: vi.fn() });
    const res = await jobs.backup();
    expect(res).toEqual({
      name: "lume-20260921T1200Z.dump.age",
      bytes: 10,
      deleted: ["lume-20250101T0000Z.dump.age"],
    });
    expect(calls[0]?.[0]).toBe("/app/scripts/backup.sh");
    expect(calls).toContainEqual(["rclone", "deletefile", "offsite:/b/lume-20250101T0000Z.dump.age"]);
    expect(calls.some((c) => c.includes("offsite:/b/notes.txt"))).toBe(false);
  });
});

describe("ops.restore-test", () => {
  it("records a passing result", async () => {
    const record = vi.fn();
    const exec: Exec = async () =>
      '{"ok":true,"backup":"lume-20260921T1200Z.dump.age","migrations":4,"tables":9}\n';
    await makeOpsJobs({ ...base, exec, recordRestoreTest: record }).restoreTest();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        backupName: "lume-20260921T1200Z.dump.age",
        details: { migrations: 4, tables: 9 },
      }),
    );
  });

  it("records a failure and rethrows so pg-boss retries", async () => {
    const record = vi.fn();
    const exec: Exec = async () => {
      throw Object.assign(new Error("restore failed"), {
        stdout: '{"ok":false,"error":"pg_restore failed"}\n',
      });
    };
    await expect(makeOpsJobs({ ...base, exec, recordRestoreTest: record }).restoreTest()).rejects.toThrow(
      /restore failed/,
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, details: { error: "pg_restore failed" } }),
    );
  });
});
