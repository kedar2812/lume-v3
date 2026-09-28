import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { escalate } from "./escalation";

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
