import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { sweepWhatsAppFiles } from "../whatsapp/keep";
import { suggestStorage } from "./suggest";
import { forgetSurvey } from "./survey";

/**
 * The suggestion and the settings (plan 2026-11-23-storage-clean-up, Task 3): past the admins' mark, with room to
 * give back, each admin hears once a day; one keep-for clears every chat's old files, Instagram's too.
 */
const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY = 86_400_000;
let h: Harness;
let admin: { id: string; email: string; password: string };
let numberId: string;

const told = async () =>
  (
    (await (await h.signIn(admin)).inject({ method: "GET", url: "/api/v1/notifications" })).json().items as {
      title: string;
      body: string;
    }[]
  ).filter((n) => n.title.startsWith("The server is"));
const roomOnAClosedLead = async (mb: number) => {
  const sha = randomUUID().replace(/-/g, "").padEnd(64, "0");
  await h.ownerPool.query("INSERT INTO whatsapp_files (sha256, size) VALUES ($1, $2)", [sha, mb * MB]);
  const lead = await h.seedLead({ ownerId: admin.id, name: "Closed" });
  await h.queryAll("UPDATE leads SET won_at = now() - interval '200 days' WHERE id = $1", [lead]);
  await h.queryAll(
    `INSERT INTO whatsapp_media (id, number_id, meta_id, lead_id, kind, mime, status, sha256, size, created_at)
     VALUES ($1, $2, $3, $4, 'image', 'image/jpeg', 'ready', $5, 1, now() - interval '300 days')`,
    [randomUUID(), numberId, randomUUID(), lead, sha],
  );
};
const put = async (body: Record<string, unknown>) =>
  (await h.signIn(admin)).inject({ method: "PUT", url: "/api/v1/storage/settings", payload: body });

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
    "TRUNCATE leads, activities, whatsapp_media, instagram_media, notifications, whatsapp_files CASCADE",
  );
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("UPDATE settings SET integrations = integrations - 'storage' WHERE id = 1");
  numberId = await seedNumber(h, { runAs: admin.id });
  h.files.setDisk({ total: 100 * GB, free: 18 * GB });
  forgetSurvey();
});

describe("the suggestion", () => {
  it("past the mark with room to give back: the admins hear once a day, with how much", async () => {
    await roomOnAClosedLead(20);
    const now = new Date();
    expect(await suggestStorage(h.pool, h.files, now)).toBe(true);
    expect(await told()).toEqual([
      expect.objectContaining({
        title: "The server is 82% full",
        body: "LUME can give back 20 MB. Nothing on an open lead.",
      }),
    ]);
    expect(await suggestStorage(h.pool, h.files, new Date(now.getTime() + 3_600_000))).toBe(false);
    forgetSurvey();
    expect(await suggestStorage(h.pool, h.files, new Date(now.getTime() + DAY + 60_000))).toBe(true);
    expect(await told()).toHaveLength(2);
  });

  it("two LUME processes checking at the same moment: the admins hear once", async () => {
    await roomOnAClosedLead(20);
    const now = new Date();
    const said = await Promise.all([
      suggestStorage(h.pool, h.files, now),
      suggestStorage(h.pool, h.files, now),
    ]);
    expect(said.filter(Boolean)).toHaveLength(1);
    expect(await told()).toHaveLength(1);
  });

  it("under the mark, or nothing to give back: nothing; the mark is the admins' own", async () => {
    await roomOnAClosedLead(20);
    h.files.setDisk({ total: 100 * GB, free: 25 * GB }); // 75%
    expect(await suggestStorage(h.pool, h.files, new Date())).toBe(false);
    expect((await put({ warnAtPct: 70 })).statusCode).toBe(200);
    expect(await suggestStorage(h.pool, h.files, new Date())).toBe(true);
    await h.ownerPool.query("UPDATE settings SET integrations = integrations - 'storage' WHERE id = 1");
    await h.ownerPool.query("TRUNCATE whatsapp_media, whatsapp_files CASCADE");
    forgetSurvey();
    h.files.setDisk({ total: 100 * GB, free: 5 * GB });
    expect(await suggestStorage(h.pool, h.files, new Date())).toBe(false);
  });
});

describe("the settings", () => {
  it("change within the choices, audited; anything else refused", async () => {
    const r = await put({ warnAtPct: 90, keepFilesMonths: 12 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().settings).toEqual({ warnAtPct: 90, keepFilesMonths: 12 });
    const audit = await h.queryAll<{ diff: Record<string, unknown> }>(
      "SELECT diff FROM audit_log WHERE action = 'storage.settings' ORDER BY id DESC LIMIT 1",
    );
    expect(audit[0]!.diff).toEqual({
      warnAtPct: { from: 80, to: 90 },
      keepFilesMonths: { from: null, to: 12 },
    });
    for (const bad of [{ warnAtPct: 75 }, { keepFilesMonths: 5 }, {}, { other: 1 }])
      expect((await put(bad)).statusCode).toBe(400);
  });

  it("the keep-for months clear Instagram's old files too, each saying so", async () => {
    await put({ keepFilesMonths: 3 });
    const account = randomUUID();
    const thread = randomUUID();
    await h.ownerPool.query(
      `INSERT INTO instagram_accounts (id, ig_user_id, username, run_as, status) VALUES ($1, '17841400000000019', 'old', $2, 'disconnected')`,
      [account, admin.id],
    );
    await h.queryAll("INSERT INTO instagram_threads (id, account_id, igsid) VALUES ($1, $2, '1')", [
      thread,
      account,
    ]);
    const sha = "f".repeat(64);
    await h.ownerPool.query("INSERT INTO whatsapp_files (sha256, size) VALUES ($1, 10)", [sha]);
    await h.queryAll(
      `INSERT INTO instagram_media (id, account_id, thread_id, mid, url, kind, status, sha256, size, created_at)
       VALUES ($1, $2, $3, 'm1', 'https://x.test/a', 'image', 'ready', $4, 10, now() - interval '4 months')`,
      [randomUUID(), account, thread, sha],
    );
    await sweepWhatsAppFiles({ pool: h.pool, store: h.files.store, log: h.app.log });
    const [m] = await h.queryAll<{ status: string; problem: string }>(
      "SELECT status, problem FROM instagram_media",
    );
    expect(m).toEqual({
      status: "removed",
      problem: "LUME keeps chat files for 3 months. This one is still in Instagram.",
    });
  });
});
