import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_TOUCH_RULE_ID } from "@lume/core";
import { createHarness, type Harness, type SeededUser } from "../../test/harness";
import { LiveDayRefused, seedLiveDay } from "./live-day";
import { seedDemoBusiness } from "./seed";

/** A working morning on the demo business (website spec §6): what the captures show at 10:45. */
let h: Harness;
let owner: SeededUser;
let seller: SeededUser;
// 10:45 am in Kolkata.
const NOW = new Date("2026-10-07T05:15:00Z");

beforeAll(async () => {
  h = await createHarness();
  h.clock.now = NOW;
  await h.ownerPool.query("UPDATE settings SET timezone = 'Asia/Kolkata', currency = 'INR' WHERE id = 1");
  await seedDemoBusiness(h.ownerPool, { now: NOW, seed: 7, trajectory: "growing" });
  owner = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "all" },
      { key: "leads.assign", scope: "all" },
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
    ],
    totp: true,
  });
  seller = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "analytics.view", scope: "own" },
    ],
    totp: true,
  });
  await h.queryAll("UPDATE users SET timezone = NULL WHERE id = ANY($1::uuid[])", [[owner.id, seller.id]]);
  await seedLiveDay(h.ownerPool, {
    now: NOW,
    people: [
      { userId: owner.id, scope: "all" },
      { userId: seller.id, scope: "own" },
    ],
  });
}, 300_000);
afterAll(async () => h.close());

const today = async (u: SeededUser) =>
  (await (await h.signIn(u)).inject({ method: "GET", url: "/api/v1/today" })).json();
const tiles = async (u: SeededUser) =>
  (await (await h.signIn(u)).inject({ method: "GET", url: "/api/v1/today/tiles" })).json();

describe("a working day on Today (website spec §6)", () => {
  it("the owner's day: overdue, soon, later, done, calls, someone waiting", async () => {
    const t = await today(owner);
    expect([t.overdue.length, t.soon.length, t.later.length, t.done]).toEqual([2, 3, 4, 3]);
    expect(t.meetings.map((m: { status: string }) => m.status)).toEqual(["completed", "scheduled"]);
    expect(t.needsYou.unassigned).toBeGreaterThanOrEqual(3);
    expect(t.overdue.some((x: { title: string }) => x.title === "No contact for 3 days")).toBe(true);
  });

  it("a rep's own day fills from their own leads", async () => {
    const t = await today(seller);
    expect([t.overdue.length, t.soon.length, t.later.length, t.done]).toEqual([2, 3, 4, 3]);
    expect(t.meetings).toHaveLength(2);
    expect(t.needsYou).toBeUndefined();
  });

  it("a deal won this morning counts in the month", async () => {
    const s = await tiles(owner);
    expect(s.month.value).toBeGreaterThan(0);
    expect(s.pipeline.wonThisMonth).toBeGreaterThan(0);
  });

  it("the no-touch follow-up is the rule's own kind", async () => {
    const r = await h.queryAll<{ n: number }>(
      "SELECT count(*)::int AS n FROM tasks WHERE auto_rule_id = $1 AND assignee_id = $2",
      [NO_TOUCH_RULE_ID, owner.id],
    );
    expect(r[0]!.n).toBe(1);
  });

  it("refuses to plant the same day twice", async () => {
    await expect(
      seedLiveDay(h.ownerPool, { now: NOW, people: [{ userId: owner.id, scope: "all" }] }),
    ).rejects.toBeInstanceOf(LiveDayRefused);
  });

  it("near midnight, everything still lands on that business day", async () => {
    const late = await createHarness();
    const at = new Date("2026-10-07T18:00:00Z"); // 23:30 in Kolkata
    late.clock.now = at;
    await late.ownerPool.query("UPDATE settings SET timezone = 'Asia/Kolkata' WHERE id = 1");
    await seedDemoBusiness(late.ownerPool, { now: at, seed: 7 });
    const u = await late.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true });
    await seedLiveDay(late.ownerPool, { now: at, people: [{ userId: u.id, scope: "own" }] });
    const days = await late.queryAll<{ d: string }>(
      "SELECT DISTINCT to_char(due_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS d FROM tasks WHERE assignee_id = $1",
      [u.id],
    );
    expect(days.map((x) => x.d)).toEqual(["2026-10-07"]);
    await late.close();
  }, 300_000);
});
