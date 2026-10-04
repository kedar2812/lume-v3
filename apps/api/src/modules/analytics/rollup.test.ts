import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { daysBack, rollupDays } from "./rollup";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const TZ = "Asia/Kolkata";
/** Read a rollup as a person would: their id and analytics reach set, as each request sets them. */
async function readAs<T extends Record<string, unknown>>(
  userId: string,
  scope: string,
  sql: string,
  params: unknown[] = [],
) {
  const c = await h.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('lume.user_id', $1, true), set_config('lume.analytics_scope', $2, true)",
      [userId, scope],
    );
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}
const at = (iso: string) => iso; // instants are written in UTC; 18:30Z is midnight in Kolkata
async function lead(ownerId: string | null, createdAt: string, o: { wonAt?: string; value?: number } = {}) {
  const id = await h.seedLead({ ownerId });
  await h.queryAll(
    "UPDATE leads SET created_at = $2::timestamptz, won_at = $3::timestamptz, value = $4 WHERE id = $1",
    [id, createdAt, o.wonAt ?? null, o.value ?? null],
  );
  return id;
}
const touch = (leadId: string, type: string, iso: string) =>
  h.queryAll(
    "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, $2, $3::timestamptz)",
    [leadId, type, iso],
  );

describe("analytics rollups (8A Tasks 4–5)", () => {
  it("counts a business day's cohort, in that day's own time, credited to the owner at arrival", async () => {
    const ana = await h.seedUser({ grants: [{ key: "analytics.view", scope: "own" }] });
    const ben = await h.seedUser({ grants: [{ key: "analytics.view", scope: "own" }] });
    const d = "2026-08-03";
    const a1 = await lead(ana.id, at("2026-08-02T18:45:00Z")); // 00:15 IST on the 3rd
    const a2 = await lead(ana.id, at("2026-08-03T18:00:00Z")); // 23:30 IST on the 3rd
    await lead(ana.id, at("2026-08-03T18:30:00Z")); // 00:00 IST on the 4th: not the 3rd
    const b1 = await lead(ben.id, at("2026-08-03T05:00:00Z"));
    await touch(a1, "whatsapp_opened", "2026-08-02T19:15:00Z"); // 30 minutes after arriving
    await touch(a1, "reply_logged", "2026-08-03T02:00:00Z");
    await touch(a2, "call_logged", "2026-08-04T01:30:00Z"); // 7 hours 30 minutes
    await touch(b1, "whatsapp_opened", "2026-08-03T05:10:00Z");
    await rollupDays(h.pool, [d], TZ);

    const mine = await readAs<{
      arrived: number;
      contacted: number;
      replied: number;
      within_1h: number;
      within_24h: number;
      contact_minutes_sum: string;
      speed_hist: number[];
    }>(
      ana.id,
      "own",
      "SELECT arrived, contacted, replied, within_1h, within_24h, contact_minutes_sum, speed_hist FROM analytics_daily_cohort WHERE day = $1",
      [d],
    );
    expect(mine).toHaveLength(1); // only Ana's own row
    expect(mine[0]).toMatchObject({ arrived: 2, contacted: 2, replied: 1, within_1h: 1, within_24h: 2 });
    expect(Number(mine[0]!.contact_minutes_sum)).toBe(30 + 450);
    expect(mine[0]!.speed_hist[3]).toBe(1); // 30 min: the 30–60 bucket
    expect(mine[0]!.speed_hist[6]).toBe(1); // 450 min: the 240–480 bucket

    const all = await readAs<{ n: number }>(
      ana.id,
      "all",
      "SELECT sum(arrived)::int n FROM analytics_daily_cohort WHERE day = $1",
      [d],
    );
    expect(all[0]!.n).toBe(3);
  });

  it("is the same however often it runs, and moves when a late contact arrives", async () => {
    const u = await h.seedUser({ grants: [] });
    const d = "2026-08-10";
    const l1 = await lead(u.id, "2026-08-10T06:00:00Z");
    await rollupDays(h.pool, [d, d], TZ);
    await rollupDays(h.pool, [d], TZ);
    const rows = async () =>
      readAs<{ arrived: number; contacted: number }>(
        u.id,
        "own",
        "SELECT arrived, contacted FROM analytics_daily_cohort WHERE day = $1",
        [d],
      );
    expect(await rows()).toEqual([{ arrived: 1, contacted: 0 }]);
    await touch(l1, "whatsapp_opened", "2026-08-13T06:00:00Z"); // three days later
    await rollupDays(h.pool, [d], TZ);
    expect(await rows()).toEqual([{ arrived: 1, contacted: 1 }]);
    // Two runs of the same day at once leave one copy.
    await Promise.all([rollupDays(h.pool, [d], TZ), rollupDays(h.pool, [d], TZ)]);
    expect(await rows()).toHaveLength(1);
  });

  it("credits a win to whoever owned the lead when it was won, not today's owner", async () => {
    const seller = await h.seedUser({ grants: [] });
    const later = await h.seedUser({ grants: [] });
    const d = "2026-08-20";
    const l = await lead(seller.id, "2026-08-01T06:00:00Z", { wonAt: "2026-08-20T07:00:00Z", value: 5000 });
    await h.queryAll(
      "INSERT INTO lead_assignment_history (lead_id, from_user_id, to_user_id, changed_at) VALUES ($1, $2, $3, '2026-08-25T06:00:00Z')",
      [l, seller.id, later.id],
    );
    await h.queryAll("UPDATE leads SET owner_id = $2 WHERE id = $1", [l, later.id]);
    await rollupDays(h.pool, [d], TZ);
    const s = await readAs<{ won: number; won_value: string }>(
      seller.id,
      "own",
      "SELECT won, won_value FROM analytics_daily_event WHERE day = $1",
      [d],
    );
    expect(s).toEqual([{ won: 1, won_value: "5000.00" }]);
    const l2 = await readAs(later.id, "own", "SELECT 1 FROM analytics_daily_event WHERE day = $1", [d]);
    expect(l2).toHaveLength(0);
  });

  it("can't be read without an analytics reach, and can't be written by the app", async () => {
    const u = await h.seedUser({ grants: [] });
    expect(await readAs(u.id, "", "SELECT 1 FROM analytics_daily_cohort")).toHaveLength(0);
    await expect(
      h.pool.query(
        "INSERT INTO analytics_daily_slot (day, kind, dow, hour, n) VALUES ('2026-08-01', 'sends', 1, 9, 1)",
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("lists the business days to recompute, newest first, without repeats", () => {
    const now = new Date("2026-08-03T20:00:00Z"); // Aug 4, 01:30 IST
    expect(daysBack(now, TZ, 0, 1)).toEqual(["2026-08-04", "2026-08-03"]);
    expect(daysBack(now, TZ, 7, 89)).toHaveLength(83);
  });
});
