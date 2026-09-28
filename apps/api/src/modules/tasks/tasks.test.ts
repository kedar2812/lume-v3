import { ALL_GRANTS, DEFAULT_DUE_PRESETS, type Grant } from "@lume/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;
let repId: string;
let otherId: string;
let lead: string; // the rep's own lead
let othersLead: string; // someone else's
const MIN = 60_000;
const repGrants: Grant[] = (["leads.view", "leads.create", "leads.edit"] as const).map((key) => ({
  key,
  scope: "own" as const,
}));

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  const r = await h.seedUser({ grants: repGrants, totp: true });
  repId = r.id;
  rep = await h.signIn(r);
  otherId = (await h.seedUser({ grants: repGrants, totp: true })).id;
  lead = await h.seedLead({ ownerId: repId, name: "Aisha Khan" });
  othersLead = await h.seedLead({ ownerId: otherId, name: "Not Yours" });
});
afterAll(() => h.close());

const call = (c: AuthedClient, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  c.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
const inAnHour = () => new Date(Date.now() + 60 * MIN).toISOString();
const create = (c: AuthedClient, leadId: string, body: Record<string, unknown> = {}) =>
  call(c, "POST", `/api/v1/leads/${leadId}/tasks`, { due: { at: inAnHour() }, ...body });
const nextDue = async (leadId: string) =>
  (
    await h.queryAll<{ next_task_due_at: Date | null }>("SELECT next_task_due_at FROM leads WHERE id = $1", [
      leadId,
    ])
  )[0]!.next_task_due_at;
const pending = (taskId: string) =>
  h.queryAll<{ offset_minutes: number }>(
    "SELECT offset_minutes FROM scheduled_notifications WHERE task_id = $1 AND status = 'pending' ORDER BY offset_minutes",
    [taskId],
  );
const history = async (leadId: string) =>
  (
    await h.queryAll<{ type: string }>(
      "SELECT type FROM activities WHERE lead_id = $1 ORDER BY occurred_at",
      [leadId],
    )
  ).map((a) => a.type);

describe("setting a follow-up (Phase 3 spec §7)", () => {
  it("for yourself on your lead: its reminders are scheduled, the lead's next date is set, and its history says so", async () => {
    const r = await create(rep, lead, { title: "Call back", remindMinutes: [0, 15] });
    expect(r.statusCode).toBe(201);
    const t = r.json();
    expect(t).toMatchObject({
      leadId: lead,
      leadName: "Aisha Khan",
      title: "Call back",
      status: "open",
      canEdit: true,
    });
    expect(t.assignee).toMatchObject({ id: repId });
    expect(await pending(t.id)).toEqual([{ offset_minutes: 0 }, { offset_minutes: 15 }]);
    const ids = await h.queryAll<{ id: string }>(
      "SELECT id FROM scheduled_notifications WHERE task_id = $1 AND status = 'pending'",
      [t.id],
    );
    expect(h.reminderQueue.map((q) => q.id)).toEqual(expect.arrayContaining(ids.map((i) => Number(i.id))));
    expect((await nextDue(lead))?.toISOString()).toBe(t.dueAt);
    expect(await history(lead)).toContain("follow_up_set");
  });

  it("a preset is read in the caller's own timezone", async () => {
    await h.queryAll("UPDATE users SET timezone = 'Asia/Kolkata' WHERE id = $1", [repId]);
    const t = (await create(rep, lead, { due: { preset: "tomorrow_10" } })).json();
    expect(new Date(t.dueAt).toISOString()).toMatch(/T04:30:00\.000Z$/); // 10:00 in Kolkata
    await h.queryAll("UPDATE users SET timezone = NULL WHERE id = $1", [repId]);
  });

  it("a lead you can't see is not found; giving one to someone else needs tasks.manage_others", async () => {
    expect((await create(rep, othersLead)).statusCode).toBe(404);
    const r = await create(rep, lead, { assigneeId: otherId });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("CANNOT_ASSIGN_TASK");
  });

  it("Review Focus 4: nobody gets a follow-up on a lead they can't see", async () => {
    const r = await create(admin, lead, { assigneeId: otherId }); // the other rep sees only their own leads
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("ASSIGNEE_CANT_SEE_LEAD");
    const ok = await create(admin, othersLead, { assigneeId: otherId });
    expect(ok.statusCode).toBe(201);
    const audited = await h.queryAll(
      "SELECT 1 FROM audit_log WHERE action = 'task.changed_for_other' AND entity_id = $1",
      [ok.json().id],
    );
    expect(audited).toHaveLength(1);
  });

  it("tasks.manage_others at team scope reaches the members of your teams, and no one else", async () => {
    const leadUser = await h.seedUser({
      grants: [...repGrants, { key: "tasks.manage_others", scope: "team" }],
      totp: true,
    });
    const member = await h.seedUser({ grants: repGrants, totp: true });
    await h.seedTeam(leadUser.id, [member.id]);
    await h.grant(leadUser.id, [{ key: "leads.view", scope: "team" }]);
    const teamLead = await h.signIn(leadUser);
    const theirs = await h.seedLead({ ownerId: member.id, name: "Team Lead Case" });
    expect((await create(teamLead, theirs, { assigneeId: member.id })).statusCode).toBe(201);
    expect((await create(teamLead, theirs, { assigneeId: otherId })).statusCode).toBe(403);
  });
});

describe("time choices an admin set (3C Task 2)", () => {
  it("a custom one sets the right time; a removed one is refused in words; 3A's ids work while listed", async () => {
    await admin.inject({
      method: "PUT",
      url: "/api/v1/settings/follow-ups",
      payload: {
        duePresets: [
          { id: "in_30m", label: "In 30 minutes", rule: { in: { n: 30, unit: "minute" } } },
          { id: "in_1h", label: "In 1 hour", rule: { in: { n: 1, unit: "hour" } } },
        ],
      },
    });
    const before = Date.now();
    const t = (await create(rep, lead, { due: { preset: "in_30m" } })).json();
    expect(new Date(t.dueAt).getTime() - before).toBeGreaterThanOrEqual(30 * MIN - 5_000);
    expect(new Date(t.dueAt).getTime() - before).toBeLessThan(30 * MIN + 60_000);
    expect((await create(rep, lead, { due: { preset: "in_1h" } })).statusCode).toBe(201);
    const gone = await create(rep, lead, { due: { preset: "tomorrow_10" } });
    expect(gone.statusCode).toBe(400);
    expect(gone.json().error).toMatchObject({ code: "UNKNOWN_PRESET", message: "That time choice was just changed. Pick another." });
    await admin.inject({ method: "PUT", url: "/api/v1/settings/follow-ups", payload: { duePresets: DEFAULT_DUE_PRESETS } });
  });
});

describe("changing a follow-up", () => {
  it("moving it reschedules its reminders and the lead's next date follows", async () => {
    const t = (await create(rep, lead, { remindMinutes: [0] })).json();
    const later = new Date(Date.now() + 5 * 60 * MIN).toISOString();
    const r = await call(rep, "PATCH", `/api/v1/tasks/${t.id}`, { due: { at: later } });
    expect(r.json().dueAt).toBe(later);
    const [p] = await h.queryAll<{ fire_at: Date }>(
      "SELECT fire_at FROM scheduled_notifications WHERE task_id = $1 AND status = 'pending'",
      [t.id],
    );
    expect(p!.fire_at.toISOString()).toBe(later);
  });

  it("snooze moves it, by preset or to a time", async () => {
    const t = (await create(rep, lead)).json();
    const until = new Date(Date.now() + 3 * 60 * MIN).toISOString();
    expect((await call(rep, "POST", `/api/v1/tasks/${t.id}/snooze`, { until })).json().dueAt).toBe(until);
    const r = await call(rep, "POST", `/api/v1/tasks/${t.id}/snooze`, { preset: "1h" });
    expect(new Date(r.json().dueAt).getTime()).toBeGreaterThan(Date.now() + 50 * MIN);
  });

  it("cancel stops its reminders and the lead's next date moves on", async () => {
    const lone = await h.seedLead({ ownerId: repId, name: "Cancel Case" });
    const t = (await create(rep, lone)).json();
    expect((await call(rep, "POST", `/api/v1/tasks/${t.id}/cancel`)).json().status).toBe("cancelled");
    expect(await pending(t.id)).toEqual([]);
    expect(await nextDue(lone)).toBeNull();
    expect(await history(lone)).toContain("follow_up_cancelled");
  });
});

describe("done", () => {
  it("stops its reminders, moves the lead's next date on, and says when the day is clear", async () => {
    const own = await h.seedLead({ ownerId: repId, name: "Done Case" });
    const soon = (
      await create(rep, own, { due: { at: new Date(Date.now() + 10 * MIN).toISOString() } })
    ).json();
    const later = (
      await create(rep, own, { due: { at: new Date(Date.now() + 26 * 60 * MIN).toISOString() } })
    ).json();
    const d = await call(rep, "POST", `/api/v1/tasks/${soon.id}/done`);
    expect(d.json()).toMatchObject({ task: { status: "done" }, next: null });
    expect(await pending(soon.id)).toEqual([]);
    expect((await nextDue(own))?.toISOString()).toBe(later.dueAt);
    expect(await history(own)).toContain("follow_up_done");
    // Anything else of the rep's due today still open?
    const open = await h.queryAll(
      "SELECT 1 FROM tasks WHERE assignee_id = $1 AND status = 'open' AND due_at < now() + interval '12 hours'",
      [repId],
    );
    expect(d.json().clearedToday).toBe(open.length === 0);
  });

  it("done twice at once: one wins, the other is told it's no longer open", async () => {
    const t = (await create(rep, lead)).json();
    const [a, b] = await Promise.all([
      call(rep, "POST", `/api/v1/tasks/${t.id}/done`),
      call(rep, "POST", `/api/v1/tasks/${t.id}/done`),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect([a, b].find((x) => x.statusCode === 409)!.json().error.code).toBe("NOT_OPEN");
  });

  it("a repeating one makes the next, in the same series, due in the future", async () => {
    const t = (
      await create(rep, lead, {
        due: { at: new Date(Date.now() - 2 * 24 * 60 * MIN).toISOString() },
        recurrence: { every: 1, unit: "week", until: null, stopOn: ["won", "lost"] },
      })
    ).json();
    const { next } = (await call(rep, "POST", `/api/v1/tasks/${t.id}/done`)).json();
    expect(next).toMatchObject({ status: "open", title: t.title, recurrence: t.recurrence });
    expect(new Date(next.dueAt).getTime()).toBeGreaterThan(Date.now());
    const series = await h.queryAll<{ series_id: string }>(
      "SELECT series_id FROM tasks WHERE id IN ($1, $2)",
      [t.id, next.id],
    );
    expect(new Set(series.map((s) => s.series_id)).size).toBe(1);
  });

  it("a repeat stops once the lead is won, once its last day has passed, and once they've replied", async () => {
    const weekly = { every: 1, unit: "week", until: null, stopOn: ["won", "lost", "reply_logged"] };
    const won = await h.seedLead({ ownerId: repId, name: "Won Case" });
    const a = (await create(rep, won, { recurrence: weekly })).json();
    await h.queryAll(
      "UPDATE leads SET stage_id = (SELECT id FROM stages WHERE kind = 'won' LIMIT 1) WHERE id = $1",
      [won],
    );
    expect((await call(rep, "POST", `/api/v1/tasks/${a.id}/done`)).json().next).toBeNull();

    const b = (
      await create(rep, lead, { recurrence: { ...weekly, until: new Date().toISOString().slice(0, 10) } })
    ).json();
    expect((await call(rep, "POST", `/api/v1/tasks/${b.id}/done`)).json().next).toBeNull();

    const replied = await h.seedLead({ ownerId: repId, name: "Replied Case" });
    const c = (await create(rep, replied, { recurrence: weekly })).json();
    await h.queryAll(
      "INSERT INTO activities (id, lead_id, type) VALUES (gen_random_uuid(), $1, 'reply_logged')",
      [replied],
    );
    expect((await call(rep, "POST", `/api/v1/tasks/${c.id}/done`)).json().next).toBeNull();
  });
});

describe("a lead's follow-ups", () => {
  it("lists open ones first, soonest first, then recent done ones", async () => {
    const own = await h.seedLead({ ownerId: repId, name: "List Case" });
    const late = (
      await create(rep, own, { due: { at: new Date(Date.now() + 90 * MIN).toISOString() } })
    ).json();
    const early = (
      await create(rep, own, { due: { at: new Date(Date.now() + 30 * MIN).toISOString() } })
    ).json();
    const gone = (await create(rep, own)).json();
    await call(rep, "POST", `/api/v1/tasks/${gone.id}/done`);
    const list = (await call(rep, "GET", `/api/v1/leads/${own}/tasks`)).json().items;
    expect(list.map((t: { id: string }) => t.id)).toEqual([early.id, late.id, gone.id]);
  });

  it("removing the lead cancels its open follow-ups and their reminders", async () => {
    const own = await h.seedLead({ ownerId: repId, name: "Removed Case" });
    const t = (await create(admin, own, { assigneeId: repId })).json();
    expect((await admin.inject({ method: "DELETE", url: `/api/v1/leads/${own}` })).statusCode).toBe(204);
    const [row] = await h.queryAll<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [t.id]);
    expect(row!.status).toBe("cancelled");
    expect(await pending(t.id)).toEqual([]);
  });

  it("someone else's follow-up can't be changed without tasks.manage_others", async () => {
    const t = (await create(admin, lead, { assigneeId: repId })).json();
    const mine = (await create(rep, lead)).json();
    const other = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }], totp: true });
    const viewer = await h.signIn(other);
    const r = await call(viewer, "POST", `/api/v1/tasks/${mine.id}/done`);
    expect(r.statusCode).toBe(403);
    expect((await call(rep, "POST", `/api/v1/tasks/${t.id}/done`)).statusCode).toBe(200); // their own, set by admin
  });
});

describe("3A final review", () => {
  it("Minor 3 (re-graded): a queue that refuses a reminder never crashes LUME; the sweeper still has it", async () => {
    const crashes: unknown[] = [];
    const catcher = (e: unknown) => void crashes.push(e);
    process.on("unhandledRejection", catcher);
    h.failReminderQueue(true);
    const r = await create(rep, lead);
    await new Promise((res) => setTimeout(res, 50));
    h.failReminderQueue(false);
    process.off("unhandledRejection", catcher);
    expect(r.statusCode).toBe(201);
    expect(crashes).toEqual([]);
    expect(await pending(r.json().id)).toEqual([{ offset_minutes: 0 }]); // the sweeper will fire it on time
  });
});

describe("Remind them (3B Task 5)", () => {
  it("a manager nudges the assignee about their follow-up; the assignee can't nudge themselves", async () => {
    const t = (await create(admin, lead, { assigneeId: repId, title: "Call back" })).json();
    const r = await call(admin, "POST", `/api/v1/tasks/${t.id}/nudge`);
    expect(r.statusCode).toBe(202);
    await new Promise((res) => setTimeout(res, 100));
    const c = await h.ownerPool.connect();
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [repId]);
    const { rows } = await c.query<{ title: string }>(
      "SELECT title FROM notifications WHERE kind = 'follow_up_nudge'",
    );
    await c.query("COMMIT");
    c.release();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toMatch(/asks about your follow-up with Aisha Khan/);
    expect((await call(rep, "POST", `/api/v1/tasks/${t.id}/nudge`)).statusCode).toBe(400);
  });
});

describe("3B final review", () => {
  /** Runs `sql` as `userId` (notifications are only ever their own: row-level security). */
  const asUser = async <T extends pg.QueryResultRow>(userId: string, sql: string, params: unknown[]) => {
    const c = await h.ownerPool.connect();
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [userId]);
    const { rows } = await c.query<T>(sql, params);
    await c.query("COMMIT");
    c.release();
    return rows;
  };
  const unreadFor = async (userId: string, taskId: string, kind = "%") =>
    (
      await asUser<{ n: number }>(
        userId,
        "SELECT count(*)::int AS n FROM notifications WHERE task_id = $1 AND kind LIKE $2 AND read_at IS NULL",
        [taskId, kind],
      )
    )[0]!.n;
  const remindedOf = (taskId: string) =>
    asUser(
      repId,
      "INSERT INTO notifications (user_id, kind, task_id, lead_id, title) VALUES ($1, 'follow_up_due', $2, $3, 'Follow up with Aisha Khan — now')",
      [repId, taskId, lead],
    );

  it("Important 2: a follow-up's reminders stop counting as unread once it's done, cancelled or moved — by anyone", async () => {
    const acts: [AuthedClient, string, Record<string, unknown> | undefined][] = [
      [rep, "done", undefined],
      [rep, "cancel", undefined],
      [rep, "snooze", { preset: "1h" }],
      [admin, "done", undefined], // a manager finishing the rep's
    ];
    for (const [who, act, body] of acts) {
      const t = (await create(rep, lead)).json();
      await remindedOf(t.id);
      expect(await unreadFor(repId, t.id)).toBe(1);
      expect((await call(who, "POST", `/api/v1/tasks/${t.id}/${act}`, body)).statusCode).toBeLessThan(300);
      await new Promise((res) => setTimeout(res, 100));
      expect(await unreadFor(repId, t.id)).toBe(0);
    }
  });

  it("Remind them always reaches the assignee, even with their due reminders switched off", async () => {
    await h.queryAll(
      `UPDATE users SET preferences = jsonb_set(coalesce(preferences, '{}'::jsonb), '{alerts}', '{"dueFollowUps":false,"assigned":true,"emailDigest":true}') WHERE id = $1`,
      [repId],
    );
    const t = (await create(admin, lead, { assigneeId: repId, title: "Call back" })).json();
    expect((await call(admin, "POST", `/api/v1/tasks/${t.id}/nudge`)).statusCode).toBe(202);
    await new Promise((res) => setTimeout(res, 100));
    expect(await unreadFor(repId, t.id, "follow_up_nudge")).toBe(1);
    await h.queryAll("UPDATE users SET preferences = preferences - 'alerts' WHERE id = $1", [repId]);
  });

  it("handing a follow-up to someone else lets its new managers hear if it's left overdue", async () => {
    const t = (await create(admin, lead, { assigneeId: repId })).json();
    await h.queryAll("UPDATE tasks SET escalated_at = now() WHERE id = $1", [t.id]);
    const newcomer = (await h.seedUser({ grants: ALL_GRANTS, totp: true })).id;
    const r = await call(admin, "PATCH", `/api/v1/tasks/${t.id}`, { assigneeId: newcomer });
    expect(r.statusCode).toBe(200);
    const [row] = await h.queryAll<{ escalated_at: Date | null }>(
      "SELECT escalated_at FROM tasks WHERE id = $1",
      [t.id],
    );
    expect(row!.escalated_at).toBeNull();
  });
});
