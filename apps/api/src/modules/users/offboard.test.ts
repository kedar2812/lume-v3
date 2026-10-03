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

describe("the 6C review's fix pass", () => {
  it("a copy the new owner holds unlinked still counts as theirs: one kept, never a 500", async () => {
    const { rory, leads, team } = await setUp(1);
    const conn = newId();
    await asUser(
      rory.id,
      "INSERT INTO calendar_connections (id, user_id, google_email, grant_enc) VALUES ($1, $2, 'r@calendar.test', 'x'::bytea)",
      [conn, rory.id],
    );
    const [mine, theirs] = [newId(), newId()];
    await asUser(
      rory.id,
      `INSERT INTO meetings (id, lead_id, owner_id, connection_id, source, external_id, matched_by, title, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, 'google', 'ev-demo', 'attendee', 'Demo call', now() + interval '1 day', now() + interval '1 day 30 minutes')`,
      [mine, leads[0], rory.id, conn],
    );
    // Sam's own copy of the same event, kept by a title word: unlinked, so only Sam can see it.
    await asUser(
      team[0]!.id,
      `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at)
       VALUES ($1, NULL, $2, 'google', 'ev-demo', 'title', 'Demo call', now() + interval '1 day', now() + interval '1 day 30 minutes')`,
      [theirs, team[0]!.id],
    );
    const r = await offboard(rory.id, { to: "person", userId: team[0]!.id });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().calendar).toEqual({ meetingsMoved: 0, meetingsRemoved: 1 });
    const left = await asUser<{ id: string }>(team[0]!.id, "SELECT id FROM meetings WHERE id = ANY($1)", [
      [mine, theirs],
    ]);
    expect(left.map((x) => x.id)).toEqual([theirs]);
  });

  it("shares open leads by open load first, so the person with the fewest open leads isn't buried (C1)", async () => {
    const won = (await h.ownerPool.query("SELECT name FROM stages WHERE kind = 'won' LIMIT 1")).rows[0].name;
    const rory = await h.seedUser({ grants: sales, name: `Rory ${newId().slice(-4)}` });
    const closed: string[] = [];
    const open: string[] = [];
    // Older closed leads first, then open ones: handed out oldest first.
    for (let i = 0; i < 4; i++)
      closed.push(await h.seedLead({ ownerId: rory.id, name: `Won ${i}`, stage: won }));
    for (let i = 0; i < 4; i++) open.push(await h.seedLead({ ownerId: rory.id, name: `Open ${i}` }));
    const sam = await h.seedUser({ grants: sales, name: "Sam Okafor" });
    for (let i = 0; i < 4; i++) await h.seedLead({ ownerId: sam.id, name: `Sam ${i}` });
    const priya = await h.seedUser({ grants: sales, name: "Priya Lal" });
    const teamId = await h.seedTeam(sam.id, [rory.id, priya.id]);
    const r = await offboard(rory.id, { to: "team", teamId });
    expect(r.statusCode, r.body).toBe(200);
    // Priya had no open leads and Sam four: all four open leads go to Priya; the closed ones split evenly.
    expect((await ownersOf(open)).every((l) => l.owner_id === priya.id)).toBe(true);
    const closedOwners = (await ownersOf(closed)).map((l) => l.owner_id);
    expect(closedOwners.filter((o) => o === sam.id)).toHaveLength(2);
    expect(closedOwners.filter((o) => o === priya.id)).toHaveLength(2);
  });

  it("counts only live sessions: an idle one isn't 'signed in', in the preview or the result", async () => {
    const { rory } = await setUp(0);
    await h.signIn(rory); // a second session, then left idle past the policy
    await h.ownerPool.query(
      `UPDATE sessions SET last_seen_at = last_seen_at - interval '13 hours'
        WHERE id = (SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)`,
      [rory.id],
    );
    expect((await preview(rory.id)).json().sessions).toBe(1);
    const r = await offboard(rory.id, { to: "none" });
    expect(r.json().sessions).toBe(1);
    expect(
      (
        await h.pool.query(
          "SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
          [rory.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("their open follow-ups go with their leads, and a removed meeting's reminders are cancelled", async () => {
    const { rory, leads, team } = await setUp(2);
    const conn = newId();
    await asUser(
      rory.id,
      "INSERT INTO calendar_connections (id, user_id, google_email, grant_enc) VALUES ($1, $2, 'r2@calendar.test', 'x'::bytea)",
      [conn, rory.id],
    );
    const [mine, dup] = [newId(), newId()];
    await asUser(
      rory.id,
      `INSERT INTO meetings (id, lead_id, owner_id, connection_id, source, external_id, matched_by, title, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, 'google', 'ev-x', 'attendee', 'Call', now() + interval '1 day', now() + interval '1 day 30 minutes')`,
      [mine, leads[1], rory.id, conn],
    );
    await asUser(
      team[0]!.id,
      `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, matched_by, title, starts_at, ends_at)
       VALUES ($1, $2, $3, 'google', 'ev-x', 'attendee', 'Call', now() + interval '1 day', now() + interval '1 day 30 minutes')`,
      [dup, leads[1], team[0]!.id],
    );
    const [follow, remind] = [newId(), newId()];
    await h.queryAll(
      `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id, meeting_id) VALUES
         ($1, $3, $5, 'Call back', now() + interval '2 days', $1, NULL),
         ($2, $4, $5, 'Before the call', now() + interval '20 hours', $2, $6)`,
      [follow, remind, leads[0], leads[1], rory.id, mine],
    );
    const r = await offboard(rory.id, { to: "person", userId: team[0]!.id });
    expect(r.statusCode, r.body).toBe(200);
    const tasks = await h.queryAll<{ id: string; assignee_id: string; status: string }>(
      "SELECT id, assignee_id, status FROM tasks WHERE id = ANY($1)",
      [[follow, remind]],
    );
    expect(tasks.find((t) => t.id === follow)).toMatchObject({ assignee_id: team[0]!.id, status: "open" });
    expect(tasks.find((t) => t.id === remind)!.status).toBe("cancelled");
  });

  it("the preview refuses the owner and yourself, as the act does", async () => {
    expect((await preview(owner.id)).json().error.code).toBe("OWNER_PROTECTED");
    expect((await preview(adminUser.id)).json().error.code).toBe("SELF");
  });
});
