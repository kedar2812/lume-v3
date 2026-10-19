import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "./exec";
import { GONE_DAYS, offsiteName, syncFiles, type FilesDb } from "./files-offsite";

/**
 * WhatsApp's files off-site (2026-10-19): each goes once, encrypted, under a name that doesn't give away what it is;
 * a file gone from the server goes off-site 200 days later; nothing here ever fails the database backup.
 */
const SALT = "a-salt-for-tests";
const REMOTE = "offsite:/b";
const now = new Date("2026-10-19T06:00:00Z");
let dir: string;
let tmp: string;
const sha = (c: string) => c.repeat(64);
async function put(h: string, bytes = "bytes") {
  await mkdir(path.join(dir, h.slice(0, 2)), { recursive: true });
  await writeFile(path.join(dir, h.slice(0, 2), h), bytes);
}
function fakeDb(gone: string[] = []): FilesDb & { events: unknown[]; forgotten: string[] } {
  const events: unknown[] = [];
  const forgotten: string[] = [];
  return {
    events,
    forgotten,
    salt: async () => SALT,
    goneBefore: vi.fn(async () => gone),
    forgetGone: async (h) => void forgotten.push(h),
    record: async (ok, detail) => void events.push({ ok, ...detail }),
  };
}
/** rclone and age as the worker runs them: the remote's listing, and every call kept. */
function fakeExec(
  o: {
    remote?: string[];
    listFails?: number | "other";
    fail?: (args: string[]) => unknown;
    /** What `lsf --include <name>` answers (the real rclone: the name when it's there, nothing when it isn't). */
    include?: (name: string) => string;
  } = {},
) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const bad = o.fail?.([file, ...args]);
    if (bad) throw bad;
    if (file === "rclone" && args[0] === "lsf" && args[3] === "--include") return o.include?.(args[4]!) ?? "";
    if (file === "rclone" && args[0] === "lsf") {
      if (o.listFails === "other") throw Object.assign(new Error("network down"), { code: 1 });
      if (o.listFails) throw Object.assign(new Error("directory not found"), { code: o.listFails });
      return (o.remote ?? []).join("\n") + "\n";
    }
    if (file === "age") await writeFile(args[args.indexOf("-o") + 1]!, "encrypted");
    return "";
  };
  return { exec, calls };
}
const deps = (exec: Exec, db: FilesDb, more: Partial<Parameters<typeof syncFiles>[0]> = {}) => ({
  exec,
  db,
  remote: REMOTE,
  recipients: ["age1one", "age1two"],
  filesDir: dir,
  tmpDir: tmp,
  env: { X: "1" },
  now: () => now,
  ...more,
});

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "lume-files-"));
  tmp = await mkdtemp(path.join(tmpdir(), "lume-tmp-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(tmp, { recursive: true, force: true });
});

describe("offsiteName", () => {
  it("is the salted HMAC of the hash: the same everywhere with the same salt, never the hash itself", () => {
    const n = offsiteName(SALT, sha("a"));
    expect(n).toMatch(/^[0-9a-f]{64}\.age$/);
    expect(n).toBe(offsiteName(SALT, sha("a")));
    expect(n).not.toContain(sha("a"));
    expect(offsiteName("another-salt", sha("a"))).not.toBe(n);
  });
});

describe("syncFiles", () => {
  it("sends only the files the remote doesn't have, each encrypted to every key, then forgets nothing", async () => {
    await put(sha("a"), "aaaa");
    await put(sha("b"), "bb");
    await put(sha("c"));
    await writeFile(path.join(dir, sha("a").slice(0, 2), ".tmp-0001"), "half"); // a write in flight: not sent
    const db = fakeDb();
    const { exec, calls } = fakeExec({ remote: [offsiteName(SALT, sha("c"))] });
    const r = await syncFiles(deps(exec, db));
    expect(r).toEqual({ uploaded: 2, bytes: 6, left: 0, pruned: 0 });
    const ages = calls.filter((c) => c[0] === "age");
    expect(ages).toHaveLength(2);
    for (const a of ages) expect(a.slice(1, 5)).toEqual(["-r", "age1one", "-r", "age1two"]);
    const copies = calls.filter((c) => c[0] === "rclone" && c[1] === "copyto").map((c) => c[3]);
    expect(copies.sort()).toEqual(
      [
        `${REMOTE}/files/${offsiteName(SALT, sha("a"))}`,
        `${REMOTE}/files/${offsiteName(SALT, sha("b"))}`,
      ].sort(),
    );
    expect(calls.some((c) => c.join(" ").includes(sha("a")) && c[0] === "rclone")).toBe(false); // no hash leaves
    expect(db.events).toEqual([{ ok: true, uploaded: 2, bytes: 6, left: 0, pruned: 0 }]);
    // No encrypted copy is left in the worker's temp folder.
    expect(await readdir(tmp)).toEqual([]);
  });

  it("a remote with no files folder yet counts as empty; any other listing failure fails the sync, not the backup", async () => {
    await put(sha("a"));
    const first = fakeExec({ listFails: 3 });
    expect(await syncFiles(deps(first.exec, fakeDb()))).toMatchObject({ uploaded: 1 });
    const db = fakeDb();
    const down = fakeExec({ listFails: "other" });
    await expect(syncFiles(deps(down.exec, db))).rejects.toThrow(/network down/);
    expect(db.events).toEqual([{ ok: false, error: "LUME couldn't list the backup's files." }]);
    expect(down.calls.some((c) => c[1] === "copyto")).toBe(false);
  });

  it("a big first copy stops at its time budget and says how many are left for the next run", async () => {
    for (const c of ["a", "b", "c", "d"]) await put(sha(c));
    let t = now.getTime();
    const { exec } = fakeExec();
    const slow: Exec = async (file, args, env) => {
      if (file === "rclone" && args[0] === "copyto") t += 10 * 60_000; // ten minutes a file
      return exec(file, args, env);
    };
    const r = await syncFiles(deps(slow, fakeDb(), { now: () => new Date(t), budgetMs: 25 * 60_000 }));
    expect(r).toEqual({ uploaded: 3, bytes: 15, left: 1, pruned: 0 });
  });

  it("one file that won't go is skipped and counted; the rest go", async () => {
    await put(sha("a"));
    await put(sha("b"));
    const bad = offsiteName(SALT, sha("a"));
    const db = fakeDb();
    const { exec } = fakeExec({
      fail: (c) => (c[1] === "copyto" && c[3]!.endsWith(bad) ? new Error("upload failed") : null),
    });
    const r = await syncFiles(deps(exec, db));
    expect(r).toEqual({ uploaded: 1, bytes: 5, left: 0, pruned: 0, failed: 1 });
    expect(db.events).toEqual([{ ok: false, uploaded: 1, bytes: 5, left: 0, pruned: 0, failed: 1 }]);
  });

  it("files gone from the server 200 days ago leave off-site; one already missing there is forgotten too", async () => {
    const db = fakeDb([sha("d"), sha("e"), sha("f"), sha("9")]);
    const missing = offsiteName(SALT, sha("e"));
    const stuck = offsiteName(SALT, sha("f"));
    const unknown = offsiteName(SALT, sha("9"));
    // As the real rclone answers: exit 1 for a delete that failed for any reason, a missing file included.
    const { exec, calls } = fakeExec({
      fail: (c) => {
        if (c[1] === "deletefile" && [missing, stuck, unknown].some((n) => c[2]!.endsWith(n)))
          return Object.assign(new Error("failed to delete"), { code: 1 });
        if (c[1] === "lsf" && c[4] === "--include" && c[5] === unknown) return new Error("network down");
        return null;
      },
      include: (name) => (name === stuck ? `${stuck}\n` : ""),
    });
    const r = await syncFiles(deps(exec, db));
    expect(db.goneBefore).toHaveBeenCalledWith(new Date(now.getTime() - GONE_DAYS * 86_400_000));
    expect(GONE_DAYS).toBe(200);
    expect(r).toMatchObject({ pruned: 2 });
    // Deleted, and already missing: forgotten. Still there, or no answer: tried next time.
    expect(db.forgotten).toEqual([sha("d"), sha("e")]);
    expect(calls.filter((c) => c[1] === "deletefile").map((c) => c[2])).toEqual(
      [sha("d"), sha("e"), sha("f"), sha("9")].map((h) => `${REMOTE}/files/${offsiteName(SALT, h)}`),
    );
  });

  it("no files folder (an old compose, the demo): nothing to send, and that's fine", async () => {
    const db = fakeDb();
    const { exec, calls } = fakeExec();
    expect(await syncFiles(deps(exec, db, { filesDir: path.join(dir, "not-mounted") }))).toEqual({
      uploaded: 0,
      bytes: 0,
      left: 0,
      pruned: 0,
    });
    expect(calls.filter((c) => c[1] === "copyto")).toEqual([]);
  });
});
