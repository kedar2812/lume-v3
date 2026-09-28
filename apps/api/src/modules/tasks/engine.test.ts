import { ALL_GRANTS, newId } from "@lume/core";
import { schema } from "@lume/db";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { cancelReminders, fire, schedule, sweep } from "./engine";

let h: Harness;
let rep: string;
const MIN = 60_000;

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  rep = (
    await h.seedUser({
      grants: (["leads.view", "leads.create", "leads.edit"] as const).map((key) => ({
        key,
        scope: "own" as const,
      })),
      totp: true,
    })
  ).id;
  await h.seedUser({ grants: ALL_GRANTS, totp: true });
});
afterAll(() => h.close());

const db = () => drizzle(h.pool, { schema });
const deps = () => ({ app: h.app, pool: h.pool });

/** A follow-up on a lead the rep owns, due at `due`, with its reminders scheduled. */
async function followUp(
  o: { due: Date; remind?: number[]; name?: string; phone?: string } = { due: new Date() },
) {
  const leadId = await h.seedLead({
    ownerId: rep,
    name: o.name ?? "Aisha Khan",
    phone: o.phone ?? "+971501234567",
  });
  const id = newId();
  await h.queryAll(
    "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, remind_minutes, series_id) VALUES ($1, $2, $3, 'Follow up', $4, $5, $1)",
    [id, leadId, rep, o.due, o.remind ?? [0]],
  );
  // Set earlier than its time (as a real one would be), so a follow-up already due still has its reminders.
  const setAt = new Date(Math.min(Date.now(), o.due.getTime() - 10 * MIN));
  const ids = await schedule(
    db(),
    { id, dueAt: o.due, remindMinutes: o.remind ?? [0], status: "open" },
    setAt,
  );
  return { id, leadId, ids };
}
/** Notifications are only ever their recipient's (FORCE row-level security): read them as the rep. */
async function asRep<R extends pg.QueryResultRow>(sql: string, params: unknown[]) {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [rep]);
    const r = await c.query<R>(sql, params);
    await c.query("COMMIT");
    return r.rows;
  } finally {
    c.release();
  }
}
const notes = (taskId: string) =>
  asRep<{ kind: string; title: string; body: string | null; user_id: string }>(
    "SELECT kind, title, body, user_id FROM notifications WHERE task_id = $1 ORDER BY id",
    [taskId],
  );
const row = async (id: number) =>
  (await h.pool.query("SELECT status, fire_at FROM scheduled_notifications WHERE id = $1", [id])).rows[0];

describe("schedule", () => {
  it("one row per reminder, none already well past, and a reschedule replaces the pending ones", async () => {
    const due = new Date(Date.now() + 60 * MIN);
    const t = await followUp({ due, remind: [0, 15, 120] }); // 120 min before is already past
    expect(t.ids).toHaveLength(2);
    const later = new Date(due.getTime() + 60 * MIN);
    const again = await schedule(
      db(),
      { id: t.id, dueAt: later, remindMinutes: [0], status: "open" },
      new Date(),
    );
    expect(again).toHaveLength(1);
    const pending = (
      await h.pool.query(
        "SELECT offset_minutes, fire_at FROM scheduled_notifications WHERE task_id = $1 AND status = 'pending'",
        [t.id],
      )
    ).rows;
    expect(pending).toEqual([{ offset_minutes: 0, fire_at: later }]);
  });

  it("cancelReminders stops every pending one", async () => {
    const t = await followUp({ due: new Date(Date.now() + 30 * MIN), remind: [0, 15] });
    await cancelReminders(db(), t.id);
    for (const id of t.ids) expect((await row(id)).status).toBe("cancelled");
  });
});

describe("fire (the reliability suite, spec §8)", () => {
  it("writes the notification with the lead's name only, and marks the reminder fired", async () => {
    const t = await followUp({
      due: new Date(Date.now() + 15 * MIN),
      remind: [0, 15],
      name: "Omar Ali",
      phone: "+971509998887",
    });
    const soon = t.ids[0]!; // 15 min before comes first
    expect(await fire(deps(), soon)).toBe("fired");
    const [n] = await notes(t.id);
    expect(n).toMatchObject({ kind: "follow_up_soon", user_id: rep });
    expect(n!.title).toContain("Omar Ali");
    expect(`${n!.title} ${n!.body}`).not.toMatch(/9998887|@/);
    expect(n!.body).toBe("In 15 min");
    expect((await row(soon)).status).toBe("fired");
  });

  it("Review Focus 2: the job twice, and the sweeper at the same time, make one notification", async () => {
    const t = await followUp({ due: new Date(Date.now() - 2 * MIN) });
    await Promise.all([fire(deps(), t.ids[0]!), fire(deps(), t.ids[0]!), sweep(deps(), new Date())]);
    expect(await notes(t.id)).toHaveLength(1);
  });

  it("Review Focus 1: a reminder whose job never ran is fired by the sweeper once", async () => {
    const t = await followUp({ due: new Date(Date.now() - 60_000) });
    expect(await sweep(deps(), new Date())).toBeGreaterThanOrEqual(1);
    await sweep(deps(), new Date());
    expect(await notes(t.id)).toHaveLength(1);
  });

  it("accuracy: the sweeper leaves a reminder alone until 30 s after its time", async () => {
    const due = new Date(Date.now() + 5 * MIN);
    const t = await followUp({ due });
    await sweep(deps(), new Date(due.getTime() - 1000));
    expect((await row(t.ids[0]!)).status).toBe("pending");
    await sweep(deps(), new Date(due.getTime() + 31_000));
    expect((await row(t.ids[0]!)).status).toBe("fired");
  });

  it("crash: a fire that locked the row and died is picked up by the next sweep, once", async () => {
    const t = await followUp({ due: new Date(Date.now() - 2 * MIN) });
    const holder: pg.PoolClient = await h.ownerPool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM scheduled_notifications WHERE id = $1 FOR UPDATE", [t.ids[0]]); // the dying job
    await sweep(deps(), new Date()); // skips the locked row rather than waiting on it
    expect((await row(t.ids[0]!)).status).toBe("pending");
    await holder.query("ROLLBACK"); // the process died: its transaction is gone
    holder.release();
    await sweep(deps(), new Date());
    expect(await notes(t.id)).toHaveLength(1);
  });

  it("a done or cancelled follow-up's reminders tell nobody anything", async () => {
    const t = await followUp({ due: new Date(Date.now() - 2 * MIN) });
    await h.queryAll("UPDATE tasks SET status = 'done' WHERE id = $1", [t.id]);
    expect(await fire(deps(), t.ids[0]!)).toBe("skipped");
    expect(await notes(t.id)).toHaveLength(0);
    expect((await row(t.ids[0]!)).status).toBe("fired");
  });

  it("Review Focus 4: when the assignee can no longer see the lead, nothing names it", async () => {
    const t = await followUp({ due: new Date(Date.now() - 2 * MIN), name: "Hidden Person" });
    const other = (await h.seedUser({ grants: [], totp: true })).id;
    await h.queryAll("UPDATE leads SET owner_id = $2 WHERE id = $1", [t.leadId, other]);
    expect(await fire(deps(), t.ids[0]!)).toBe("skipped");
    expect(await asRep("SELECT 1 FROM notifications WHERE title LIKE '%Hidden Person%'", [])).toHaveLength(0);
  });

  it("tells the live stream who it's for and which notification", async () => {
    const t = await followUp({ due: new Date(Date.now() - 2 * MIN) });
    const c = await h.pool.connect();
    const heard: string[] = [];
    c.on("notification", (m) => heard.push(m.payload ?? ""));
    await c.query("LISTEN lume_notifications");
    await fire(deps(), t.ids[0]!);
    await new Promise((r) => setTimeout(r, 100));
    await c.query("UNLISTEN lume_notifications");
    c.release();
    const [n] = await asRep<{ id: string }>("SELECT id FROM notifications WHERE task_id = $1", [t.id]);
    expect(heard.map((p) => JSON.parse(p))).toContainEqual({ u: rep, n: Number(n!.id) });
  });
});

describe("3A final review", () => {
  it("Critical 1: a moved follow-up's old job fires nothing; its reminder waits for the new time", async () => {
    const t = await followUp({ due: new Date(Date.now() - 10_000) }); // the old job is due now
    const later = new Date(Date.now() + 60 * MIN);
    const again = await schedule(
      db(),
      { id: t.id, dueAt: later, remindMinutes: [0], status: "open" },
      new Date(),
    );
    expect(await fire(deps(), t.ids[0]!)).toBe("skipped"); // the stale job runs
    expect(await notes(t.id)).toHaveLength(0);
    expect((await row(again[0]!)).status).toBe("pending"); // still armed for 11:00
  });

  it("Critical 1: editing only its words doesn't re-arm a reminder that already fired", async () => {
    const due = new Date(Date.now() - 5_000);
    const t = await followUp({ due });
    await fire(deps(), t.ids[0]!);
    await schedule(db(), { id: t.id, dueAt: due, remindMinutes: [0], status: "open" }, new Date());
    expect((await row(t.ids[0]!)).status).toBe("fired");
  });

  it("Minor 1 (re-graded): a fire never waits on its own pool for the assignee's permissions", async () => {
    const { default: pgm } = await import("pg");
    const one = new pgm.Pool({ connectionString: h.url("lume_app"), max: 1 });
    const t = await followUp({ due: new Date(Date.now() - 5_000) });
    const r = await Promise.race([
      fire({ app: h.app, pool: one }, t.ids[0]!),
      new Promise((res) => setTimeout(() => res("stuck"), 5000)),
    ]);
    await one.end();
    expect(r).toBe("fired");
  });
});
