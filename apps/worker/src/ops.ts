import path from "node:path";
import { backupName, selectBackupsToDelete } from "@lume/core";
import type { Exec } from "./exec";

export type { Exec } from "./exec";
export type BackupResult = { name: string; bytes: number; deleted: string[] };
export type RestoreTestResult = {
  startedAt: Date;
  finishedAt: Date;
  backupName: string;
  ok: boolean;
  details: Record<string, unknown>;
};
export type OpsJobs = { backup(): Promise<BackupResult>; restoreTest(): Promise<void> };

export type OpsDeps = {
  exec: Exec;
  /** rclone remote path, e.g. offsite:/var/lib/lume/offsite */
  remote: string;
  scriptsDir: string;
  /** Environment passed to the scripts (DB URLs, age recipients/identity, rclone config). */
  env: Record<string, string>;
  now: () => Date;
  recordRestoreTest: (r: RestoreTestResult) => Promise<void>;
};

function lastJsonLine(out: string): Record<string, unknown> {
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { error: "unparseable script output" };
  }
}

export function makeOpsJobs(d: OpsDeps): OpsJobs {
  return {
    async backup() {
      const name = backupName(d.now());
      const out = lastJsonLine(
        await d.exec(path.join(d.scriptsDir, "backup.sh"), [], {
          ...d.env,
          RCLONE_REMOTE: d.remote,
          BACKUP_NAME: name,
        }),
      );
      const listing = await d.exec("rclone", ["lsf", "--files-only", d.remote], d.env);
      const deleted = selectBackupsToDelete(
        listing
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        d.now(),
      );
      for (const n of deleted) await d.exec("rclone", ["deletefile", `${d.remote}/${n}`], d.env);
      return { name, bytes: Number(out.bytes ?? 0), deleted };
    },
    async restoreTest() {
      const startedAt = d.now();
      let out: Record<string, unknown>;
      let failure: unknown = null;
      try {
        out = lastJsonLine(
          await d.exec(path.join(d.scriptsDir, "restore-test.sh"), [], { ...d.env, RCLONE_REMOTE: d.remote }),
        );
      } catch (e) {
        failure = e;
        out = lastJsonLine(String((e as { stdout?: string }).stdout ?? ""));
      }
      const { ok, backup, ...details } = out;
      await d.recordRestoreTest({
        startedAt,
        finishedAt: d.now(),
        backupName: typeof backup === "string" ? backup : "(none)",
        ok: failure === null && ok === true,
        details,
      });
      if (failure) throw failure;
      if (ok !== true) throw new Error(`restore test failed: ${JSON.stringify(details)}`);
    },
  };
}
