import { createHash, randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { forgetSurvey } from "./survey";

/**
 * Settings › Storage's numbers (plan 2026-11-23-storage-clean-up, Task 1): what's on the disk by kind, each file once,
 * and what each clean-up would give back: a file's bytes only when every reference to it would go.
 */
const MB = 1024 * 1024;
let h: Harness;
let admin: { id: string; email: string; password: string };
let numberId: string;
let account: { id: string };

const sha = (name: string) => createHash("sha256").update(name).digest("hex");
/** A file on the store's books (its bytes needn't be on disk for the numbers). */
const file = async (name: string, mb: number) => {
  await h.ownerPool.query("INSERT INTO whatsapp_files (sha256, size) VALUES ($1, $2)", [
    sha(name),
    Math.round(mb * MB),
  ]);
  return sha(name);
};
const chat = (lead: string | null, f: string, o: { daysAgo?: number } = {}) =>
  h.queryAll(
    `INSERT INTO whatsapp_media (id, number_id, meta_id, lead_id, kind, mime, status, sha256, size, created_at)
     VALUES ($1, $2, $3, $4, 'image', 'image/jpeg', 'ready', $5, 1, now() - make_interval(days => $6))`,
    [randomUUID(), numberId, randomUUID(), lead, f, o.daysAgo ?? 1],
  );
const igChat = async (lead: string, f: string) => {
  const t = randomUUID();
  await h.queryAll("INSERT INTO instagram_threads (id, account_id, igsid, lead_id) VALUES ($1, $2, $3, $4)", [
    t,
    account.id,
    String(Math.floor(Math.random() * 1e15)),
    lead,
  ]);
  await h.queryAll(
    `INSERT INTO instagram_media (id, account_id, thread_id, lead_id, mid, url, kind, status, sha256, size)
     VALUES ($1, $2, $3, $4, $5, 'https://x.test/a', 'image', 'ready', $6, 1)`,
    [randomUUID(), account.id, t, lead, randomUUID(), f],
  );
};
const lead = async (o: { closedDaysAgo?: number; trashed?: boolean } = {}) => {
  const id = await h.seedLead({ ownerId: admin.id, name: "A lead" });
  if (o.closedDaysAgo !== undefined)
    await h.queryAll("UPDATE leads SET won_at = now() - make_interval(days => $2) WHERE id = $1", [
      id,
      o.closedDaysAgo,
    ]);
  if (o.trashed) await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [id]);
  return id;
};
const storage = async (closedMonths?: number) => {
  forgetSurvey();
  const r = await (
    await h.signIn(admin)
  ).inject({ method: "GET", url: `/api/v1/storage${closedMonths ? `?closedMonths=${closedMonths}` : ""}` });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as {
    disk: { total: number; free: number } | null;
    other: number | null;
    kinds: { key: string; bytes: number; files: number }[];
    candidates: { kind: string; bytes: number; files: number }[];
  };
};
const kind = (s: Awaited<ReturnType<typeof storage>>, key: string) => s.kinds.find((k) => k.key === key)!;
const cand = (s: Awaited<ReturnType<typeof storage>>, k: string) => {
  const c = s.candidates.find((x) => x.kind === k)!;
  return { bytes: c.bytes, files: c.files };
};

beforeAll(async () => {
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: "http://127.0.0.1:9", version: "v23.0" },
  });
  h.setRelayUrl("https://relay.test");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.ownerPool.query(
    `TRUNCATE leads, activities, whatsapp_media, instagram_threads, instagram_media, file_previews, message_files,
              whatsapp_template_submissions, whatsapp_files CASCADE`,
  );
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  numberId = await seedNumber(h, { runAs: admin.id });
  account = { id: randomUUID() };
  // An account that's gone (no token): its conversations' files are still on the books.
  await h.ownerPool.query(
    `INSERT INTO instagram_accounts (id, ig_user_id, username, run_as, status) VALUES ($1, '17841400000000009', 'harbour', $2, 'disconnected')`,
    [account.id, admin.id],
  );
  h.files.setDisk({ total: 100 * 1024 * MB, free: 18 * 1024 * MB });
});

describe("what's here", () => {
  it("counts each file once, in the first kind that points at it, and the database", async () => {
    const open = await lead();
    await chat(open, await file("w1", 1));
    await chat(open, await file("w2", 2));
    const both = await file("both", 4);
    await chat(open, both);
    await igChat(open, both);
    await igChat(open, await file("i1", 3));
    const s = await storage();
    expect(kind(s, "whatsapp")).toEqual({ key: "whatsapp", bytes: 7 * MB, files: 3 });
    expect(kind(s, "instagram")).toEqual({ key: "instagram", bytes: 3 * MB, files: 1 });
    expect(kind(s, "database").bytes).toBeGreaterThan(0);
    expect(s.disk).toEqual({ total: 100 * 1024 * MB, free: 18 * 1024 * MB });
    expect(s.other).toBe(100 * 1024 * MB - 18 * 1024 * MB - s.kinds.reduce((a, k) => a + k.bytes, 0));
  });

  it("a disk LUME can't read: the kinds and what it can give back still answer; the disk and the rest are null", async () => {
    h.files.setDisk(null);
    await chat(await lead(), await file("w1", 1));
    const s = await storage();
    expect(s.disk).toBeNull();
    expect(s.other).toBeNull();
    expect(kind(s, "whatsapp").bytes).toBe(MB);
  });
});

describe("what each clean-up would give back", () => {
  it("closed: files on leads won or lost over the chosen months ago, never one an open lead also has", async () => {
    const closed = await lead({ closedDaysAgo: 7 * 30 });
    const open = await lead();
    await chat(closed, await file("a", 1), { daysAgo: 300 });
    const shared = await file("b", 2);
    await chat(closed, shared, { daysAgo: 300 });
    await igChat(open, shared);
    expect(cand(await storage(), "closed")).toEqual({ bytes: MB, files: 2 });
    // Sent yesterday, after it closed: a customer still writing is still in use.
    await chat(closed, await file("after", 5));
    expect(cand(await storage(), "closed")).toEqual({ bytes: MB, files: 2 });
    expect(cand(await storage(12), "closed")).toEqual({ bytes: 0, files: 0 });
    // Reopened: no longer closed.
    await h.queryAll("UPDATE leads SET won_at = NULL WHERE id = $1", [closed]);
    expect(cand(await storage(), "closed")).toEqual({ bytes: 0, files: 0 });
    // Won long ago and in the trash: the trash's, never counted twice as closed.
    const gone = await lead({ closedDaysAgo: 400, trashed: true });
    await chat(gone, await file("c", 3));
    const s = await storage();
    expect(cand(s, "closed")).toEqual({ bytes: 0, files: 0 });
    expect(cand(s, "trash")).toEqual({ bytes: 3 * MB, files: 1 });
  });

  it("the same file twice on one closed lead counts once, and comes back whole", async () => {
    const closed = await lead({ closedDaysAgo: 400 });
    const f = await file("twice", 5);
    await chat(closed, f, { daysAgo: 500 });
    await chat(closed, f, { daysAgo: 500 });
    expect(cand(await storage(), "closed")).toEqual({ bytes: 5 * MB, files: 2 });
  });

  it("trash, previews not opened in 90 days, archived library files no template shows, every chat file over a year old", async () => {
    await chat(await lead({ trashed: true }), await file("trash", 1));
    const src = await file("src", 0.5);
    const thumb = await file("thumb", 2);
    await h.ownerPool.query(
      `INSERT INTO file_previews (sha256, state, thumb_sha256, opened_at) VALUES ($1, 'ready', $2, now() - interval '100 days')`,
      [src, thumb],
    );
    const lib = await file("lib", 3);
    await h.ownerPool.query(
      `INSERT INTO message_files (id, sha256, name, mime, kind, size, archived_at)
       VALUES ($1, $2, 'Old price list.pdf', 'application/pdf', 'document', $3, now())`,
      [randomUUID(), lib, 3 * MB],
    );
    await chat(await lead(), await file("old", 4), { daysAgo: 400 });
    const s = await storage();
    expect(cand(s, "trash")).toEqual({ bytes: MB, files: 1 });
    expect(cand(s, "previews")).toEqual({ bytes: 2 * MB, files: 1 });
    expect(cand(s, "library")).toEqual({ bytes: 3 * MB, files: 1 });
    expect(cand(s, "old")).toEqual({ bytes: 4 * MB, files: 1 });
  });

  it("Team Chat's files are its own line, whoever sent them and wherever", async () => {
    const f = await file("teamchat", 6);
    const u = (await h.queryAll<{ id: string }>("SELECT id FROM users LIMIT 1"))[0]!.id;
    await h.ownerPool.query(
      `INSERT INTO chat_files (id, uploader_id, sha256, name, mime, kind, size)
       VALUES ($1, $2, $3, 'Plan.pdf', 'application/pdf', 'document', $4)`,
      [randomUUID(), u, f, 6 * MB],
    );
    const s = await storage();
    expect(s.kinds.find((k: { key: string }) => k.key === "chat")).toEqual({
      key: "chat",
      bytes: 6 * MB,
      files: 1,
    });
  });

  it("an archived library file a WhatsApp template shows at its top stays", async () => {
    const lib = await file("header", 3);
    const fileId = randomUUID();
    await h.ownerPool.query(
      `INSERT INTO message_files (id, sha256, name, mime, kind, size, archived_at)
       VALUES ($1, $2, 'Header.png', 'image/png', 'image', $3, now())`,
      [fileId, lib, 3 * MB],
    );
    const t = await (
      await h.signIn(admin)
    ).inject({
      method: "POST",
      url: "/api/v1/templates",
      payload: { name: "Visit", category: "first_touch", body: "Hi {{first_name}}, here's our work." },
    });
    const version = (
      await h.ownerPool.query<{ current_version_id: string }>(
        "SELECT current_version_id FROM message_templates WHERE id = $1",
        [t.json().id],
      )
    ).rows[0]!.current_version_id;
    await h.ownerPool.query(
      `INSERT INTO whatsapp_template_submissions
         (id, template_version_id, waba_id, language, category, meta_name, header_file_id, status)
       VALUES ($1, $2, 'waba-1', 'en', 'MARKETING', 'visit_1', $3, 'approved')`,
      [randomUUID(), version, fileId],
    );
    expect(cand(await storage(), "library")).toEqual({ bytes: 0, files: 0 });
  });

  it("a preview opened lately stays; one with only its source file counts nothing", async () => {
    const src = await file("src2", 1);
    await h.ownerPool.query(
      `INSERT INTO file_previews (sha256, state, thumb_sha256, opened_at) VALUES ($1, 'ready', $2, now() - interval '10 days')`,
      [src, await file("fresh-thumb", 2)],
    );
    expect(cand(await storage(), "previews")).toEqual({ bytes: 0, files: 0 });
  });
});

describe("who sees it", () => {
  it("only people who manage settings; a lookback outside 3, 6, 12 or 24 months is refused", async () => {
    const rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
    expect((await (await h.signIn(rep)).inject({ method: "GET", url: "/api/v1/storage" })).statusCode).toBe(
      403,
    );
    expect(
      (await (await h.signIn(admin)).inject({ method: "GET", url: "/api/v1/storage?closedMonths=5" }))
        .statusCode,
    ).toBe(400);
  });
});
