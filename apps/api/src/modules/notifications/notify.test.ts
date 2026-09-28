import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { schema } from "@lume/db";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { fire, schedule } from "../tasks/engine";

let h: Harness;
let admin: AuthedClient;
const repGrants: Grant[] = (["leads.view", "leads.edit"] as const).map((key) => ({
  key,
  scope: "own" as const,
}));

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(() => h.close());

/** A person's own notifications (FORCE row-level security: read as them). */
async function inbox(userId: string) {
  const c: pg.PoolClient = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [userId]);
    const { rows } = await c.query<{ kind: string; title: string; body: string | null }>(
      "SELECT kind, title, body FROM notifications ORDER BY id",
    );
    await c.query("COMMIT");
    return rows;
  } finally {
    c.release();
  }
}
async function rep(alerts: Record<string, boolean> = {}) {
  const u = await h.seedUser({ grants: repGrants, totp: true });
  if (Object.keys(alerts).length)
    await h.ownerPool.query(
      "UPDATE users SET preferences = jsonb_build_object('alerts', $2::jsonb) WHERE id = $1",
      [u.id, JSON.stringify({ assigned: true, dueFollowUps: true, emailDigest: true, ...alerts })],
    );
  return u;
}
const settle = () => new Promise((r) => setTimeout(r, 100)); // after-commit notices

describe("notifications that respect people (3B Task 2)", () => {
  it("a due reminder with 'due follow-ups' off writes nothing, and still counts as fired", async () => {
    const u = await rep({ dueFollowUps: false });
    const lead = await h.seedLead({ ownerId: u.id, name: "Quiet Lead" });
    const id = newId();
    const due = new Date(Date.now() - 60_000);
    await h.queryAll(
      "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Follow up', $4, $1)",
      [id, lead, u.id, due],
    );
    const [sn] = await schedule(
      drizzle(h.pool, { schema }),
      { id, dueAt: due, remindMinutes: [0], status: "open" },
      new Date(due.getTime() - 60_000),
    );
    expect(await fire({ app: h.app, pool: h.pool }, sn!)).toBe("skipped");
    expect(await inbox(u.id)).toEqual([]);
    const [row] = await h.queryAll<{ status: string }>(
      "SELECT status FROM scheduled_notifications WHERE id = $1",
      [sn],
    );
    expect(row!.status).toBe("fired");
  });

  it("a follow-up someone else gives you tells you; your own doesn't; 'assigned' off keeps it quiet", async () => {
    const u = await rep();
    const lead = await h.seedLead({ ownerId: u.id, name: "Given Lead", phone: "+971501112233" });
    await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/tasks`,
      payload: { assigneeId: u.id, title: "Call back" },
    });
    await settle();
    const got = await inbox(u.id);
    expect(got).toMatchObject([{ kind: "follow_up_assigned" }]);
    expect(got[0]!.title).toContain("Given Lead");
    expect(`${got[0]!.title} ${got[0]!.body}`).not.toMatch(/1112233/);

    const client = await h.signIn(u);
    await client.inject({ method: "POST", url: `/api/v1/leads/${lead}/tasks`, payload: {} });
    await settle();
    expect(await inbox(u.id)).toHaveLength(1); // nothing for your own

    const quiet = await rep({ assigned: false });
    const theirs = await h.seedLead({ ownerId: quiet.id, name: "Quiet Given" });
    await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${theirs}/tasks`,
      payload: { assigneeId: quiet.id },
    });
    await settle();
    expect(await inbox(quiet.id)).toEqual([]);
  });

  it("a lead assigned to you tells you, by name; fifty at once is one notice", async () => {
    const u = await rep();
    const one = await h.seedLead({ ownerId: null, name: "Single Hand-off" });
    await admin.inject({ method: "POST", url: `/api/v1/leads/${one}/assign`, payload: { ownerId: u.id } });
    await settle();
    expect(await inbox(u.id)).toMatchObject([
      { kind: "lead_assigned", title: expect.stringContaining("Single Hand-off") },
    ]);

    const many: string[] = [];
    for (let i = 0; i < 50; i++) many.push(await h.seedLead({ ownerId: null, name: `Bulk ${i}` }));
    await admin.inject({
      method: "POST",
      url: "/api/v1/leads/bulk",
      payload: { ids: many, action: { type: "assign", ownerId: u.id } },
    });
    await settle();
    const all = await inbox(u.id);
    expect(all).toHaveLength(2);
    expect(all[1]!.title).toMatch(/^50 leads were assigned to you/);
  });
});
