import { utimes, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { sweepWhatsApp } from "./inbox";
import { scanWhatsAppFiles, sweepWhatsAppFiles } from "./keep";

/**
 * Files kept as long as the client says, and files nothing points to taken off the disk (2026-10-19): the hourly
 * sweep, the daily scan, and the setting with its preview.
 */
let h: Harness;
let meta: MetaFake;
let admin: { id: string; email: string; password: string };
let rep: { id: string; email: string; password: string };
const SNEHA = "+919876543210";
const quiet = { warn: () => undefined, error: () => undefined };
const sweep = () => sweepWhatsAppFiles({ pool: h.pool, store: h.files.store, log: quiet });
const files = () =>
  h.queryAll<{ sha256: string; refs: number }>("SELECT sha256, refs FROM whatsapp_files ORDER BY sha256");
const gone = () => h.queryAll<{ sha256: string }>("SELECT sha256 FROM whatsapp_files_gone ORDER BY sha256");
const onDisk = async () => (await h.files.store.scan()).files.map((f) => f.sha256).sort();

/** A photo on the lead, fetched; its media id and file hash. */
async function photo(lead: string, metaId: string, bytes: Buffer, from = "919876543210") {
  meta.media.set(metaId, { mime: "image/jpeg", bytes });
  await deliver(
    h,
    inbound({ from, id: `wamid.${metaId}`, type: "image", image: { id: metaId, mime_type: "image/jpeg" } }),
  );
  await h.runWhatsApp();
  await h.runWhatsAppMedia();
  const [m] = await h.queryAll<{ id: string; sha256: string }>(
    "SELECT id, sha256 FROM whatsapp_media WHERE meta_id = $1",
    [metaId],
  );
  expect(m?.sha256, `${metaId} was kept`).toBeTruthy();
  return { id: m!.id, sha256: m!.sha256 };
}
/**
 * Make a media item this many months old: by the real time for the sweep (which reads the time itself), or `from` a
 * given moment for what reads LUME's clock (the preview reads the harness's, fixed behind the real date: measured from
 * the real date, "7 months" stopped being older than 6 by that clock, and CI went red on 2026-10-21).
 */
async function age(mediaId: string, months: number, from?: Date) {
  await h.queryAll(
    "UPDATE whatsapp_media SET created_at = coalesce($3::timestamptz, now()) - make_interval(months => $2, days => 1) WHERE id = $1",
    [mediaId, months, from ?? null],
  );
}
const untouchedFor = (hours: number) =>
  h.ownerPool.query("UPDATE whatsapp_files SET last_ref_at = now() - make_interval(hours => $1)", [hours]);
const keepFor = async (months: number | null) =>
  (await h.signIn(admin)).inject({
    method: "PUT",
    url: "/api/v1/integrations/whatsapp",
    payload: { keepFilesMonths: months },
  });

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("DELETE FROM whatsapp_files");
  await h.ownerPool.query("DELETE FROM whatsapp_files_gone");
  for (const f of (await h.files.store.scan()).files) await h.files.store.remove(f.sha256);
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  h.whatsappQueued.length = 0;
  h.whatsappMediaQueued.length = 0;
  await seedNumber(h, { runAs: admin.id, owner: rep.id });
  await h.ownerPool.query(
    "UPDATE settings SET integrations = jsonb_set(integrations, '{whatsapp}', '{\"enabled\": true}'::jsonb) WHERE id = 1",
  );
});

describe("keep files for N months", () => {
  it("forever by default: nothing old is touched", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const p = await photo(lead, "OLD", Buffer.from("an old photo"));
    await age(p.id, 30);
    await untouchedFor(2);
    expect(await sweep()).toEqual({ removed: 0, deleted: 0, mended: 0 });
    expect(await onDisk()).toEqual([p.sha256]);
  });

  it("3 months: an older file goes from the disk and onto the off-site list; the message stays, saying why", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const old = await photo(lead, "OLD3", Buffer.from("an old photo"));
    const fresh = await photo(lead, "NEW3", Buffer.from("a new photo"));
    await age(old.id, 4);
    await untouchedFor(2);
    expect((await keepFor(3)).statusCode).toBe(200);
    expect(await sweep()).toEqual({ removed: 1, deleted: 1, mended: 0 });
    const rows = await h.queryAll<{
      meta_id: string;
      status: string;
      problem: string | null;
      sha256: string | null;
    }>("SELECT meta_id, status, problem, sha256 FROM whatsapp_media WHERE lead_id = $1 ORDER BY meta_id", [
      lead,
    ]);
    expect(rows).toEqual([
      { meta_id: "NEW3", status: "ready", problem: null, sha256: fresh.sha256 },
      {
        meta_id: "OLD3",
        status: "removed",
        problem: "LUME keeps WhatsApp files for 3 months. This one is still on the phone.",
        sha256: null,
      },
    ]);
    expect(await onDisk()).toEqual([fresh.sha256]);
    expect(await gone()).toEqual([{ sha256: old.sha256 }]);
    // The message itself is still on the lead.
    expect(
      await h.queryAll("SELECT 1 FROM activities WHERE lead_id = $1 AND payload->>'wamid' = 'wamid.OLD3'", [
        lead,
      ]),
    ).toHaveLength(1);
  });

  it("an old copy and a recent copy of the same brochure: the old row lets go, the file stays", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const brochure = Buffer.from("%PDF the brochure");
    const old = await photo(lead, "B-OLD", brochure);
    const recent = await photo(lead, "B-NEW", brochure);
    expect(old.sha256).toBe(recent.sha256);
    await age(old.id, 7);
    await untouchedFor(2);
    await keepFor(6);
    expect(await sweep()).toMatchObject({ removed: 1, deleted: 0 });
    expect(await files()).toEqual([{ sha256: recent.sha256, refs: 1 }]);
    expect(await onDisk()).toEqual([recent.sha256]);
  });

  it("the setting merges: switching WhatsApp off and on keeps it; it's checked, audited, admins only", async () => {
    const since = (await h.ownerPool.query<{ t: Date }>("SELECT now() AS t")).rows[0]!.t;
    expect((await keepFor(12)).json().whatsapp).toMatchObject({ enabled: true, keepFilesMonths: 12 });
    const off = await (
      await h.signIn(admin)
    ).inject({
      method: "PUT",
      url: "/api/v1/integrations/whatsapp",
      payload: { enabled: false },
    });
    expect(off.json().whatsapp).toMatchObject({ enabled: false, keepFilesMonths: 12 });
    expect((await keepFor(null)).json().whatsapp).toMatchObject({ enabled: false, keepFilesMonths: null });
    for (const bad of [
      { keepFilesMonths: 5 },
      { keepFilesMonths: "6" },
      {},
      { keepFilesMonths: 6, other: 1 },
    ]) {
      const r = await (
        await h.signIn(admin)
      ).inject({
        method: "PUT",
        url: "/api/v1/integrations/whatsapp",
        payload: bad,
      });
      expect([bad, r.statusCode]).toEqual([bad, 400]);
    }
    const asRep = await (
      await h.signIn(rep)
    ).inject({
      method: "PUT",
      url: "/api/v1/integrations/whatsapp",
      payload: { keepFilesMonths: 3 },
    });
    expect(asRep.statusCode).toBe(403);
    const audit = await h.ownerPool.query<{ diff: unknown }>(
      "SELECT diff FROM audit_log WHERE action = 'integration.updated' AND at >= $1 ORDER BY at",
      [since],
    );
    expect(audit.rows.map((r) => r.diff)).toEqual([
      { module: "whatsapp", keepFilesMonths: { from: null, to: 12 } },
      { module: "whatsapp", keepFilesMonths: { from: 12, to: null } },
    ]);
  });

  it("the preview says how many files a shorter window removes, and about how much room it frees", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const a = await photo(lead, "P1", Buffer.alloc(1000, 1));
    const b = await photo(lead, "P2", Buffer.alloc(500, 2));
    const shared = Buffer.alloc(300, 3);
    const c = await photo(lead, "P3", shared);
    await photo(lead, "P4", shared); // a recent copy keeps the shared file
    await photo(lead, "P5", Buffer.alloc(200, 4)); // recent: stays
    for (const m of [a, b, c]) await age(m.id, 7, h.clock.now);
    const r = await (
      await h.signIn(admin)
    ).inject({
      method: "GET",
      url: "/api/v1/whatsapp/files/keep-preview?months=6",
    });
    expect(r.json()).toEqual({ files: 3, bytes: 1500 });
    const none = await (
      await h.signIn(admin)
    ).inject({
      method: "GET",
      url: "/api/v1/whatsapp/files/keep-preview?months=24",
    });
    expect(none.json()).toEqual({ files: 0, bytes: 0 });
    const bad = await (
      await h.signIn(admin)
    ).inject({
      method: "GET",
      url: "/api/v1/whatsapp/files/keep-preview?months=7",
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("files nothing points to", () => {
  it("a stranger cleared after 14 days: their file goes once it's an hour unused, never sooner", async () => {
    meta.media.set("STRANGER", { mime: "image/jpeg", bytes: Buffer.from("a stranger's photo") });
    await deliver(
      h,
      inbound({
        from: "919000000777",
        id: "wamid.STRANGER",
        type: "image",
        image: { id: "STRANGER", mime_type: "image/jpeg" },
      }),
    );
    await h.runWhatsApp();
    await h.runWhatsAppMedia();
    const [f] = await files();
    expect(f).toMatchObject({ refs: 1 });
    await h.queryAll("UPDATE whatsapp_inbox SET created_at = now() - interval '15 days'");
    await h.queryAll("UPDATE whatsapp_media SET created_at = now() - interval '15 days'");
    await sweepWhatsApp(h.pool);
    expect(await files()).toEqual([{ sha256: f!.sha256, refs: 0 }]);
    // Just used: a fetch of the same bytes could be in flight.
    expect(await sweep()).toMatchObject({ deleted: 0 });
    expect(await onDisk()).toEqual([f!.sha256]);
    await untouchedFor(2);
    expect(await sweep()).toMatchObject({ deleted: 1 });
    expect(await onDisk()).toEqual([]);
    expect(await gone()).toEqual([{ sha256: f!.sha256 }]);
  });

  it("a file that comes back after it went is off the off-site list again", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const bytes = Buffer.from("a photo that comes back");
    const p = await photo(lead, "BACK1", bytes);
    await h.queryAll("DELETE FROM whatsapp_media WHERE id = $1", [p.id]);
    await untouchedFor(2);
    await sweep();
    expect(await gone()).toHaveLength(1);
    const again = await photo(lead, "BACK2", bytes);
    expect(again.sha256).toBe(p.sha256);
    expect(await gone()).toEqual([]);
    expect(await onDisk()).toEqual([p.sha256]);
  });

  it("a count that drifted to 0 while media still point at the file: mended, never deleted", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const p = await photo(lead, "DRIFT", Buffer.from("a photo whose count drifted"));
    await h.ownerPool.query("UPDATE whatsapp_files SET refs = 0");
    await untouchedFor(2);
    expect(await sweep()).toEqual({ removed: 0, deleted: 0, mended: 1 });
    expect(await files()).toEqual([{ sha256: p.sha256, refs: 1 }]);
    expect(await onDisk()).toEqual([p.sha256]);
  });

  it("only one sweep at a time: a second one, while the first holds the lock, does nothing", async () => {
    const c = await h.pool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(hashtext('lume.whatsapp_files'))");
      expect(await sweep()).toBeNull();
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtext('lume.whatsapp_files'))");
      c.release();
    }
    expect(await sweep()).not.toBeNull();
  });
});

describe("at a thousand people's volume", () => {
  it("one sweep works through many batches of files nothing points to, each its own transaction", async () => {
    await h.ownerPool.query(
      `INSERT INTO whatsapp_files (sha256, size, last_ref_at)
       SELECT lpad(to_hex(g), 64, '0'), 1, now() - interval '2 hours' FROM generate_series(1, 2500) g`,
    );
    expect(await sweep()).toEqual({ removed: 0, deleted: 2500, mended: 0 });
    expect(await files()).toEqual([]);
    expect(await gone()).toHaveLength(2500);
  });

  it("a sweep out of time stops, and the next one goes on", async () => {
    await h.ownerPool.query(
      `INSERT INTO whatsapp_files (sha256, size, last_ref_at)
       SELECT lpad(to_hex(g), 64, '0'), 1, now() - interval '2 hours' FROM generate_series(1, 10) g`,
    );
    expect(await sweepWhatsAppFiles({ pool: h.pool, store: h.files.store, log: quiet, budgetMs: 0 })).toEqual(
      { removed: 0, deleted: 0, mended: 0 },
    );
    expect(await sweep()).toMatchObject({ deleted: 10 });
  });
});

describe("the daily scan", () => {
  it("files on disk with no row and temp files a crash left go once an hour old; young ones and others stay", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const kept = await photo(lead, "KEPT", Buffer.from("a kept photo"));
    const oldStray = await h.files.store.put(Buffer.from("an old stray"));
    const youngStray = await h.files.store.put(Buffer.from("a young stray, maybe a write in flight"));
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    await utimes(h.files.store.path(oldStray.sha256), twoHoursAgo, twoHoursAgo);
    const dir = path.join(h.files.dir, "ab");
    await mkdir(dir, { recursive: true });
    const oldTemp = path.join(dir, ".tmp-0000000000000001");
    const youngTemp = path.join(dir, ".tmp-0000000000000002");
    await writeFile(oldTemp, "half");
    await writeFile(youngTemp, "half");
    await utimes(oldTemp, twoHoursAgo, twoHoursAgo);
    // A row whose file is missing (a restore without files) is counted, not touched.
    await h.ownerPool.query("INSERT INTO whatsapp_files (sha256, size) VALUES ($1, 1)", ["f".repeat(64)]);
    expect(await scanWhatsAppFiles({ pool: h.pool, store: h.files.store, log: quiet })).toEqual({
      strays: 1,
      temps: 1,
      missing: 1,
    });
    expect(await onDisk()).toEqual([kept.sha256, youngStray.sha256].sort());
    expect((await h.files.store.scan()).temps.map((t) => path.basename(t.path))).toEqual([
      ".tmp-0000000000000002",
    ]);
  });
});
