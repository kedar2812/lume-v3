import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

describe("ops.backup with WhatsApp's files (2026-10-19)", () => {
  const filesDb = (record = vi.fn()) => ({
    salt: async () => "salt",
    goneBefore: async () => [],
    forgetGone: async () => undefined,
    record,
  });
  it("the files go after the dump; a failed file sync is reported, and the dump still stands", async () => {
    const calls: string[] = [];
    const exec: Exec = vi.fn(async (file, args) => {
      calls.push(`${file} ${args[0] ?? ""}`);
      if (file === "rclone" && args[0] === "lsf" && args[2] === "offsite:/b/files")
        throw Object.assign(new Error("network down"), { code: 1 });
      if (file === "rclone" && args[0] === "lsf") return "";
      return '{"backup":"lume-20260921T1200Z.dump.age","bytes":10}\n';
    });
    const dir = await mkdtemp(path.join(tmpdir(), "lume-ops-"));
    await mkdir(path.join(dir, "aa"));
    await writeFile(path.join(dir, "aa", "a".repeat(64)), "x");
    const record = vi.fn();
    const res = await makeOpsJobs({
      ...base,
      exec,
      recordRestoreTest: vi.fn(),
      files: { db: filesDb(record), filesDir: dir, recipients: ["age1a", "age1b"], tmpDir: dir },
    }).backup();
    expect(calls[0]).toBe("/app/scripts/backup.sh ");
    expect(calls.indexOf("rclone lsf")).toBeLessThan(calls.lastIndexOf("rclone lsf"));
    expect(res).toMatchObject({ name: "lume-20260921T1200Z.dump.age", files: { error: "network down" } });
    expect(record).toHaveBeenCalledWith(false, { error: "LUME couldn't list the backup's files." });
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
