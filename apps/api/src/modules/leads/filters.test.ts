import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { scopeCondition } from "./query";

// 4B Task 1: the filters saved views need — no reply for days, lost a while ago, overdue follow-ups,
// new today (in the business's timezone).
let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;
let adminId: string;
let repId: string;

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  const a = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  adminId = a.id;
  admin = await h.signIn(a);
  const r = await h.seedUser({
    grants: [{ key: "leads.view", scope: "own" }],
    totp: true,
  });
  repId = r.id;
  rep = await h.signIn(r);
});
afterAll(() => h.close());

const names = async (c: AuthedClient, query: string) => {
  const r = await c.inject({ method: "GET", url: `/api/v1/leads?limit=100&${query}` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().items as { name: string }[]).map((l) => l.name).sort();
};
const set = (id: string, sql: string, params: unknown[] = []) =>
  h.queryAll(`UPDATE leads SET ${sql} WHERE id = $1`, [id, ...params]);
const days = (n: number) => new Date(Date.now() - n * 86_400_000);
const overdueTask = async (leadId: string, assignee: string, status = "open") =>
  h.queryAll(
    `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, status, series_id)
     VALUES ($1, $2, $3, 'Chase', now() - interval '2 hours', $4, $1)`,
    [newId(), leadId, assignee, status],
  );

describe("the leads filters for saved views (4B Task 1)", () => {
  it("no reply for N days: messaged that long ago, not answered since, and still open", async () => {
    const quiet = await h.seedLead({ ownerId: adminId, name: "NR Quiet" });
    await set(quiet, "last_message_at = $2", [days(4)]);
    const recent = await h.seedLead({ ownerId: adminId, name: "NR Recent" });
    await set(recent, "last_message_at = $2", [days(1)]);
    const answered = await h.seedLead({ ownerId: adminId, name: "NR Answered" });
    await set(answered, "last_message_at = $2, last_reply_at = $3", [days(5), days(4)]);
    const answeredBefore = await h.seedLead({ ownerId: adminId, name: "NR Replied Earlier" });
    await set(answeredBefore, "last_message_at = $2, last_reply_at = $3", [days(4), days(6)]);
    const lost = await h.seedLead({ ownerId: adminId, name: "NR Lost", stage: "Lost" });
    await set(lost, "last_message_at = $2", [days(9)]);
    const all = await names(admin, "noReplyDays=3");
    expect(all.filter((n) => n.startsWith("NR "))).toEqual(["NR Quiet", "NR Replied Earlier"]);
  });

  it("lost N+ days ago, and lost for a reason", async () => {
    const [r1, r2] = await h.queryAll<{ id: string }>(
      "SELECT id FROM lost_reasons ORDER BY position LIMIT 2",
    );
    const ten = await h.seedLead({ ownerId: adminId, name: "LD Ten", stage: "Lost" });
    await set(ten, "lost_at = $2, lost_reason_id = $3", [days(10), r1!.id]);
    const forty = await h.seedLead({ ownerId: adminId, name: "LD Forty", stage: "Lost" });
    await set(forty, "lost_at = $2, lost_reason_id = $3", [days(40), r2!.id]);
    const open = await h.seedLead({ ownerId: adminId, name: "LD Open" });
    await set(open, "lost_at = $2", [days(40)]); // an old loss, since reopened: not lost now
    const ld = (xs: string[]) => xs.filter((n) => n.startsWith("LD "));
    expect(ld(await names(admin, "lostDaysAgo=7"))).toEqual(["LD Forty", "LD Ten"]);
    expect(ld(await names(admin, "lostDaysAgo=30"))).toEqual(["LD Forty"]);
    expect(ld(await names(admin, `lostReasonId=${r1!.id}`))).toEqual(["LD Ten"]);
  });

  it("an overdue follow-up: open and past due only; a rep counts only their own", async () => {
    const mine = await h.seedLead({ ownerId: repId, name: "OD Rep Overdue" });
    await overdueTask(mine, repId);
    const other = await h.seedLead({ ownerId: adminId, name: "OD Admin Overdue" });
    await overdueTask(other, adminId);
    const done = await h.seedLead({ ownerId: adminId, name: "OD Done" });
    await overdueTask(done, adminId, "done");
    const od = (xs: string[]) => xs.filter((n) => n.startsWith("OD "));
    expect(od(await names(admin, "followUpOverdue=true"))).toEqual(["OD Admin Overdue", "OD Rep Overdue"]);
    expect(od(await names(rep, "followUpOverdue=true"))).toEqual(["OD Rep Overdue"]);
  });

  it("Review Focus 5: new today is today in the business's timezone, not the server's", async () => {
    await h.queryAll("UPDATE settings SET timezone = 'Pacific/Auckland'");
    try {
      // Arrived in LUME at 23:30 yesterday and 00:30 today, Auckland time; and one with an enquiry date
      // (from a sheet) of today there, which counts by that date.
      const startLocal = `(date_trunc('day', now() AT TIME ZONE 'Pacific/Auckland') AT TIME ZONE 'Pacific/Auckland')`;
      const late = await h.seedLead({ ownerId: adminId, name: "ND Yesterday 23:30" });
      await h.queryAll(`UPDATE leads SET created_at = ${startLocal} - interval '30 minutes' WHERE id = $1`, [
        late,
      ]);
      const early = await h.seedLead({ ownerId: adminId, name: "ND Today 00:30" });
      await h.queryAll(`UPDATE leads SET created_at = ${startLocal} + interval '30 minutes' WHERE id = $1`, [
        early,
      ]);
      const dated = await h.seedLead({ ownerId: adminId, name: "ND Enquired today" });
      await h.queryAll(
        `UPDATE leads SET created_at = now() - interval '20 days',
           lead_created_at = (now() AT TIME ZONE 'Pacific/Auckland')::date WHERE id = $1`,
        [dated],
      );
      const nd = (xs: string[]) => xs.filter((n) => n.startsWith("ND "));
      expect(nd(await names(admin, "createdDays=1"))).toEqual(["ND Enquired today", "ND Today 00:30"]);
      expect(nd(await names(admin, "createdDays=2"))).toEqual([
        "ND Enquired today",
        "ND Today 00:30",
        "ND Yesterday 23:30",
      ]);
    } finally {
      await h.queryAll("UPDATE settings SET timezone = 'Asia/Dubai'");
    }
  });

  it("refuses values that make no sense, in words", async () => {
    for (const q of ["noReplyDays=0", "createdDays=400", "lostReasonId=nope", "lostDaysAgo=-1"]) {
      const r = await admin.inject({ method: "GET", url: `/api/v1/leads?${q}` });
      expect(r.statusCode, q).toBe(400);
    }
  });
});

describe("7A: the person's scope as a plain condition (it never shows more, or less, than row-level security)", () => {
  const ids = async (c: AuthedClient, query = "") => {
    const r = await c.inject({ method: "GET", url: `/api/v1/leads?limit=100&q=Qzx&${query}` });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json().items as { id: string }[]).map((l) => l.id).sort();
  };
  const total = async (c: AuthedClient, query = "") => {
    const cfg = await h.config();
    const r = await c.inject({
      method: "GET",
      url: `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}&q=Qzx&${query}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().total as number;
  };
  const view = (scope: "own" | "team") => [
    { key: "leads.view" as const, scope },
    { key: "leads.export" as const, scope: null },
  ];

  it("own, team, an empty team, and all: each sees exactly its leads; filters can narrow, never widen (Review Focus 4)", async () => {
    const own = await h.seedUser({ grants: view("own"), totp: true });
    const mate = await h.seedUser({ grants: view("own") });
    const lone = await h.seedUser({ grants: view("team"), totp: true }); // leads a team, but nobody in it
    const leader = await h.seedUser({ grants: view("team"), totp: true });
    const outsider = await h.seedUser({ grants: view("own") });
    await h.seedTeam(leader.id, [mate.id]);
    await h.seedTeam(lone.id, []);
    const L = {
      own: await h.seedLead({ ownerId: own.id, name: "Qzx Own" }),
      mate: await h.seedLead({ ownerId: mate.id, name: "Qzx Mate" }),
      leader: await h.seedLead({ ownerId: leader.id, name: "Qzx Leader" }),
      lone: await h.seedLead({ ownerId: lone.id, name: "Qzx Lone" }),
      outsider: await h.seedLead({ ownerId: outsider.id, name: "Qzx Outsider" }),
      none: await h.seedLead({ ownerId: null, name: "Qzx Unassigned" }),
    };
    const c = {
      own: await h.signIn(own),
      lone: await h.signIn(lone),
      leader: await h.signIn(leader),
    };
    expect(await ids(c.own)).toEqual([L.own]);
    expect(await ids(c.leader)).toEqual([L.leader, L.mate].sort());
    expect(await ids(c.lone)).toEqual([L.lone]);
    expect(await ids(admin)).toEqual(Object.values(L).sort());
    // Asking for someone outside the scope, or for unassigned leads, finds nothing; "me" is just their own.
    expect(await ids(c.own, `ownerId=${outsider.id}`)).toEqual([]);
    expect(await ids(c.own, "ownerId=none")).toEqual([]);
    expect(await ids(c.leader, `ownerId=${outsider.id}`)).toEqual([]);
    expect(await ids(c.leader, `ownerId=${mate.id}`)).toEqual([L.mate]);
    expect(await ids(c.leader, "ownerId=me")).toEqual([L.leader]);
    expect(await ids(admin, "ownerId=none")).toEqual([L.none]);
    // The counts and the export agree with the list.
    expect(await total(c.own)).toBe(1);
    expect(await total(c.leader)).toBe(2);
    expect(await total(c.lone)).toBe(1);
    expect(await total(admin)).toBe(6);
    const made = await c.leader.inject({
      method: "POST",
      url: "/api/v1/leads/export",
      payload: { format: "csv", label: "Team", filters: { q: "Qzx" }, columns: ["name"] },
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().export.rows).toBe(2);
  });

  it("the condition itself: own names the person, team adds the team (once each), all adds nothing, no grant is own", async () => {
    const actor = (over: Record<string, unknown>) =>
      ({
        actor: { userId: "u-me", teamMemberIds: [], perms: new Map(), isOwner: false, ...over },
      }) as unknown as FastifyRequest;
    expect(scopeCondition(actor({ perms: new Map([["leads.view", "all"]]) }))).toBeUndefined();
    expect(scopeCondition(actor({ perms: new Map([["leads.view", "own"]]) }))).toBeDefined();
    expect(scopeCondition(actor({ perms: new Map() }))).toBeDefined();
    expect(
      scopeCondition(actor({ perms: new Map([["leads.view", "team"]]), teamMemberIds: ["u-me", "u-a"] })),
    ).toBeDefined();
  });
});
