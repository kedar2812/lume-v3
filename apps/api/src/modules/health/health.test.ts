import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingMail } from "../../mail/mailer";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { runDigests } from "../tasks/digest";
import { opsAlerts, readHealth } from "./service";

let h: Harness;
let admin: AuthedClient;
let adminId: string;
let repId: string;
let rep: AuthedClient;
const repGrants: Grant[] = [{ key: "leads.view", scope: "own" }];
const url = "/api/v1/system/health";
const health = async () => {
  const r = await admin.inject({ method: "GET", url });
  expect(r.statusCode).toBe(200);
  return r.json();
};
async function inbox(userId: string) {
  const c: pg.PoolClient = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [userId]);
    return (
      await c.query<{ kind: string; title: string }>("SELECT kind, title FROM notifications ORDER BY id")
    ).rows;
  } finally {
    await c.query("COMMIT");
    c.release();
  }
}

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  const a = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  adminId = a.id;
  admin = await h.signIn(a);
  const r = await h.seedUser({ grants: repGrants, totp: true });
  repId = r.id;
  rep = await h.signIn(r);
});
afterAll(() => h.close());

describe("System health (3C Task 5)", () => {
  it("only someone who manages settings sees it; a fresh install is healthy", async () => {
    expect((await rep.inject({ method: "GET", url })).statusCode).toBe(403);
    const s = await health();
    expect(s.problems).toEqual([]);
    expect(s.followUps).toMatchObject({ pending: 0, late: 0, firedToday: 0 });
    expect(s.digest).toMatchObject({ lastSentAt: null, sentToday: 0, failures24h: 0 });
    expect(s.noTouch).toMatchObject({ enabled: false });
    expect(s.queue).toMatchObject({ failed24h: 0 });
    expect(s.restoreTest).toEqual({ at: null, ok: null });
  });

  it("a reminder the sweeper should have caught is late, and says so in words", async () => {
    const lead = await h.seedLead({ ownerId: adminId, name: "Late Reminder" });
    const task = newId();
    await h.queryAll(
      "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Call', now() - interval '10 minutes', $1)",
      [task, lead, adminId],
    );
    await h.queryAll(
      "INSERT INTO scheduled_notifications (task_id, offset_minutes, fire_at, status) VALUES ($1, 0, now() - interval '10 minutes', 'pending'), ($1, 60, now() + interval '1 hour', 'pending')",
      [task],
    );
    const s = await health();
    expect(s.followUps).toMatchObject({ pending: 2, late: 1 });
    expect(s.problems).toContainEqual({
      key: "reminders_late",
      words: expect.stringMatching(/1 reminder is late/),
    });
    await h.queryAll(
      "UPDATE scheduled_notifications SET status = 'fired', fired_at = now() WHERE task_id = $1",
      [task],
    );
    expect((await health()).followUps).toMatchObject({ late: 0, firedToday: 2 });
  });

  it("just after LUME starts, reminders it's still catching up on aren't called late", async () => {
    const lead = await h.seedLead({ ownerId: adminId, name: "Caught Up" });
    const task = newId();
    await h.queryAll(
      "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Call', now() - interval '3 hours', $1)",
      [task, lead, adminId],
    );
    await h.queryAll(
      "INSERT INTO scheduled_notifications (task_id, offset_minutes, fire_at, status) VALUES ($1, 0, now() - interval '3 hours', 'pending')",
      [task],
    );
    const keys = async (startedAt: Date) =>
      (await readHealth(h.pool, { startedAt })).problems.map((p) => p.key);
    expect(await keys(new Date(Date.now() - 60_000))).not.toContain("reminders_late");
    expect(await keys(new Date(Date.now() - 10 * 60_000))).toContain("reminders_late");
    await h.queryAll(
      "UPDATE scheduled_notifications SET status = 'fired', fired_at = now() WHERE task_id = $1",
      [task],
    );
  });

  it("morning emails that keep failing, a source that needs attention, and a failed restore test", async () => {
    // A failed send is written down (no names), and counted.
    const broken = { send: async () => Promise.reject(new Error("SMTP down")) };
    await h.ownerPool.query(
      `UPDATE users SET preferences = jsonb_build_object('digestTime', '00:00', 'workingDays', '[0,1,2,3,4,5,6]'::jsonb) WHERE id = $1`,
      [adminId],
    );
    const lead = await h.seedLead({ ownerId: adminId, name: "Digest Item" });
    await h.queryAll(
      "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Call', now() - interval '1 day', $1)",
      [newId(), lead, adminId],
    );
    for (let i = 0; i < 3; i++)
      await runDigests({ pool: h.pool, mailer: broken, publicUrl: "https://crm.example.test" });
    const failed = await h.queryAll<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM ops_events WHERE kind = 'digest.failed'",
    );
    expect(failed).toHaveLength(3);
    expect(failed[0]!.detail).toEqual({ userId: adminId });

    await h.pool.query(
      "INSERT INTO lead_sources (id, type, name, status) VALUES ($1, 'webhook', 'Site form', 'needs_attention')",
      [newId()],
    );
    await h.pool
      .query(
        "INSERT INTO ops_restore_tests (started_at, finished_at, backup_name, ok) VALUES (now(), now(), 'x', false)",
      )
      .catch(async () =>
        h.ownerPool.query(
          "INSERT INTO ops_restore_tests (started_at, finished_at, backup_name, ok) VALUES (now(), now(), 'x', false)",
        ),
      );
    const s = await health();
    expect(s.digest.failures24h).toBe(3);
    expect(s.sources).toContainEqual(
      expect.objectContaining({ name: "Site form", status: "needs_attention" }),
    );
    expect(s.restoreTest.ok).toBe(false);
    const keys = s.problems.map((p: { key: string }) => p.key);
    expect(keys).toEqual(expect.arrayContaining(["digest_failing", "restore_test"]));
    expect(keys.some((k: string) => k.startsWith("source:"))).toBe(true);
    for (const p of s.problems) expect(p.words).not.toContain(p.key); // words, never its key
  });

  it("each problem reaches the admins once a business day, in the app and by email; never a rep", async () => {
    const sent: OutgoingMail[] = [];
    const mailer = { send: async (m: OutgoingMail) => void sent.push(m) };
    const now = new Date();
    await opsAlerts({ app: h.app, pool: h.pool, mailer }, now);
    await opsAlerts({ app: h.app, pool: h.pool, mailer }, now);
    const mine = (await inbox(adminId)).filter((n) => n.kind === "system_alert");
    const problems = (await health()).problems;
    const keys = problems.length;
    expect(mine).toHaveLength(keys);
    expect((await inbox(repId)).some((n) => n.kind === "system_alert")).toBe(false);
    expect(sent.filter((m) => m.to.includes("@"))).toHaveLength(keys);
    // The next business day, what's still wrong is said again (the email failures are over a day old
    // by then, so that one has cleared).
    const later = new Date(now.getTime() + 26 * 3_600_000);
    const still = (await readHealth(h.pool, { now: later })).problems.length;
    expect(still).toBeLessThan(keys);
    await opsAlerts({ app: h.app, pool: h.pool, mailer }, later);
    expect((await inbox(adminId)).filter((n) => n.kind === "system_alert")).toHaveLength(keys + still);
  });
});

describe("System health: 3C final review", () => {
  it("Important 2: two processes at once say each problem once", async () => {
    const sent: OutgoingMail[] = [];
    const mailer = { send: async (m: OutgoingMail) => void sent.push(m) };
    const day = new Date(Date.now() + 5 * 24 * 3_600_000);
    const before = (await inbox(adminId)).filter((n) => n.kind === "system_alert").length;
    const keys = (await readHealth(h.pool, { now: day })).problems.length;
    expect(keys).toBeGreaterThan(0);
    await Promise.all([
      opsAlerts({ app: h.app, pool: h.pool, mailer }, day),
      opsAlerts({ app: h.app, pool: h.pool, mailer }, day),
    ]);
    expect((await inbox(adminId)).filter((n) => n.kind === "system_alert").length - before).toBe(keys);
    expect(sent).toHaveLength(keys);
  });

  it("one person's bad address, while others' emails go, isn't the mail server", async () => {
    await h.queryAll("DELETE FROM ops_events WHERE kind = 'digest.failed'");
    for (let i = 0; i < 4; i++)
      await h.queryAll("INSERT INTO ops_events (kind, ok, detail) VALUES ('digest.failed', false, $1)", [
        { userId: repId },
      ]);
    await h.queryAll(
      "INSERT INTO digest_runs (user_id, local_date, items, sent_at) VALUES ($1, current_date, 2, now()) ON CONFLICT DO NOTHING",
      [adminId],
    );
    const keys = (await health()).problems.map((p: { key: string }) => p.key);
    expect(keys).not.toContain("digest_failing");
  });
});

/** Storage (2026-10-19): how full the server's disk is, what LUME keeps, and a word before it fills. */
describe("System health: storage", () => {
  const GB = 1024 ** 3;
  const filesWith = (disk: { total: number; free: number } | null, writable = true) => ({
    store: { ...h.files.store, writable: async () => writable },
    disk: async () => disk,
  });
  const keys = (x: { problems: { key: string }[] }) => x.problems.map((p) => p.key);
  const whatsapp = (enabled: boolean) =>
    h.ownerPool.query(
      "UPDATE settings SET integrations = jsonb_set(integrations, '{whatsapp}', $1::jsonb) WHERE id = 1",
      [JSON.stringify({ enabled })],
    );

  it("the card: the disk, the database and WhatsApp's files, in bytes", async () => {
    await h.ownerPool.query("INSERT INTO whatsapp_files (sha256, size) VALUES ($1, 300), ($2, 700)", [
      "1".repeat(64),
      "2".repeat(64),
    ]);
    try {
      const s = await health();
      expect(s.storage).toMatchObject({ diskTotal: 100 * GB, diskFree: 60 * GB, whatsappFiles: 1000 });
      expect(s.storage.database).toBeGreaterThan(1024 * 1024);
      expect(keys(s)).not.toContain("disk_full");
    } finally {
      await h.ownerPool.query("DELETE FROM whatsapp_files");
    }
  });

  it("85% full or more: a problem in words, with what's left and what to do", async () => {
    const s = await readHealth(h.pool, { files: filesWith({ total: 100 * GB, free: 8.2 * GB }) });
    expect(s.problems).toContainEqual({
      key: "disk_full",
      words:
        "The server's disk is 92% full (8.2 GB left). Keep WhatsApp files for fewer months in Integrations, or move LUME to a bigger server.",
    });
    const fine = await readHealth(h.pool, { files: filesWith({ total: 100 * GB, free: 15.5 * GB }) });
    expect(keys(fine)).not.toContain("disk_full");
  });

  it("a disk LUME can't read is 'not known', never an alarm; the rest of the page still loads", async () => {
    const s = await readHealth(h.pool, { files: filesWith(null) });
    expect(s.storage).toMatchObject({ diskTotal: null, diskFree: null });
    expect(keys(s)).not.toContain("disk_full");
    const none = await readHealth(h.pool, {});
    expect(none.storage).toMatchObject({ diskTotal: null, diskFree: null, whatsappFiles: 0 });
  });

  it("a files folder LUME can't write is a problem only while WhatsApp is on", async () => {
    await whatsapp(false);
    expect(keys(await readHealth(h.pool, { files: filesWith(null, false) }))).not.toContain(
      "files_unwritable",
    );
    await whatsapp(true);
    try {
      expect((await readHealth(h.pool, { files: filesWith(null, false) })).problems).toContainEqual({
        key: "files_unwritable",
        words: "LUME can't write WhatsApp files on this server. Check the files volume.",
      });
      expect(keys(await readHealth(h.pool, { files: filesWith(null, true) }))).not.toContain(
        "files_unwritable",
      );
    } finally {
      await whatsapp(false);
    }
  });

  it("files that haven't reached the backup in over a day are a problem; a new install's first day isn't", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 40 * 3_600_000);
    await h.ownerPool.query("INSERT INTO whatsapp_files (sha256, size, created_at) VALUES ($1, 10, $2)", [
      "3".repeat(64),
      now,
    ]);
    try {
      // Kept today, no backup yet: the first one comes within 6 hours.
      expect(keys(await readHealth(h.pool, { now }))).not.toContain("files_backup");
      await h.ownerPool.query("UPDATE whatsapp_files SET created_at = $1", [old]);
      expect((await readHealth(h.pool, { now })).problems).toContainEqual({
        key: "files_backup",
        words: "WhatsApp files haven't reached the backup for over a day. Check the worker.",
      });
      await h.queryAll(
        "INSERT INTO ops_events (kind, ok, detail, at) VALUES ('backup.files', false, '{}', $1)",
        [new Date(now.getTime() - 3_600_000)],
      );
      expect(keys(await readHealth(h.pool, { now }))).toContain("files_backup");
      await h.queryAll(
        "INSERT INTO ops_events (kind, ok, detail, at) VALUES ('backup.files', true, '{}', $1)",
        [new Date(now.getTime() - 2 * 3_600_000)],
      );
      expect(keys(await readHealth(h.pool, { now }))).not.toContain("files_backup");
    } finally {
      await h.ownerPool.query("DELETE FROM whatsapp_files");
      await h.queryAll("DELETE FROM ops_events WHERE kind = 'backup.files'");
    }
  });
});
