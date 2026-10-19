import { createHmac, randomBytes } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Exec } from "./exec";

/** A file gone from the server keeps its off-site copy this long: the oldest kept dump (6 monthly) still points at it. */
export const GONE_DAYS = 200;
/** One run's share of a big first copy; the next run (6 hours later) goes on where it stopped. */
const BUDGET_MS = 30 * 60_000;
const HASH = /^[0-9a-f]{64}$/;

/** What the sync needs from the database (as lume_worker): the naming salt, the files that went, and a record. */
export type FilesDb = {
  salt(): Promise<string>;
  goneBefore(at: Date): Promise<string[]>;
  forgetGone(sha256: string): Promise<void>;
  record(ok: boolean, detail: Record<string, unknown>): Promise<void>;
};
export type FilesResult = { uploaded: number; bytes: number; left: number; pruned: number; failed?: number };

/**
 * A file's name off-site: HMAC(salt, its hash). Someone who can list the backup remote and holds a candidate file
 * can't tell from the names whether this client had it. A restore needs no map: a decrypted file's own hash is its name.
 */
export const offsiteName = (salt: string, sha256: string) =>
  `${createHmac("sha256", salt).update(sha256).digest("hex")}.age`;

/** Every file under the folder, with its size; null when there's no folder (an old compose, the demo). */
async function localFiles(dir: string): Promise<{ sha256: string; path: string; size: number }[] | null> {
  const top = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (!top) return null;
  const out: { sha256: string; path: string; size: number }[] = [];
  for (const d of top) {
    if (!d.isDirectory() || !/^[0-9a-f]{2}$/.test(d.name)) continue;
    for (const f of await readdir(path.join(dir, d.name), { withFileTypes: true })) {
      if (!f.isFile() || !HASH.test(f.name) || !f.name.startsWith(d.name)) continue; // temp files, anything else
      const p = path.join(dir, d.name, f.name);
      const s = await stat(p).catch(() => null);
      if (s) out.push({ sha256: f.name, path: p, size: s.size });
    }
  }
  return out.sort((a, b) => a.sha256.localeCompare(b.sha256));
}

/**
 * WhatsApp's files off-site (2026-10-19), after each database backup: every file the remote doesn't have yet goes,
 * encrypted to the same age keys as the dumps, under its salted name in `files/`. So each file goes once, not inside
 * every dump. Then files gone from the server for 200 days leave the remote.
 *
 * - The listing failing is the sync failing (recorded, thrown); the dump already went, and stays.
 * - One file that won't go is counted and tried next time; the rest still go.
 * - A big first copy stops at its budget, and says how many are left.
 */
export async function syncFiles(o: {
  exec: Exec;
  db: FilesDb;
  remote: string;
  recipients: string[];
  filesDir: string;
  tmpDir: string;
  env: Record<string, string>;
  now: () => Date;
  budgetMs?: number;
}): Promise<FilesResult> {
  const started = o.now().getTime();
  const salt = await o.db.salt();
  const local = await localFiles(o.filesDir);
  let uploaded = 0;
  let bytes = 0;
  let left = 0;
  let failed = 0;
  if (local?.length) {
    let remote: Set<string>;
    try {
      const listing = await o.exec("rclone", ["lsf", "--files-only", `${o.remote}/files`], o.env);
      remote = new Set(
        listing
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      );
    } catch (e) {
      // rclone says 3 for a folder that isn't there yet: nothing has gone off-site so far.
      if ((e as { code?: unknown }).code !== 3) {
        await o.db.record(false, { error: "LUME couldn't list the backup's files." });
        throw e;
      }
      remote = new Set();
    }
    const missing = local.filter((f) => !remote.has(offsiteName(salt, f.sha256)));
    const keys = o.recipients.flatMap((r) => ["-r", r]);
    for (const [i, f] of missing.entries()) {
      if (o.now().getTime() - started >= (o.budgetMs ?? BUDGET_MS)) {
        left = missing.length - i;
        break;
      }
      const sealed = path.join(o.tmpDir, `lume-file-${randomBytes(8).toString("hex")}.age`);
      try {
        await o.exec("age", [...keys, "-o", sealed, f.path], o.env);
        // copyto checks the size (and the hash, where the remote can) once it's there: no half-copied file.
        await o.exec("rclone", ["copyto", sealed, `${o.remote}/files/${offsiteName(salt, f.sha256)}`], o.env);
        uploaded++;
        bytes += f.size;
      } catch {
        failed++;
      } finally {
        await rm(sealed, { force: true });
      }
    }
  }
  let pruned = 0;
  for (const sha256 of await o.db.goneBefore(new Date(o.now().getTime() - GONE_DAYS * 86_400_000))) {
    const name = offsiteName(salt, sha256);
    try {
      await o.exec("rclone", ["deletefile", `${o.remote}/files/${name}`], o.env);
    } catch {
      // rclone doesn't say why with its exit code (1, for a file that isn't there too): ask whether it's there. Not
      // there (never sent, or already deleted) is done; there, or no answer, is tried next time.
      const there = await o
        .exec("rclone", ["lsf", "--files-only", `${o.remote}/files`, "--include", name], o.env)
        .then(
          (out) => out.split("\n").some((l) => l.trim() === name),
          () => true,
        );
      if (there) continue;
    }
    await o.db.forgetGone(sha256);
    pruned++;
  }
  const result: FilesResult = { uploaded, bytes, left, pruned, ...(failed ? { failed } : {}) };
  await o.db.record(failed === 0, { ...result });
  return result;
}
