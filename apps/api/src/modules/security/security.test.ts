import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { ALL_GRANTS, type RuleId } from "@lume/core";
import { schema } from "@lume/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import type { Db } from "../../db/context";
import { raiseAlert } from "./alerts";
import { countFor } from "./counts";
import { restoreUser, suspendUser, tellAdmins } from "./suspend";

let h: Harness;
let owner: SeededUser;
let admin: SeededUser;
let rory: SeededUser;
let sam: SeededUser;
const TZ = "Asia/Dubai";

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  owner = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  admin = await h.seedUser({
    grants: [{ key: "security.manage", scope: null }],
    totp: true,
    name: "Hana Ito",
  });
});
afterAll(() => h.close());
// The audit log is append-only, so every test watches people of its own.
beforeEach(async () => {
  rory = await h.seedUser({ grants: [{ key: "leads.contact.reveal", scope: "own" }], name: "Rory Reid" });
  sam = await h.seedUser({ grants: [{ key: "leads.contact.reveal", scope: "own" }], name: "Sam Okafor" });
});

/** One of LUME's own connections, as the 5-minute sweep holds it. */
async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const c = await h.pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(drizzle(c, { schema }));
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

/** `n` audit rows of one act, `ago` before the database's now, on `leads` different records (cycling). */
async function acts(user: string, action: string, n: number, o: { ago?: string; leads?: number } = {}) {
  await h.ownerPool.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, at)
     SELECT $1, $2, 'lead', ('0190e0c0-0000-7000-8000-' || lpad(((g % $4) + 1)::text, 12, '0'))::uuid,
            now() - $5::interval
       FROM generate_series(0, $3 - 1) g`,
    [user, action, n, o.leads ?? n, o.ago ?? "1 minute"],
  );
}
/** Every notification, as the nightly backup reads them (they are each person's own under row-level security). */
async function backup<R>(text: string, params: unknown[] = []): Promise<R[]> {
  const c = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as R[];
  } finally {
    await c.end();
  }
}
const count = (user: string, rule: RuleId) => withDb((db) => countFor(db, user, rule, TZ));

describe("counting the watched acts (6A Task 2)", () => {
  it("counts reveals over the last 60 minutes, not older", async () => {
    await acts(rory.id, "lead.contact.reveal", 31, { ago: "59 minutes" });
    await acts(rory.id, "lead.contact.reveal", 5, { ago: "61 minutes" });
    expect((await count(rory.id, "reveals")).observed).toBe(31);
  });

  it("counts different leads opened: a drawer refetching one lead is one", async () => {
    await acts(rory.id, "lead.view", 300, { leads: 1 });
    expect((await count(rory.id, "leadsOpened")).observed).toBe(1);
    await acts(rory.id, "lead.view", 201);
    expect((await count(rory.id, "leadsOpened")).observed).toBe(201);
  });

  it("counts send-queue runs since the start of the business's day, not UTC's", async () => {
    // One second after the business's midnight (counted), and one second before it (yesterday's).
    await h.ownerPool.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, at)
       SELECT $1, 'queue.started', 'send_queue', d.start + s.shift
         FROM (SELECT date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2 AS start) d,
              (VALUES (interval '1 second'), (interval '-1 second')) s(shift)`,
      [rory.id, TZ],
    );
    expect((await count(rory.id, "queueRuns")).observed).toBe(1);
  });

  it("never counts what happened before an admin restored them", async () => {
    await acts(rory.id, "lead.contact.reveal", 31, { ago: "20 minutes" });
    await h.ownerPool.query("UPDATE users SET watch_from = now() - interval '10 minutes' WHERE id = $1", [
      rory.id,
    ]);
    await acts(rory.id, "lead.contact.reveal", 2, { ago: "5 minutes" });
    expect((await count(rory.id, "reveals")).observed).toBe(2);
  });

  it("counts different leads' contacts: the same contact revealed again counts once (6A final review)", async () => {
    await acts(rory.id, "lead.contact.reveal", 40, { leads: 1 });
    expect((await count(rory.id, "reveals")).observed).toBe(1);
    await acts(rory.id, "lead.contact.reveal", 31);
    expect((await count(rory.id, "reveals")).observed).toBe(31);
  });

  it("counts one person only", async () => {
    await acts(sam.id, "lead.contact.reveal", 40);
    expect((await count(rory.id, "reveals")).observed).toBe(0);
  });
});

describe("one alert per person, rule and window (ruling R3)", () => {
  const raise = (observed: number, action: "alerted" | "suspended" = "alerted") =>
    withDb((db) =>
      raiseAlert(db, { userId: rory.id, rule: "reveals", observed, threshold: 30, action, tz: TZ }),
    );

  it("a second breach in the window adds to the first alert", async () => {
    const a = await raise(31);
    const b = await raise(35, "suspended");
    const c = await raise(33);
    expect(a.isNew).toBe(true);
    // Grown into a pause: admins are told again, that LUME paused them (6A final review).
    expect(b).toEqual({ id: a.id, isNew: false, upgraded: true });
    expect(c).toEqual({ id: a.id, isNew: false, upgraded: false });
    const rows = (
      await h.pool.query("SELECT observed, action FROM security_alerts WHERE user_id = $1", [rory.id])
    ).rows;
    expect(rows).toEqual([{ observed: 35, action: "suspended" }]);
  });

  it("a dismissed alert still covers its window: no new alert, nobody told again (6A final review)", async () => {
    const a = await raise(31);
    await h.ownerPool.query(
      "UPDATE security_alerts SET status = 'resolved', resolution = 'dismissed', resolved_at = now() WHERE id = $1",
      [a.id],
    );
    const b = await raise(36);
    expect(b).toEqual({ id: a.id, isNew: false, upgraded: false });
    const rows = (
      await h.pool.query("SELECT status, resolution, observed FROM security_alerts WHERE user_id = $1", [
        rory.id,
      ])
    ).rows;
    expect(rows).toEqual([{ status: "resolved", resolution: "dismissed", observed: 36 }]);
  });

  it("a dismissed alert-only alert doesn't hide a pause: a pause rule still pauses, in a new alert", async () => {
    const a = await raise(31);
    await h.ownerPool.query(
      "UPDATE security_alerts SET status = 'resolved', resolution = 'dismissed', resolved_at = now() WHERE id = $1",
      [a.id],
    );
    const b = await raise(32, "suspended");
    expect(b.isNew).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  it("a breach after the window opens a new alert", async () => {
    const a = await raise(31);
    await h.ownerPool.query(
      "UPDATE security_alerts SET window_end = now() - interval '61 minutes' WHERE id = $1",
      [a.id],
    );
    const b = await raise(32);
    expect(b.isNew).toBe(true);
    expect(b.id).not.toBe(a.id);
  });

  it("a new alert is audited as LUME's own act", async () => {
    const a = await raise(31);
    const row = (
      await h.pool.query(
        "SELECT actor_user_id, diff FROM audit_log WHERE action = 'security.alert' AND entity_id = $1",
        [a.id],
      )
    ).rows[0];
    expect(row).toEqual({
      actor_user_id: null,
      diff: { userId: rory.id, rule: "reveals", observed: 31, threshold: 30 },
    });
  });
});

describe("pausing someone", () => {
  it("suspends them and ends every session, naming each device", async () => {
    await h.signIn(rory);
    await h.ownerPool.query("UPDATE sessions SET user_agent = $2 WHERE user_id = $1", [
      rory.id,
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    ]);
    const r = await withDb((db) => suspendUser(db, rory.id, h.clock.now, "alert-1"));
    expect(r.sessionsEnded).toEqual(["Chrome · Windows"]);
    const u = (await h.pool.query("SELECT status FROM users WHERE id = $1", [rory.id])).rows[0];
    expect(u.status).toBe("suspended");
    const live = (
      await h.pool.query(
        "SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
        [rory.id],
      )
    ).rows[0];
    expect(live.n).toBe(0);
    const reasons = (
      await h.pool.query("SELECT DISTINCT revoked_reason FROM sessions WHERE user_id = $1", [rory.id])
    ).rows;
    expect(reasons).toEqual([{ revoked_reason: "suspended" }]);
    const a = (
      await h.pool.query(
        "SELECT actor_user_id, diff FROM audit_log WHERE action = 'security.suspended' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
        [rory.id],
      )
    ).rows[0];
    expect(a).toEqual({ actor_user_id: null, diff: { alertId: "alert-1", sessions: ["Chrome · Windows"] } });
  });

  it("pausing someone already paused changes nothing", async () => {
    await withDb((db) => suspendUser(db, rory.id, h.clock.now, null));
    const again = await withDb((db) => suspendUser(db, rory.id, h.clock.now, null));
    expect(again).toEqual({ suspended: false, sessionsEnded: [] });
  });

  it("tells the owner and every security admin — never the person — without numbers in the title", async () => {
    const a = await withDb((db) =>
      raiseAlert(db, {
        userId: rory.id,
        rule: "reveals",
        observed: 34,
        threshold: 30,
        action: "suspended",
        tz: TZ,
      }),
    );
    await tellAdmins(h.pool, a.id);
    const rows = await backup<{ user_id: string; title: string; body: string }>(
      "SELECT user_id, title, body FROM notifications WHERE kind = 'security_alert' AND data->>'alertId' = $1",
      [a.id],
    );
    expect(rows.map((r) => r.user_id).sort()).toEqual([owner.id, admin.id].sort());
    expect(rows[0]!.title).toBe("LUME paused Rory Reid’s access");
    expect(rows[0]!.title).not.toMatch(/\d/);
    expect(rows[0]!.body).toMatch(/34 contacts opened in \d+ minutes?/);
    const told = (
      await h.pool.query("SELECT diff FROM audit_log WHERE action = 'security.notified' AND entity_id = $1", [
        a.id,
      ])
    ).rows[0];
    expect([...told.diff.names].sort()).toEqual(["Hana Ito", "Maya Kapoor"]);
  });

  it("never tells a watched admin about themselves (6A final review)", async () => {
    const lead = await h.seedUser({
      grants: [
        { key: "security.manage", scope: null },
        { key: "leads.contact.full", scope: "team" },
      ],
      totp: true,
      name: "Tara Lead",
    });
    const a = await withDb((db) =>
      raiseAlert(db, {
        userId: lead.id,
        rule: "queueRuns",
        observed: 4,
        threshold: 3,
        action: "alerted",
        tz: TZ,
      }),
    );
    await tellAdmins(h.pool, a.id);
    const rows = await backup<{ user_id: string }>(
      "SELECT user_id FROM notifications WHERE data->>'alertId' = $1",
      [a.id],
    );
    expect(rows.map((r) => r.user_id)).not.toContain(lead.id);
    expect(rows.map((r) => r.user_id)).toContain(owner.id);
  });

  it("an alert-only breach says what they did, not that LUME paused them", async () => {
    const a = await withDb((db) =>
      raiseAlert(db, {
        userId: rory.id,
        rule: "queueRuns",
        observed: 4,
        threshold: 3,
        action: "alerted",
        tz: TZ,
      }),
    );
    await tellAdmins(h.pool, a.id);
    const [row] = await backup<{ title: string }>(
      "SELECT title FROM notifications WHERE data->>'alertId' = $1 LIMIT 1",
      [a.id],
    );
    expect(row!.title).toBe("Rory Reid ran a lot of send queues today");
  });
});

describe("restoring someone (ruling R10)", () => {
  it("only a paused person can be restored", async () => {
    await expect(withDb((db) => restoreUser(db, rory.id, owner.id))).rejects.toMatchObject({
      status: 409,
      code: "NOT_SUSPENDED",
    });
  });

  it("lets them back in, starts counting afresh, and resolves every open alert of theirs", async () => {
    const a = await withDb((db) =>
      raiseAlert(db, {
        userId: rory.id,
        rule: "reveals",
        observed: 31,
        threshold: 30,
        action: "suspended",
        tz: TZ,
      }),
    );
    const b = await withDb((db) =>
      raiseAlert(db, {
        userId: rory.id,
        rule: "queueRuns",
        observed: 4,
        threshold: 3,
        action: "alerted",
        tz: TZ,
      }),
    );
    await withDb((db) => suspendUser(db, rory.id, h.clock.now, a.id));
    await withDb((db) => restoreUser(db, rory.id, owner.id));
    const u = (
      await h.pool.query("SELECT status, watch_from IS NOT NULL AS watched FROM users WHERE id = $1", [
        rory.id,
      ])
    ).rows[0];
    expect(u).toEqual({ status: "active", watched: true });
    const alerts = (
      await h.pool.query(
        "SELECT id, status, resolution, resolved_by FROM security_alerts WHERE id = ANY($1) ORDER BY id",
        [[a.id, b.id]],
      )
    ).rows;
    for (const x of alerts)
      expect(x).toMatchObject({ status: "resolved", resolution: "restored", resolved_by: owner.id });
    const audited = (
      await h.pool.query(
        "SELECT actor_user_id FROM audit_log WHERE action = 'security.restored' AND entity_id = $1",
        [rory.id],
      )
    ).rows;
    expect(audited).toEqual([{ actor_user_id: owner.id }]);
  });
});
