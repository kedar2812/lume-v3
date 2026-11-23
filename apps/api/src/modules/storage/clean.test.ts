import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { CLEAN_BATCH, CLEANUP_WORDS, CLEARED_WORDS, clearBatch, reviveCleanups } from "./clean";
import { forgetSurvey, PARTS, partParams } from "./survey";

/**
 * Clean up (plan 2026-11-23-storage-clean-up, Task 2): what an admin ticks goes, in batches, one clean-up at a time;
 * every message's words stay, each cleared file saying so; the bytes leave the disk at once; a file another lead
 * still holds stays.
 */
const DAY = 86_400_000;
let h: Harness;
let admin: { id: string; email: string; password: string };
let numberId: string;

/** A file whose bytes are really on disk, on the store's books, last pointed at long ago. */
const stored = async (text: string) => {
  const { sha256, size } = await h.files.store.put(Buffer.from(text));
  await h.ownerPool.query(
    "INSERT INTO whatsapp_files (sha256, size, last_ref_at) VALUES ($1, $2, now() - interval '30 days')",
    [sha256, size],
  );
  return sha256;
};
const chat = async (lead: string | null, sha: string) => {
  const id = randomUUID();
  await h.queryAll(
    `INSERT INTO whatsapp_media (id, number_id, meta_id, lead_id, kind, mime, status, sha256, size, created_at)
     VALUES ($1, $2, $3, $4, 'image', 'image/jpeg', 'ready', $5, 1, now() - interval '300 days')`,
    [id, numberId, randomUUID(), lead, sha],
  );
  // The trigger touched the file when the media pointed at it: as it would have been, long ago.
  await h.ownerPool.query(
    "UPDATE whatsapp_files SET last_ref_at = now() - interval '30 days' WHERE sha256 = $1",
    [sha],
  );
  return id;
};
const closedLead = async () => {
  const id = await h.seedLead({ ownerId: admin.id, name: "Closed lead" });
  await h.queryAll("UPDATE leads SET won_at = now() - interval '200 days' WHERE id = $1", [id]);
  return id;
};
const clean = async (kinds: string[], o: { as?: typeof admin } = {}) =>
  (await h.signIn(o.as ?? admin)).inject({
    method: "POST",
    url: "/api/v1/storage/clean-up",
    payload: { kinds },
  });
const media = (id: string) =>
  h
    .queryAll<{ status: string; sha256: string | null; problem: string | null }>(
      "SELECT status, sha256, problem FROM whatsapp_media WHERE id = $1",
      [id],
    )
    .then((r) => r[0]!);

beforeAll(async () => {
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: "http://127.0.0.1:9", version: "v23.0" },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.ownerPool.query(
    `TRUNCATE leads, activities, whatsapp_media, file_previews, message_files, storage_cleanups, whatsapp_files CASCADE`,
  );
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  numberId = await seedNumber(h, { runAs: admin.id });
  h.storageQueued.length = 0;
  forgetSurvey();
});

describe("Clean up", () => {
  it("clears the ticked kinds only; every message's words stay; the bytes leave the disk at once", async () => {
    const lead = await closedLead();
    const a = await stored("closed file");
    const m = await chat(lead, a);
    const open = await h.seedLead({ ownerId: admin.id, name: "Open lead" });
    const b = await stored("open file");
    const keep = await chat(open, b);
    const r = await clean(["closed"]);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toMatchObject({
      status: "running",
      kinds: ["closed"],
      filesPlanned: 1,
      bytesPlanned: 11,
    });
    await h.runStorageCleanup();
    expect(await media(m)).toEqual({
      status: "removed",
      sha256: null,
      problem: CLEARED_WORDS.whatsapp_media,
    });
    expect(await h.files.store.exists(a)).toBe(false);
    expect(await media(keep)).toMatchObject({ status: "ready", sha256: b });
    expect(await h.files.store.exists(b)).toBe(true);
    const done = await (
      await h.signIn(admin)
    ).inject({ method: "GET", url: `/api/v1/storage/clean-up/${r.json().id}` });
    expect(done.json()).toMatchObject({ status: "done", filesDone: 1, bytesDone: 11 });
  });

  it("a file another lead still holds stays on disk, and the lead keeps it", async () => {
    const shared = await stored("both leads have this");
    const closed = await chat(await closedLead(), shared);
    const open = await chat(await h.seedLead({ ownerId: admin.id, name: "Open" }), shared);
    expect((await clean(["closed"])).json()).toMatchObject({ filesPlanned: 1, bytesPlanned: 0 });
    await h.runStorageCleanup();
    expect((await media(closed)).status).toBe("removed");
    expect(await media(open)).toMatchObject({ status: "ready", sha256: shared });
    expect(await h.files.store.exists(shared)).toBe(true);
  });

  it("a file sent again while it ran (just now pointed at) stays for the hourly sweep", async () => {
    const lead = await closedLead();
    const f = await stored("sent again");
    await chat(lead, f);
    const r = await clean(["closed"]);
    // Between the press and the job: the same bytes arrive in a new message, and that message goes too.
    const fresh = randomUUID();
    await h.queryAll(
      `INSERT INTO whatsapp_media (id, number_id, meta_id, kind, mime, status, sha256, size)
       VALUES ($1, $2, $3, 'image', 'image/jpeg', 'ready', $4, 1)`,
      [fresh, numberId, randomUUID(), f],
    );
    await h.queryAll("DELETE FROM whatsapp_media WHERE id = $1", [fresh]);
    await h.runStorageCleanup();
    expect(await h.files.store.exists(f)).toBe(true);
    expect((await h.queryAll("SELECT 1 FROM whatsapp_files WHERE sha256 = $1", [f])).length).toBe(1);
    void r;
  });

  it("one at a time: a second press is told, with the one already running", async () => {
    await chat(await closedLead(), await stored("x"));
    const first = await clean(["closed"]);
    const second = await clean(["trash"]);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({ code: "CLEANUP_RUNNING", details: { id: first.json().id } });
  });

  it("two admins at the same moment: one starts, the other is shown that one", async () => {
    await chat(await closedLead(), await stored("y"));
    const both = await Promise.all([clean(["closed"]), clean(["trash"])]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    const won = both.find((r) => r.statusCode === 202)!;
    const lost = both.find((r) => r.statusCode === 409)!;
    expect(lost.json().error).toMatchObject({ code: "CLEANUP_RUNNING", details: { id: won.json().id } });
  });

  it("many files clear in batches of a thousand, its count rising as each one commits", async () => {
    const lead = await closedLead();
    const f = await stored("one file, many messages");
    await h.queryAll(
      `INSERT INTO whatsapp_media (id, number_id, meta_id, lead_id, kind, mime, status, sha256, size, created_at)
       SELECT gen_random_uuid(), $1, 'm' || g, $2, 'image', 'image/jpeg', 'ready', $3, 1, now() - interval '300 days'
         FROM generate_series(1, 2500) g`,
      [numberId, lead, f],
    );
    await h.ownerPool.query("UPDATE whatsapp_files SET last_ref_at = now() - interval '30 days'");
    // One batch is a thousand rows, never all of them in one transaction.
    const c = await h.ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('lume.lead_scope', 'all', true)");
      expect(await clearBatch(c, PARTS.closed[0]!, partParams(6))).toBe(CLEAN_BATCH);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    const r = await clean(["closed"]);
    expect(r.json().filesPlanned).toBe(2500);
    await h.runStorageCleanup();
    expect(await h.queryAll("SELECT 1 FROM whatsapp_media WHERE status = 'ready'")).toHaveLength(0);
    expect(await h.files.store.exists(f)).toBe(false);
  });

  it("previews not opened in 90 days let their pictures go, and come back when the library is looked at", async () => {
    const src = await stored("a brochure");
    const thumb = await stored("its thumbnail");
    const fileId = randomUUID();
    await h.ownerPool.query(
      `INSERT INTO message_files (id, sha256, name, mime, kind, size) VALUES ($1, $2, 'Brochure.pdf', 'application/pdf', 'document', 10)`,
      [fileId, src],
    );
    await h.ownerPool.query(
      `INSERT INTO file_previews (sha256, state, thumb_sha256, opened_at) VALUES ($1, 'ready', $2, now() - interval '100 days')`,
      [src, thumb],
    );
    await h.ownerPool.query("UPDATE whatsapp_files SET last_ref_at = now() - interval '30 days'");
    await clean(["previews"]);
    await h.runStorageCleanup();
    expect(await h.files.store.exists(thumb)).toBe(false);
    expect(await h.files.store.exists(src)).toBe(true);
    h.previewQueued.length = 0;
    const list = await (await h.signIn(admin)).inject({ method: "GET", url: "/api/v1/files" });
    expect(list.json().files[0]).toMatchObject({ id: fileId, preview: "pending" });
    expect(h.previewQueued).toEqual([src]);
    // Woken, it counts as opened now: the next clean-up doesn't take it again.
    const opened = await h.queryAll<{ fresh: boolean }>(
      "SELECT opened_at > now() - interval '1 minute' AS fresh FROM file_previews WHERE sha256 = $1",
      [src],
    );
    expect(opened).toEqual([{ fresh: true }]);
  });

  it("a library in use: looking at it counts its previews as opened (a browser keeps the picture)", async () => {
    const src = await stored("a price list");
    const thumb = await stored("its picture");
    await h.ownerPool.query(
      `INSERT INTO message_files (id, sha256, name, mime, kind, size) VALUES ($1, $2, 'Prices.pdf', 'application/pdf', 'document', 10)`,
      [randomUUID(), src],
    );
    await h.ownerPool.query(
      `INSERT INTO file_previews (sha256, state, thumb_sha256, opened_at) VALUES ($1, 'ready', $2, now() - interval '100 days')`,
      [src, thumb],
    );
    await (await h.signIn(admin)).inject({ method: "GET", url: "/api/v1/files" });
    forgetSurvey();
    const s = (await (await h.signIn(admin)).inject({ method: "GET", url: "/api/v1/storage" })).json();
    expect(s.candidates.find((c: { kind: string }) => c.kind === "previews")).toMatchObject({ files: 0 });
  });

  it("audited, and the list of what it would clear downloads, formula-safe", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "=HYPERLINK(1)" });
    await h.queryAll("UPDATE leads SET lost_at = now() - interval '200 days' WHERE id = $1", [lead]);
    await chat(lead, await stored("listed"));
    const csv = await (
      await h.signIn(admin)
    ).inject({ method: "GET", url: "/api/v1/storage/clean-up/files.csv?kinds=closed" });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toBe("What,Lead,File,Size (bytes),Added");
    expect(csv.body).toContain(`"'=HYPERLINK(1)"`);
    const r = await clean(["closed"]);
    const audit = await h.queryAll<{ diff: Record<string, unknown> }>(
      "SELECT diff FROM audit_log WHERE action = 'storage.cleaned' AND entity_id = $1",
      [r.json().id],
    );
    expect(audit[0]!.diff).toMatchObject({ kinds: ["closed"], files: 1 });
    const listed = await h.queryAll<{ diff: Record<string, unknown> }>(
      "SELECT diff FROM audit_log WHERE action = 'storage.listed'",
    );
    expect(listed.at(-1)!.diff).toMatchObject({ kinds: ["closed"], rows: 1 });
    void DAY;
  });

  it("an admin who sees only their own leads gets the list without other people's names or files", async () => {
    const own = await h.seedUser({
      grants: [
        { key: "settings.manage", scope: "all" },
        { key: "leads.view", scope: "own" },
      ],
    });
    const theirs = await h.seedLead({ ownerId: admin.id, name: "Someone Else's Lead" });
    await h.queryAll("UPDATE leads SET lost_at = now() - interval '200 days' WHERE id = $1", [theirs]);
    await chat(theirs, await stored("not theirs"));
    const csv = await (
      await h.signIn(own)
    ).inject({ method: "GET", url: "/api/v1/storage/clean-up/files.csv?kinds=closed" });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).not.toContain("Someone Else's Lead");
    expect(csv.body).toContain(`"closed","A lead you can't see",""`);
  });

  it("a clean-up whose job was lost is picked up again; one running for a day stops, saying so", async () => {
    await chat(await closedLead(), await stored("lost job"));
    const id = (await clean(["closed"])).json().id as string;
    const queued: string[] = [];
    const enqueue = async (x: string) => void queued.push(x);
    expect(await reviveCleanups(h.pool, enqueue)).toEqual([]);
    await h.ownerPool.query(
      "UPDATE storage_cleanups SET touched_at = now() - interval '20 minutes' WHERE id = $1",
      [id],
    );
    expect(await reviveCleanups(h.pool, enqueue)).toEqual([id]);
    expect(queued).toEqual([id]);
    // Picked up: quiet again only after another quarter of an hour.
    expect(await reviveCleanups(h.pool, enqueue)).toEqual([]);
    await h.ownerPool.query(
      "UPDATE storage_cleanups SET started_at = now() - interval '25 hours' WHERE id = $1",
      [id],
    );
    await reviveCleanups(h.pool, enqueue);
    const v = await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/storage/clean-up/${id}` });
    expect(v.json()).toMatchObject({ status: "failed", problem: CLEANUP_WORDS.gaveUp });
    // And the next clean-up may start.
    expect((await clean(["trash"])).statusCode).toBe(202);
  });

  it("only people who manage settings; an unknown kind or none is refused", async () => {
    const rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
    expect((await clean(["trash"], { as: rep })).statusCode).toBe(403);
    expect((await clean([])).statusCode).toBe(400);
    expect((await clean(["everything"])).statusCode).toBe(400);
    expect((await clean(["trash", "trash"])).statusCode).toBe(400);
  });
});
