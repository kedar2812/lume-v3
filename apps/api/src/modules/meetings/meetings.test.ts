import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { askOutcomes } from "./outcomes";

const HOUR = 3_600_000;
let h: Harness;
let rep: SeededUser;
let other: SeededUser;
let manager: SeededUser;
let repC: AuthedClient;
let managerC: AuthedClient;
let noCalendarC: AuthedClient;
let repLead: string;
let otherLead: string;
let stages: Record<string, string>;
const M = {
  repLinked: newId(),
  repUnlinked: newId(),
  otherLinked: newId(),
  otherUnlinked: newId(),
  otherOnRepLead: newId(),
  repPast: newId(),
  repFuture: newId(),
};

const own: Grant[] = [
  { key: "leads.view", scope: "own" },
  { key: "calendar.view", scope: "own" },
];

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  rep = await h.seedUser({ grants: own, name: "Riya Rep" });
  other = await h.seedUser({ grants: own, name: "Omar Other" });
  manager = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Mina Manager" });
  repC = await h.signIn(rep);
  managerC = await h.signIn(manager);
  noCalendarC = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] }));
  stages = (await h.config()).stages;
  const [first, second] = Object.keys(stages);
  repLead = await h.seedLead({ ownerId: rep.id, name: "Dana Lead", stage: first });
  otherLead = await h.seedLead({ ownerId: other.id, name: "Sam Lead", stage: second });
  const at = (hours: number) => new Date(h.clock.now.getTime() + hours * HOUR);
  await meeting(M.repLinked, rep.id, repLead, at(2), "Rep with Dana");
  await meeting(M.repUnlinked, rep.id, null, at(3), "Rep's discovery call");
  await meeting(M.otherLinked, other.id, otherLead, at(4), "Other with Sam");
  await meeting(M.otherUnlinked, other.id, null, at(5), "Other's discovery call");
  await meeting(M.otherOnRepLead, other.id, repLead, at(6), "Other with Dana");
  await meeting(M.repPast, rep.id, repLead, at(-2), "Dana, earlier");
  await meeting(M.repFuture, rep.id, repLead, at(48), "Dana, later");
});
afterAll(async () => h.close());

/** A meeting as LUME's sync writes it: as its owner, seeing every lead. */
async function meeting(id: string, owner: string, lead: string | null, startsAt: Date, title: string) {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      owner,
    ]);
    await c.query(
      `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, calendar_id, title, starts_at, ends_at, matched_by)
       VALUES ($1, $2, $3, 'google', $8, 'primary', $4, $5, $6, $7)`,
      [
        id,
        lead,
        owner,
        title,
        startsAt,
        new Date(startsAt.getTime() + HOUR / 2),
        lead ? "attendee" : "title",
        `event-${id}`,
      ],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

const range = (fromH: number, toH: number) =>
  `from=${new Date(h.clock.now.getTime() + fromH * HOUR).toISOString()}&to=${new Date(h.clock.now.getTime() + toH * HOUR).toISOString()}`;
const ids = (r: { json(): { meetings: { id: string }[] } }) =>
  r
    .json()
    .meetings.map((m) => m.id)
    .sort();
const get = (c: AuthedClient, url: string) => c.inject({ method: "GET", url });
const patch = (c: AuthedClient, id: string, payload: Record<string, unknown>) =>
  c.inject({ method: "PATCH", url: `/api/v1/meetings/${id}`, payload });

describe("meetings in the API (5A Task 6)", () => {
  it("a rep sees their own meetings with leads they may see, and their own unlinked ones — no one else's", async () => {
    const r = await get(repC, `/api/v1/meetings?${range(-24, 24)}`);
    expect(r.statusCode).toBe(200);
    expect(ids(r)).toEqual([M.repLinked, M.repUnlinked, M.repPast].sort());
    expect(r.json().meetings.find((m: { id: string }) => m.id === M.repLinked)).toMatchObject({
      title: "Rep with Dana",
      ownerId: rep.id,
      status: "scheduled",
      lead: { id: repLead, name: "Dana Lead" },
    });
  });

  it("someone who sees everyone's sees every meeting with a lead, but another person's unlinked meeting never", async () => {
    const r = await get(managerC, `/api/v1/meetings?${range(-24, 24)}`);
    expect(ids(r)).toEqual([M.repLinked, M.otherLinked, M.otherOnRepLead, M.repPast].sort());
    const one = await get(managerC, `/api/v1/meetings?${range(-24, 24)}&ownerId=${other.id}`);
    expect(ids(one)).toEqual([M.otherLinked, M.otherOnRepLead].sort());
  });

  it("filters by pipeline and stage (meetings with leads only)", async () => {
    const [first] = Object.keys(stages);
    const r = await get(managerC, `/api/v1/meetings?${range(-24, 24)}&stageId=${stages[first!]}`);
    expect(ids(r)).toEqual([M.repLinked, M.otherOnRepLead, M.repPast].sort());
    const p = await get(
      managerC,
      `/api/v1/meetings?${range(-24, 24)}&pipelineId=${(await h.config()).pipelineId}`,
    );
    expect(ids(p)).toEqual([M.repLinked, M.otherLinked, M.otherOnRepLead, M.repPast].sort());
  });

  it("refuses a range that ends before it starts, or spans more than 100 days", async () => {
    expect((await get(repC, `/api/v1/meetings?${range(24, -24)}`)).statusCode).toBe(400);
    expect((await get(repC, `/api/v1/meetings?${range(0, 101 * 24)}`)).statusCode).toBe(400);
  });

  it("needs calendar.view", async () => {
    expect((await get(noCalendarC, `/api/v1/meetings?${range(-24, 24)}`)).statusCode).toBe(403);
  });

  it("a lead's meetings: every one with a lead they may see, whoever's calendar", async () => {
    const r = await get(repC, `/api/v1/leads/${repLead}/meetings`);
    expect(ids(r)).toEqual([M.repLinked, M.otherOnRepLead, M.repPast, M.repFuture].sort());
    expect((await get(repC, `/api/v1/leads/${otherLead}/meetings`)).statusCode).toBe(404);
  });

  it("attaching an unlinked meeting: to a lead they can see, only their own meeting", async () => {
    expect((await patch(repC, M.repUnlinked, { leadId: otherLead })).json().error.code).toBe(
      "LEAD_NOT_FOUND",
    );
    expect((await patch(repC, M.otherUnlinked, { leadId: repLead })).statusCode).toBe(404);
    const r = await patch(repC, M.repUnlinked, { leadId: repLead });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: M.repUnlinked, lead: { id: repLead } });
    // linked already: attaching again is refused
    expect((await patch(repC, M.repUnlinked, { leadId: repLead })).json().error.code).toBe("MEETING_LINKED");
  });

  it("an outcome: once, and only after the meeting starts", async () => {
    const early = await patch(repC, M.repLinked, { status: "completed" });
    expect([early.statusCode, early.json().error.code]).toEqual([409, "MEETING_NOT_YET"]);
    const r = await patch(repC, M.repPast, { status: "no_show", outcomeNote: "Didn't join; rebook" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "no_show", outcomeNote: "Didn't join; rebook" });
    const again = await patch(repC, M.repPast, { status: "completed" });
    expect([again.statusCode, again.json().error.code]).toEqual([409, "OUTCOME_RECORDED"]);
    // 5D Review Focus 4: the refusal says who logged it and how it went, so the second person knows.
    expect(again.json().error.message).toBe("Riya Rep already logged this meeting: No-show.");
    expect(again.json().error.details).toEqual({ by: "Riya Rep", status: "no_show" });
    const audit = await h.queryAll<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id",
      [M.repPast],
    );
    expect(audit.map((a) => a.action)).toEqual(["meeting.outcome"]);
  });
});

describe("Log outcome (5A Task 6)", () => {
  it("after a meeting with a lead ends, its owner gets one follow-up; recording the outcome completes it", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Lena Lead" });
    const ended = newId();
    const later = newId();
    const unlinked = newId();
    const longAgo = newId();
    await meeting(ended, rep.id, lead, new Date(h.clock.now.getTime() - 3 * HOUR), "Intro with Lena");
    await meeting(later, rep.id, lead, new Date(h.clock.now.getTime() + 3 * HOUR), "Lena again");
    await meeting(unlinked, rep.id, null, new Date(h.clock.now.getTime() - 3 * HOUR), "Unlinked");
    await meeting(longAgo, rep.id, lead, new Date(h.clock.now.getTime() - 50 * HOUR), "Long ago");
    const deps = { app: h.app, pool: h.pool };
    expect(await askOutcomes(deps, h.clock.now)).toBeGreaterThanOrEqual(1);
    expect(await askOutcomes(deps, h.clock.now)).toBe(0);
    const tasks = await h.queryAll<{ id: string; title: string; assignee_id: string; status: string }>(
      "SELECT id, title, assignee_id, status FROM tasks WHERE lead_id = $1",
      [lead],
    );
    expect(tasks.map((t) => [t.title, t.assignee_id, t.status])).toEqual([
      ["Log outcome: Intro with Lena", rep.id, "open"],
    ]);
    const r = await patch(repC, ended, { status: "completed", outcomeNote: "Good fit" });
    expect(r.statusCode).toBe(200);
    const [t] = await h.queryAll<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [
      tasks[0]!.id,
    ]);
    expect(t).toEqual({ status: "done" });
  });
});

describe("Log outcome, twice at once (5D Review Focus 4)", () => {
  it("two people logging the same meeting at the same moment: one is recorded, the other is told", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Race Lead" });
    const id = newId();
    await meeting(id, rep.id, lead, new Date(h.clock.now.getTime() - 3 * HOUR), "Race call");
    const [a, b] = await Promise.all([
      patch(repC, id, { status: "completed", outcomeNote: "Went well" }),
      patch(managerC, id, { status: "no_show" }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const audit = await h.queryAll<{ action: string }>("SELECT action FROM audit_log WHERE entity_id = $1", [
      id,
    ]);
    expect(audit.filter((x) => x.action === "meeting.outcome")).toHaveLength(1);
  });
});
