import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

// The harness's clock: 2026-09-21T09:00Z (1 pm in Dubai, 2:30 pm in Kolkata, 10 am in London).
let h: Harness;
const repGrants: Grant[] = (["leads.view", "leads.edit"] as const).map((key) => ({
  key,
  scope: "own" as const,
}));

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
});
afterAll(() => h.close());

async function person(tz: string, grants: Grant[] = repGrants) {
  const u = await h.seedUser({ grants, totp: true });
  await h.queryAll("UPDATE users SET timezone = $2 WHERE id = $1", [u.id, tz]);
  return { u, c: await h.signIn(u) };
}

async function task(assignee: SeededUser, lead: string, dueAt: string, title: string, status = "open") {
  const id = newId();
  await h.queryAll(
    `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id, status, done_at, done_by)
     VALUES ($1, $2, $3, $4, $5, $1, $6, $7, $8)`,
    [
      id,
      lead,
      assignee.id,
      title,
      dueAt,
      status,
      status === "done" ? h.clock.now : null,
      status === "done" ? assignee.id : null,
    ],
  );
  return id;
}

async function meeting(
  owner: string,
  startsAt: string,
  o: { lead?: string | null; status?: string; title?: string } = {},
) {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      owner,
    ]);
    const id = newId();
    await c.query(
      `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, title, starts_at, ends_at, matched_by, status, link)
       VALUES ($1, $2, $3, 'google', $4, $5, $6, $6::timestamptz + interval '30 minutes', 'attendee', $7, 'https://meet.example/x')`,
      [id, o.lead ?? null, owner, `ev-${id}`, o.title ?? "Call", startsAt, o.status ?? "scheduled"],
    );
    await c.query("COMMIT");
    return id;
  } finally {
    c.release();
  }
}

const day = (c: AuthedClient, date: string) =>
  c.inject({ method: "GET", url: `/api/v1/your-day?date=${date}` });
const titles = (xs: { title: string }[]) => xs.map((x) => x.title);

describe("Your day: another day's follow-ups and calls (spec: Your day full screen, Data)", () => {
  it("a day is the person's own midnight to midnight: the same instants land on different days in Dubai and Kolkata", async () => {
    const dubai = await person("Asia/Dubai");
    const kolkata = await person("Asia/Kolkata");
    for (const p of [dubai, kolkata]) {
      const lead = await h.seedLead({ ownerId: p.u.id, name: "Dana Lead" });
      await task(p.u, lead, "2026-09-21T19:00:00Z", "At 19:00Z"); // 11 pm Dubai / 00:30 Kolkata (22nd)
      await task(p.u, lead, "2026-09-21T20:30:00Z", "At 20:30Z"); // 00:30 Dubai (22nd) / 2 am Kolkata (22nd)
    }
    const d = (await day(dubai.c, "2026-09-22")).json();
    expect(d.date).toBe("2026-09-22");
    expect(titles(d.followUps)).toEqual(["At 20:30Z"]);
    expect(titles((await day(kolkata.c, "2026-09-22")).json().followUps)).toEqual(["At 19:00Z", "At 20:30Z"]);
  });

  it("open and done follow-ups, in due order; cancelled ones left out", async () => {
    const { u, c } = await person("Asia/Dubai");
    const lead = await h.seedLead({ ownerId: u.id, name: "Ravi Lead" });
    await task(u, lead, "2026-09-23T10:00:00Z", "Later", "open");
    await task(u, lead, "2026-09-23T06:00:00Z", "Earlier", "done");
    await task(u, lead, "2026-09-23T08:00:00Z", "Gone", "cancelled");
    const d = (await day(c, "2026-09-23")).json();
    expect(d.followUps.map((t: { title: string; status: string }) => [t.title, t.status])).toEqual([
      ["Earlier", "done"],
      ["Later", "open"],
    ]);
    expect(d.followUps[0]).toMatchObject({ leadName: "Ravi Lead", assignee: { id: u.id } });
  });

  it("someone else's follow-ups and calls never show", async () => {
    const me = await person("Asia/Dubai", ALL_GRANTS);
    const other = await person("Asia/Dubai", ALL_GRANTS);
    const lead = await h.seedLead({ ownerId: me.u.id, name: "Shared Lead" });
    await task(other.u, lead, "2026-09-24T08:00:00Z", "Theirs");
    await meeting(other.u.id, "2026-09-24T09:00:00Z", { lead, title: "Their call" });
    await task(me.u, lead, "2026-09-24T07:00:00Z", "Mine");
    await meeting(me.u.id, "2026-09-24T10:00:00Z", { lead, title: "My call" });
    const d = (await day(me.c, "2026-09-24")).json();
    expect(titles(d.followUps)).toEqual(["Mine"]);
    expect(titles(d.meetings)).toEqual(["My call"]);
  });

  it("a follow-up on a lead the person can't see is left out (it runs as them, under RLS)", async () => {
    const rep = await person("Asia/Dubai");
    const boss = await person("Asia/Dubai", ALL_GRANTS);
    const notTheirs = await h.seedLead({ ownerId: boss.u.id, name: "Boss Lead" });
    const theirs = await h.seedLead({ ownerId: rep.u.id, name: "Rep Lead" });
    await task(rep.u, notTheirs, "2026-09-25T08:00:00Z", "Hidden");
    await task(rep.u, theirs, "2026-09-25T09:00:00Z", "Seen");
    expect(titles((await day(rep.c, "2026-09-25")).json().followUps)).toEqual(["Seen"]);
  });

  it("calls that were cancelled or moved are left out; calls with no lead stay", async () => {
    const { u, c } = await person("Asia/Dubai", ALL_GRANTS);
    await meeting(u.id, "2026-09-26T05:00:00Z", { title: "Kept" });
    await meeting(u.id, "2026-09-26T06:00:00Z", { title: "Cancelled", status: "cancelled" });
    await meeting(u.id, "2026-09-26T07:00:00Z", { title: "Moved", status: "rescheduled" });
    await meeting(u.id, "2026-09-26T08:00:00Z", { title: "Held", status: "completed" });
    const d = (await day(c, "2026-09-26")).json();
    expect(titles(d.meetings)).toEqual(["Kept", "Held"]);
    expect(d.meetings[0]).toMatchObject({ lead: null, link: "https://meet.example/x", status: "scheduled" });
  });

  it("London's 25-hour day: 00:30 summer time and 23:30 winter time are both on October 25", async () => {
    const { u, c } = await person("Europe/London");
    const lead = await h.seedLead({ ownerId: u.id, name: "Lon Lead" });
    await task(u, lead, "2026-10-24T22:30:00Z", "Day before"); // 11:30 pm BST on the 24th
    await task(u, lead, "2026-10-24T23:30:00Z", "First"); // 00:30 BST on the 25th
    await task(u, lead, "2026-10-25T23:30:00Z", "Last"); // 11:30 pm GMT on the 25th
    await task(u, lead, "2026-10-26T00:30:00Z", "Day after");
    expect(titles((await day(c, "2026-10-25")).json().followUps)).toEqual(["First", "Last"]);
  });

  it("bad dates are 400: not a date, not a real day, or more than a year away", async () => {
    const { c } = await person("Asia/Dubai");
    for (const date of ["20261015", "2026-02-30", "2026-13-01", "2027-09-23", "2025-09-19", ""]) {
      const r = await day(c, date);
      expect(r.statusCode, date).toBe(400);
    }
    expect((await day(c, "2027-09-22")).statusCode).toBe(200); // 366 days ahead
    expect((await day(c, "2025-09-20")).statusCode).toBe(200); // 366 days back
    expect((await c.inject({ method: "GET", url: "/api/v1/your-day" })).statusCode).toBe(400);
  });

  it("signed out: 401", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/v1/your-day?date=2026-09-22" })).statusCode).toBe(
      401,
    );
  });
});
