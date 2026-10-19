import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, open, readdir, rm, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";

const HASH = /^[0-9a-f]{64}$/;
const TEMP = /^\.tmp-/;
/** Owner read/write, group read: the worker reads them (the volume, read-only) for the off-site copy. */
const FILE_MODE = 0o640;
const DIR_MODE = 0o750;

export type FileStore = ReturnType<typeof fileStore>;
/** How big the disk the files are on is, and how much is left for LUME (bytes). */
export type Disk = { total: number; free: number };
/** What the API needs for WhatsApp's files: where they are, and how full that disk is. */
export type FilesDeps = { store: FileStore; disk(): Promise<Disk | null> };

export const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The disk under `dir`, or null when it can't be read (no folder yet, a platform without statfs). */
export async function diskOf(dir: string): Promise<Disk | null> {
  try {
    const s = await statfs(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    if (!(total > 0)) return null;
    return { total, free: Number(s.bavail) * Number(s.bsize) };
  } catch {
    return null;
  }
}

/** The share of the disk in use, 0–1. Space only root may use counts as used: LUME can't have it. */
export const usedShare = (d: Disk) => Math.min(1, Math.max(0, 1 - d.free / d.total));

/**
 * WhatsApp's photos, voice notes, videos and documents on this server's disk, each named by its content's SHA-256
 * (2026-10-19): a brochure sent to 150 leads is one file. Files live out of the database, so the 6-hourly dumps stay
 * small and each file goes off-site once. Nothing here knows about leads: which media point at a file, and who may
 * see it, is the database's business (whatsapp_files.refs, row-level security on whatsapp_media).
 */
export function fileStore(root: string) {
  const pathOf = (sha256: string) => {
    if (!HASH.test(sha256)) throw new Error("not a file hash");
    return path.join(root, sha256.slice(0, 2), sha256);
  };
  const exists = async (sha256: string) =>
    stat(pathOf(sha256)).then(
      (s) => s.isFile(),
      () => false,
    );
  return {
    root,
    path: pathOf,
    exists,
    /**
     * Keep these bytes; their hash is their name. Written to a temp file opened exclusively, then hard-linked into
     * place: a link fails if the name exists, so a file under its hash is always whole, however many arrive at once.
     */
    async put(bytes: Buffer): Promise<{ sha256: string; size: number }> {
      const sha256 = sha256Of(bytes);
      const out = { sha256, size: bytes.length };
      const final = pathOf(sha256);
      if (await exists(sha256)) return out;
      const dir = path.dirname(final);
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      const temp = path.join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
      const fh = await open(temp, "wx", FILE_MODE);
      try {
        try {
          await fh.writeFile(bytes);
          await fh.sync();
        } finally {
          await fh.close();
        }
        await link(temp, final).catch(async (e: NodeJS.ErrnoException) => {
          if (e.code !== "EEXIST") throw e;
          // Another copy got there first (the same bytes), unless what's there isn't a file at all.
          if (!(await exists(sha256))) throw new Error("not a file under this hash's name");
        });
      } finally {
        await unlink(temp).catch(() => undefined);
      }
      return out;
    },
    /** Whether LUME can write here (the volume mounted, and ours): System health says so when it can't. */
    async writable(): Promise<boolean> {
      try {
        await mkdir(root, { recursive: true, mode: DIR_MODE });
        await access(root, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    async remove(sha256: string): Promise<void> {
      await rm(pathOf(sha256), { force: true });
    },
    /**
     * The files on disk, for the daily scan: hashes with their age, and temp files a crash left. One folder (two hex
     * characters) at a time when `prefix` is given, else all of them. Anything else in the folder is left alone.
     */
    async scan(
      prefix?: string,
    ): Promise<{ files: { sha256: string; mtimeMs: number }[]; temps: { path: string; mtimeMs: number }[] }> {
      if (prefix !== undefined && !/^[0-9a-f]{2}$/.test(prefix)) throw new Error("not a folder of hashes");
      const files: { sha256: string; mtimeMs: number }[] = [];
      const temps: { path: string; mtimeMs: number }[] = [];
      const missingOk = (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
        throw e;
      };
      const names =
        prefix !== undefined
          ? [prefix]
          : (await readdir(root, { withFileTypes: true }).catch(missingOk))
              .filter((d) => d.isDirectory() && /^[0-9a-f]{2}$/.test(d.name))
              .map((d) => d.name);
      for (const name of names) {
        const dir = path.join(root, name);
        for (const f of await readdir(dir, { withFileTypes: true }).catch(missingOk)) {
          if (!f.isFile()) continue;
          const p = path.join(dir, f.name);
          const s = await stat(p).catch(() => null);
          if (!s) continue;
          if (HASH.test(f.name) && f.name.startsWith(name))
            files.push({ sha256: f.name, mtimeMs: s.mtimeMs });
          else if (TEMP.test(f.name)) temps.push({ path: p, mtimeMs: s.mtimeMs });
        }
      }
      return { files, temps };
    },
  };
}
