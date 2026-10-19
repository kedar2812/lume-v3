import { randomUUID } from "node:crypto";
import { ALL_GRANTS, type PlanClaim } from "@lume/core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { seedNumber } from "../../../test/whatsapp";
import { notePaidUse, paidLimit, paidLimitError, paidUse } from "./paid";

/** The monthly limit on paid WhatsApp messages (plan W3b-2 Task 5; owner 2026-10-19: usage is monthly). */
let h: Harness;
let admin: { id: string };
let rep: { id: string };
let number: string;
let lead: string;
const TZ = "Asia/Kolkata";
const plan = (paidSendsMonthly: number | null): PlanClaim => ({
  places: null,
  modules: { googleSheets: true, webhooks: true, googleCalendar: true, calendly: true },
  paidSendsMonthly,
});
const sent = (at: string, o: { paid?: boolean; status?: string } = {}) =>
  h.queryAll(
    `INSERT INTO whatsapp_outbox (id, lead_id, number_id, user_id, client_key, text, status, paid, created_at)
     VALUES ($1, $2, $3, $4, $5, 'Hi', $6, $7, $8)`,
    [randomUUID(), lead, number, rep.id, randomUUID(), o.status ?? "sent", o.paid ?? true, at],
  );
async function usageNotices(userId: string) {
  const c = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
  await c.connect();
  try {
    return (
      await c.query<{ title: string }>(
        "SELECT title FROM notifications WHERE user_id = $1 AND kind = 'whatsapp_usage' ORDER BY id",
        [userId],
      )
    ).rows;
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  h = await createHarness();
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
  number = await seedNumber(h, { runAs: admin.id });
  lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: "+919876543210" });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.queryAll("DELETE FROM whatsapp_outbox"); // row-level secured: deleted with every lead in scope
});

describe("the monthly limit", () => {
  it("is the lower of the plan's and the admin's own; none when neither sets one", () => {
    expect(paidLimit(null, { paidSendsMonthly: null })).toBeNull();
    expect(paidLimit(plan(null), { paidSendsMonthly: null })).toBeNull();
    expect(paidLimit(plan(1000), { paidSendsMonthly: null })).toBe(1000);
    expect(paidLimit(plan(1000), { paidSendsMonthly: 400 })).toBe(400);
    expect(paidLimit(plan(300), { paidSendsMonthly: 400 })).toBe(300);
    expect(paidLimit(null, { paidSendsMonthly: 250 })).toBe(250);
  });

  it("counts this calendar month's paid messages on the business's clock: every lead's, not failed ones", async () => {
    await sent("2026-10-01T00:00:00+05:30"); // the first minute of October in India
    await sent("2026-10-20T06:00:00Z");
    await sent("2026-10-31T23:30:00+05:30"); // the last half hour of October in India
    await sent("2026-10-20T06:00:00Z", { paid: false }); // inside the 24 hours, no charge
    await sent("2026-10-20T06:00:00Z", { status: "failed" }); // never went
    await sent("2026-09-30T23:59:00+05:30"); // September
    await sent("2026-11-01T00:00:00+05:30"); // November
    // Counted by a request that can't see this lead (the app's own role, no one signed in): the count is everyone's.
    expect(await paidUse(h.pool, new Date("2026-10-20T06:00:00Z"), TZ)).toBe(3);
    expect(await paidUse(h.pool, new Date("2026-11-15T06:00:00Z"), TZ)).toBe(1);
  });

  it("at the limit, LUME says so with the numbers", () => {
    expect(paidLimitError(1000, 1000).message).toBe(
      "This month's paid WhatsApp messages are used up (1,000 of 1,000). An admin can ask for more.",
    );
    expect(paidLimitError(1000, 1000).status).toBe(409);
  });

  it("tells the admins once a month when 80% is used", async () => {
    const oct = new Date("2026-10-20T06:00:00Z");
    await notePaidUse(h.pool, oct, TZ, 799, 1000);
    expect(await usageNotices(admin.id)).toEqual([]);
    await notePaidUse(h.pool, oct, TZ, 800, 1000);
    await notePaidUse(h.pool, oct, TZ, 950, 1000);
    expect(await usageNotices(admin.id)).toEqual([
      { title: "80% of this month's paid WhatsApp messages are used (800 of 1,000)." },
    ]);
    await notePaidUse(h.pool, new Date("2026-11-20T06:00:00Z"), TZ, 820, 1000);
    expect(await usageNotices(admin.id)).toHaveLength(2);
    expect(await usageNotices(rep.id)).toEqual([]);
  });
});
