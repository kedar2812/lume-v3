import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { setOffboardFailureForTests } from "./offboard";

/** Phase 6C Task 1: offboarding someone — sessions, leads, calendar, their last 30 days — as one act. */
let h: Harness;
let admin: AuthedClient;
let adminUser: SeededUser;
let owner: SeededUser;
const sales: Grant[] = [
  { key: "leads.view", scope: "own" },
  { key: "leads.contact.reveal", scope: "own" },
];

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  owner = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Hana Ito" });
  admin = await h.signIn(adminUser);
});
afterAll(() => h.close());

/** A rep with `n` leads (open), a session, and a team of colleagues holding a few open leads each. */
async function setUp(
  n: number,
  colleagues: [string, number][] = [
    ["Sam Okafor", 2],
    ["Priya Lal", 1],
  ],
) {
  const rory = await h.seedUser({ grants: sales, name: `Rory ${newId().slice(-4)}` });
  await h.signIn(rory);
  const leads: string[] = [];
  for (let i = 0; i < n; i++) leads.push(await h.seedLead({ ownerId: rory.id, name: `Lead ${i}` }));
  const team: SeededUser[] = [];
  for (const [name, open] of colleagues) {
    const u = await h.seedUser({ grants: sales, name });
    for (let i = 0; i < open; i++) await h.seedLead({ ownerId: u.id, name: `${name} ${i}` });
    team.push(u);
  }
  const teamId = await h.seedTeam(team[0]!.id, [rory.id, ...team.slice(1).map((u) => u.id)]);
  return { rory, leads, team, teamId };
}
/** Calendar rows are their person's own under row-level security: written and read as that person. */
async function asUser<R>(userId: string, text: string, params: unknown[] = []): Promise<R[]> {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      userId,
    ]);
    const r = await c.query(text, params);
    await c.query("COMMIT");
    return r.rows as R[];
  } finally {
    c.release();
  }
}
const preview = (id: string) => admin.inject({ method: "GET", url: `/api/v1/users/${id}/offboarding` });
const offboard = (id: string, leads: Record<string, unknown>) =>
  admin.inject({ method: "POST", url: `/api/v1/users/${id}/offboard`, payload: { leads } });
const ownersOf = (ids: string[]) =>
  h.queryAll<{ owner_id: string | null }>("SELECT owner_id FROM leads WHERE id = ANY($1)", [ids]);

describe("the offboarding preview (6C)", () => {
  it("says what there is to hand on, who could take it, and their last 30 days", async () => {
    const { rory, team, teamId } = await setUp(3);
    await h.ownerPool.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, at)
       SELECT $1, 'lead.contact.reveal', 'lead', gen_random_uuid(), now() - interval '2 hours' FROM generate_series(1, 5)`,
      [rory.id],
    );
    const r = await preview(rory.id);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p.person).toMatchObject({ id: rory.id, status: "active" });
    expect(p.sessions).toBe(1);
    expect(p.leads).toEqual({ total: 3, open: 3 });
    expect(p.calendar).toBeNull();
    const t = p.teams.find((x: { id: string }) => x.id === teamId);
    expect(t.members.map((m: { name: string }) => m.name).sort()).toEqual(["Priya Lal", "Sam Okafor"]);
    expect(t.members.find((m: { id: string }) => m.id === team[0]!.id).openLeads).toBe(2);
    expect(p.last30).toMatchObject({ reveals: 5, leadsOpened: 0, exports: 0, alerts: 0 });
    expect(p.last30.busiest).toMatchObject({ count: 5 });
  });
});

describe("offboarding someone (6C)", () => {
  it("to one person: disabled, signed out, every lead handed on, one audit entry", async () => {
    const { rory, leads, team } = await setUp(3);
    const r = await offboard(rory.id, { to: "person", userId: team[1]!.id });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ sessions: 1, leads: { to: "person", moved: 3 }, calendar: null });
    expect((await h.pool.query("SELECT status FROM users WHERE id = $1", [rory.id])).rows[0].status).toBe(
      "disabled",
    );
    expect(
      (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
          [rory.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await ownersOf(leads)).every((l) => l.owner_id === team[1]!.id)).toBe(true);
    const a = (
      await h.pool.query(
        "SELECT actor_user_id, diff FROM audit_log WHERE action = 'user.offboarded' AND entity_id = $1",
        [rory.id],
      )
    ).rows;
    expect(a).toHaveLength(1);
    expect(a[0].actor_user_id).toBe(adminUser.id);
    expect(a[0].diff).toMatchObject({ sessions: 1, leads: { to: "person", moved: 3 } });
  });

  it("shared across a team: whoever has the fewest open leads gets the next, never the person (Review Focus 2)", async () => {
    const { rory, leads, team, teamId } = await setUp(5, [
      ["Sam Okafor", 2],
      ["Priya Lal", 0],
      ["Dev Rao", 0],
    ]);
    // A colleague who's been paused gets nothing.
    await h.ownerPool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [team[2]!.id]);
    const r = await offboard(rory.id, { to: "team", teamId });
    expect(r.statusCode, r.body).toBe(200);
    const shares = r.json().leads.shares as { id: string; name: string; count: number }[];
    expect(shares.reduce((n, s) => n + s.count, 0)).toBe(5);
    expect(shares.find((s) => s.id === team[2]!.id)).toBeUndefined();
    const owners = (await ownersOf(leads)).map((l) => l.owner_id);
    expect(owners).not.toContain(rory.id);
    expect(owners).not.toContain(team[2]!.id);
    // Sam started with 2, Priya with 0: Priya takes the first three or four, they even out.
    const sam = owners.filter((o) => o === team[0]!.id).length;
    const priya = owners.filter((o) => o === team[1]!.id).length;
    expect(Math.abs(sam + 2 - priya)).toBeLessThanOrEqual(1);
  });

  it("left unassigned for an admin to hand out", async () => {
    const { rory, leads } = await setUp(2);
    const r = await offboard(rory.id, { to: "none" });
    expect(r.json().leads).toMatchObject({ to: "none", moved: 2 });
    expect((await ownersOf(leads)).every((l) => l.owner_id === null)).toBe(true);
  });

  it("their calendar: meetings go with their leads, a duplicate isn't kept twice, the rest and the grant go (Review Focus 3)", async () => {
    const { rory, leads, team } = await setUp(2);
    const conn = newId();
    await asUser(
      rory.id,
      "INSERT INTO calendar_connections (id, user_id, google_email, grant_enc) VALUES ($1, $2, 'rory@calendar.test', '\\x00'::bytea)",
      [conn, rory.id],
    );
    const meeting = (id: string, ownerId: string, leadId: string | null, ext: string, c: string | null) =>
      asUser(
        ownerId,
        `INSERT INTO meetings (id, lead_id, owner_id, connection_id, source, external_id, matched_by, title, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, 'google', $5, 'attendee', 'Call', now() + interval '1 day', now() + interval '1 day 30 minutes')`,
        [id, leadId, ownerId, c, ext],
      );
    const [m1, m2, m3, dupOfM2] = [newId(), newId(), newId(), newId()];
    await meeting(m1, rory.id, leads[0]!, "ev-1", conn);
    await meeting(m2, rory.id, leads[1]!, "ev-2", conn);
    await meeting(m3, rory.id, null, "ev-3", conn); // unlinked: goes with the connection
    await meeting(dupOfM2, team[0]!.id, leads[1]!, "ev-2", null); // Sam already has the same event
    const pre = (await preview(rory.id)).json();
    expect(pre.calendar).toEqual({ email: "rory@calendar.test", upcoming: 3 });
    const r = await offboard(rory.id, { to: "person", userId: team[0]!.id });
    expect(r.json().calendar).toEqual({ meetingsMoved: 1, meetingsRemoved: 2 });
    // Read as Rory: an unlinked meeting of theirs that wrongly survived would show.
    const rows = await asUser<{ id: string; owner_id: string; connection_id: string | null }>(
      rory.id,
      "SELECT id, owner_id, connection_id FROM meetings WHERE id = ANY($1)",
      [[m1, m2, m3, dupOfM2]],
    );
    expect(rows.map((x) => x.id).sort()).toEqual([m1, dupOfM2].sort());
    expect(rows.find((x) => x.id === m1)).toMatchObject({ owner_id: team[0]!.id, connection_id: null });
    const left = await asUser<{ n: number }>(
      rory.id,
      "SELECT count(*)::int AS n FROM calendar_connections WHERE id = $1",
      [conn],
    );
    expect(left[0]!.n).toBe(0);
  });

  it("settles their open alerts as offboarded", async () => {
    const { rory } = await setUp(1);
    const alert = newId();
    await h.ownerPool.query(
      `INSERT INTO security_alerts (id, user_id, rule, observed, threshold, window_start, window_end, action)
       VALUES ($1, $2, 'reveals', 31, 30, now() - interval '1 hour', now(), 'alerted')`,
      [alert, rory.id],
    );
    await offboard(rory.id, { to: "none" });
    const a = (
      await h.pool.query("SELECT status, resolution, resolved_by FROM security_alerts WHERE id = $1", [alert])
    ).rows[0];
    expect(a).toEqual({ status: "resolved", resolution: "offboarded", resolved_by: adminUser.id });
  });

  it("is all or nothing: a failure part-way leaves them as they were (Review Focus 1)", async () => {
    const { rory, leads, team } = await setUp(2);
    setOffboardFailureForTests("calendar");
    try {
      const r = await offboard(rory.id, { to: "person", userId: team[0]!.id });
      expect(r.statusCode).toBe(500);
    } finally {
      setOffboardFailureForTests(null);
    }
    expect((await h.pool.query("SELECT status FROM users WHERE id = $1", [rory.id])).rows[0].status).toBe(
      "active",
    );
    expect((await ownersOf(leads)).every((l) => l.owner_id === rory.id)).toBe(true);
    expect(
      (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
          [rory.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("refuses the owner, yourself, someone already gone, and a stranger to hand to (Review Focus 4)", async () => {
    const { rory } = await setUp(1);
    expect((await offboard(owner.id, { to: "none" })).json().error.code).toBe("OWNER_PROTECTED");
    expect((await offboard(adminUser.id, { to: "none" })).json().error.code).toBe("SELF");
    expect((await offboard(rory.id, { to: "person", userId: rory.id })).json().error.code).toBe(
      "UNKNOWN_USER",
    );
    expect((await offboard(rory.id, { to: "team", teamId: newId() })).json().error.code).toBe("UNKNOWN_TEAM");
    await offboard(rory.id, { to: "none" });
    expect((await offboard(rory.id, { to: "none" })).json().error.code).toBe("NOT_ACTIVE");
  });
});
