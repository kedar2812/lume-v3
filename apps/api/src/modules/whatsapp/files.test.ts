import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileStore } from "./files";

/** WhatsApp's files on disk, named by their content: stored once however many leads get them (2026-10-19). */
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lume-files-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const BROCHURE = Buffer.from("%PDF-1.7 the same brochure, sent to 150 leads");
const hashOf = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile()) out.push(e.name);
  return out;
}

describe("fileStore", () => {
  it("keeps the same bytes once, under their hash", async () => {
    const store = fileStore(root);
    const a = await store.put(BROCHURE);
    const b = await store.put(BROCHURE);
    expect(a).toEqual({ sha256: hashOf(BROCHURE), size: BROCHURE.length });
    expect(b).toEqual(a);
    expect(await filesUnder(root)).toEqual([a.sha256]);
    expect(store.path(a.sha256)).toBe(path.join(root, a.sha256.slice(0, 2), a.sha256));
    expect((await readFile(store.path(a.sha256))).equals(BROCHURE)).toBe(true);
    expect(await store.exists(a.sha256)).toBe(true);
  });

  it("two copies arriving at once still make one whole file", async () => {
    const store = fileStore(root);
    const big = Buffer.alloc(2_000_000, 7);
    const all = await Promise.all(Array.from({ length: 8 }, () => store.put(big)));
    expect(new Set(all.map((x) => x.sha256)).size).toBe(1);
    expect(await filesUnder(root)).toEqual([hashOf(big)]);
    expect((await readFile(store.path(hashOf(big)))).equals(big)).toBe(true);
  });

  it("refuses a name that isn't a hash, so no path can leave the folder", () => {
    const store = fileStore(root);
    for (const bad of ["../etc/passwd", "ABC", "", `${"a".repeat(63)}/`, "g".repeat(64)])
      expect(() => store.path(bad)).toThrow();
  });

  it("files are readable by their owner and group only (the worker reads them for the off-site copy)", async () => {
    const store = fileStore(root);
    const { sha256 } = await store.put(BROCHURE);
    const s = await stat(store.path(sha256));
    expect(s.mode & 0o777 & ~0o640).toBe(0);
  });

  it("the scan finds every file and any temp file a crash left, and ignores anything else", async () => {
    const store = fileStore(root);
    const { sha256 } = await store.put(BROCHURE);
    const dir = path.dirname(store.path(sha256));
    await writeFile(path.join(dir, ".tmp-0123456789abcdef"), "half a file");
    await writeFile(path.join(dir, "notes.txt"), "not ours");
    await mkdir(path.join(root, "lost+found"));
    const r = await store.scan();
    expect(r.files.map((f) => f.sha256)).toEqual([sha256]);
    expect(r.temps.map((t) => path.basename(t.path))).toEqual([".tmp-0123456789abcdef"]);
  });

  it("the scan reads one folder of hashes at a time, and refuses anything else as a folder", async () => {
    const store = fileStore(root);
    const { sha256 } = await store.put(BROCHURE);
    const prefix = sha256.slice(0, 2);
    expect((await store.scan(prefix)).files.map((f) => f.sha256)).toEqual([sha256]);
    const other = prefix === "00" ? "01" : "00";
    expect(await store.scan(other)).toEqual({ files: [], temps: [] });
    for (const bad of ["..", "a", "abc", "zz", "../"]) await expect(store.scan(bad)).rejects.toThrow();
  });

  it("the scan of a folder that doesn't exist yet is empty", async () => {
    expect(await fileStore(path.join(root, "never-made")).scan()).toEqual({ files: [], temps: [] });
  });

  it("something that isn't a file under a hash's name is refused, and the temp file is cleaned up", async () => {
    const store = fileStore(root);
    const sha256 = hashOf(BROCHURE);
    await mkdir(store.path(sha256), { recursive: true });
    await expect(store.put(BROCHURE)).rejects.toThrow(/not a file/);
    expect((await store.scan()).temps).toEqual([]);
  });

  it("removing a file that's already gone is fine", async () => {
    const store = fileStore(root);
    const { sha256 } = await store.put(BROCHURE);
    await store.remove(sha256);
    await store.remove(sha256);
    expect(await store.exists(sha256)).toBe(false);
  });
});
