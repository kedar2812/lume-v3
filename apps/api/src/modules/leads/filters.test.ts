import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

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
