import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { jobServer, withJobRequest } from "../imports/job-request";
import { escalate, overdueWords } from "./escalation";
import { cancelLeadTasks } from "./lifecycle";

let h: Harness;
let assignee: string;
let assigneeUser: SeededUser;
let teamLead: string;
let admin: string;
let otherRep: string;
let blindManager: string;
const H = 3_600_000;
const repGrants: Grant[] = (["leads.view", "leads.edit"] as const).map((key) => ({
  key,
  scope: "own" as const,
}));

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  assigneeUser = await h.seedUser({ grants: repGrants, totp: true, name: "Riya Sharma" });
  assignee = assigneeUser.id;
  otherRep = (await h.seedUser({ grants: repGrants, totp: true })).id;
  teamLead = (
    await h.seedUser({
      grants: [
        { key: "leads.view", scope: "team" },
        { key: "tasks.manage_others", scope: "team" },
      ],
      totp: true,
    })
  ).id;
  await h.seedTeam(teamLead, [assignee]);
  admin = (await h.seedUser({ grants: ALL_GRANTS, totp: true })).id;
  // May manage anyone's follow-ups, but sees only their own leads: must never be told about this one.
  blindManager = (
    await h.seedUser({
      grants: [
        { key: "leads.view", scope: "own" },
        { key: "tasks.manage_others", scope: "all" },
      ],
      totp: true,
    })
  ).id;
});
afterAll(() => h.close());

async function inbox(userId: string) {
  const c: pg.PoolClient = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [userId]);
    const { rows } = await c.query<{ kind: string; title: string }>(
      "SELECT kind, title FROM notifications WHERE kind = 'task_escalated' ORDER BY id",
    );
    await c.query("COMMIT");
    return rows;
  } finally {
    c.release();
  }
}
async function overdue(hours: number, name = "Aisha Khan") {
  const lead = await h.seedLead({ ownerId: assignee, name });
  const id = newId();
  await h.queryAll(
    "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Call back', $4, $1)",
    [id, lead, assignee, new Date(Date.now() - hours * H)],
  );
  return id;
}
const run = () => escalate({ app: h.app, pool: h.pool }, new Date());
/** The team lead's unread "overdue" notices of one follow-up. */
async function unreadEscalations(taskId: string, userId = teamLead) {
  const c: pg.PoolClient = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [userId]);
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE kind = 'task_escalated' AND task_id = $1 AND read_at IS NULL",
      [taskId],
    );
    await c.query("COMMIT");
    return rows[0]!.n;
  } finally {
    c.release();
  }
}

describe("escalation (3B Task 3)", () => {
  it("Review Focus 2: an overdue follow-up reaches the assignee's team lead and the all-seeing, and no one else", async () => {
    const t = await overdue(30);
    await run();
    const lead = await inbox(teamLead);
    expect(lead).toHaveLength(1);
    expect(lead[0]!.title).toMatch(/^Riya's follow-up with Aisha Khan is 30 h overdue$/);
    expect(await inbox(admin)).toHaveLength(1);
    for (const nobody of [assignee, otherRep, blindManager]) expect(await inbox(nobody)).toEqual([]);
    const [row] = await h.queryAll<{ escalated_at: Date | null }>(
      "SELECT escalated_at FROM tasks WHERE id = $1",
      [t],
    );
    expect(row!.escalated_at).not.toBeNull();
  });

  it("once only; not before its hours are up", async () => {
    await run();
    expect(await inbox(teamLead)).toHaveLength(1);
    await overdue(3, "Not Yet");
    await run();
    expect((await inbox(teamLead)).some((n) => n.title.includes("Not Yet"))).toBe(false);
  });

  it("moving it clears the escalation; left overdue again, it escalates again", async () => {
    const t = await overdue(40, "Moved Along");
    await run();
    const client = await h.signIn(assigneeUser);
    await client.inject({
      method: "PATCH",
      url: `/api/v1/tasks/${t}`,
      payload: { due: { at: new Date(Date.now() + H).toISOString() } },
    });
    const [moved] = await h.queryAll<{ escalated_at: Date | null }>(
      "SELECT escalated_at FROM tasks WHERE id = $1",
      [t],
    );
    expect(moved!.escalated_at).toBeNull();
    await h.queryAll("UPDATE tasks SET due_at = now() - interval '26 hours' WHERE id = $1", [t]);
    await run();
    expect((await inbox(teamLead)).filter((n) => n.title.includes("Moved Along"))).toHaveLength(2);
  });

  it("switched on by an admin who sees only their own leads: what's already overdue anywhere never floods in (bug hunt 2026-11-17)", async () => {
    await h.ownerPool.query(
      `UPDATE settings SET follow_ups = '{"escalation":{"enabled":false,"hours":24}}'::jsonb WHERE id = 1`,
    );
    await overdue(72, "Long Overdue");
    const narrow = await h.seedUser({
      grants: [
        { key: "settings.manage", scope: null },
        { key: "leads.view", scope: "own" },
      ],
      totp: true,
    });
    const c = await h.signIn(narrow);
    const on = await c.inject({
      method: "PUT",
      url: "/api/v1/settings/follow-ups",
      payload: { escalation: { enabled: true, hours: 24 } },
    });
    expect(on.statusCode, on.body).toBe(200);
    await run();
    expect((await inbox(teamLead)).some((n) => n.title.includes("Long Overdue"))).toBe(false);
  });

  it("switched off in Settings, nothing escalates", async () => {
    await h.ownerPool.query(
      `UPDATE settings SET follow_ups = '{"escalation":{"enabled":false,"hours":24}}'::jsonb WHERE id = 1`,
    );
    await overdue(50, "Switched Off");
    await run();
    expect((await inbox(teamLead)).some((n) => n.title.includes("Switched Off"))).toBe(false);
    await h.ownerPool.query(
      `UPDATE settings SET follow_ups = '{"escalation":{"enabled":true,"hours":24}}'::jsonb WHERE id = 1`,
    );
  });
});

describe("how long overdue, in words a person reads at a glance", () => {
  it("hours under two days, then days", () => {
    expect(overdueWords(5)).toBe("5 h");
    expect(overdueWords(47)).toBe("47 h");
    expect(overdueWords(48)).toBe("2 days");
    expect(overdueWords(164)).toBe("6 days");
  });

  it("done by its assignee, the manager's 'overdue' notice of it is read: nothing left to chase (review 2026-11-17)", async () => {
    const t = await overdue(31, "Kabir Sen");
    await run();
    const unread = async () => {
      const c: pg.PoolClient = await h.ownerPool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('lume.user_id', $1, true)", [teamLead]);
        const { rows } = await c.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM notifications WHERE kind = 'task_escalated' AND task_id = $1 AND read_at IS NULL",
          [t],
        );
        await c.query("COMMIT");
        return rows[0]!.n;
      } finally {
        c.release();
      }
    };
    expect(await unread()).toBe(1);
    const c = await h.signIn(assigneeUser);
    expect((await c.inject({ method: "POST", url: `/api/v1/tasks/${t}/done` })).statusCode).toBeLessThan(300);
    await vi.waitFor(async () => expect(await unread()).toBe(0));
  });

  it("closed by a job outside a signed-in request (LUME AI, a stage rule), the notice is read too (review 2026-11-18)", async () => {
    const t = await overdue(31, "Job Closed");
    await run();
    expect(await unreadEscalations(t)).toBe(1);
    const [task] = await h.queryAll<{ lead_id: string }>("SELECT lead_id FROM tasks WHERE id = $1", [t]);
    const actor = (await h.actorOf(admin))!;
    await withJobRequest(
      { app: jobServer(h.app), pool: h.pool, actor, requestId: "t-job", allLeads: true },
      (req) => cancelLeadTasks(req, task!.lead_id),
    );
    expect(await unreadEscalations(t)).toBe(0);
  });

  it("the settling gate only reads and marks read: it never deletes or makes someone else's notice (review 2026-11-18)", async () => {
    const t = await overdue(31, "Gate Kept");
    await run();
    const c: pg.PoolClient = await h.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.settle_task', $2, true)", [
        otherRep,
        t,
      ]);
      expect((await c.query("DELETE FROM notifications WHERE task_id = $1", [t])).rowCount).toBe(0);
      await expect(
        c.query(
          "INSERT INTO notifications (user_id, kind, title, task_id) VALUES ($1, 'task_escalated', 'x', $2)",
          [teamLead, t],
        ),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    expect(await unreadEscalations(t)).toBe(1);
  });

  it("handed on by offboarding, the manager's notice of the one who left is read (review 2026-11-18)", async () => {
    const leaver = await h.seedUser({ grants: repGrants, totp: true, name: "Lea Ving" });
    await h.seedTeam(teamLead, [leaver.id]);
    const lead = await h.seedLead({ ownerId: leaver.id, name: "Left Behind" });
    const t = newId();
    await h.queryAll(
      "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Call back', $4, $1)",
      [t, lead, leaver.id, new Date(Date.now() - 30 * H)],
    );
    await run();
    expect(await unreadEscalations(t)).toBe(1);
    const boss = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
    const r = await boss.inject({
      method: "POST",
      url: `/api/v1/users/${leaver.id}/offboard`,
      payload: { leads: { to: "person", userId: otherRep } },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(await unreadEscalations(t)).toBe(0);
    // …and it's the new person's now: left overdue with them, their managers hear (as a reassignment does).
    const [moved] = await h.queryAll<{ assignee_id: string; escalated_at: Date | null }>(
      "SELECT assignee_id, escalated_at FROM tasks WHERE id = $1",
      [t],
    );
    expect(moved).toEqual({ assignee_id: otherRep, escalated_at: null });
  });
});
