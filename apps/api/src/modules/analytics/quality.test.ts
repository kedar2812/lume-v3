import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JUNE, analyticsSeed, at } from "../../../test/analytics-seed";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";

beforeAll(async () => {
  h = await createHarness();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  const s = analyticsSeed(h);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "leads.view", scope: "all" },
    ],
  });
  rep = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "own" },
      { key: "leads.view", scope: "own" },
    ],
  });
  // Phones: 7 readable, 2 needing a country, 1 that can't be read, 3 with no number at all.
  const statuses = [
    ...Array(7).fill("valid"),
    "needs_country",
    "needs_country",
    "invalid",
    "missing",
    "missing",
    "missing",
  ];
  const leads: string[] = [];
  for (const [i, st] of statuses.entries())
    leads.push(await s.lead({ owner: admin.id, at: at(6, i + 1), phoneStatus: st }));
  // Two duplicates merged into existing leads in June (each leaves "imported again" on the lead it joined).
  for (const day of [5, 9])
    await h.queryAll(
      "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, 'imported_again', $2)",
      [leads[0], at(6, day)],
    );
  // Unowned leads waiting 30 minutes, 5 hours, 3 days and 10 days.
  for (const wait of ["30 minutes", "5 hours", "3 days", "10 days"]) {
    const id = await h.seedLead({ ownerId: null });
    await h.queryAll("UPDATE leads SET created_at = now() - $2::interval WHERE id = $1", [id, wait]);
  }
  // A deleted lead with an unreadable number and no owner: counted nowhere.
  const gone = await h.seedLead({ ownerId: null });
  await h.queryAll("UPDATE leads SET phone_status = 'invalid', deleted_at = now() WHERE id = $1", [gone]);
  // One import in June: 20 rows, 3 that errored and 1 skipped.
  const src = await s.source("Fair list");
  await h.ownerPool.query(
    `INSERT INTO imports (id, source_id, kind, status, file_sha256, file_name, file_bytes, row_count, errors, skipped, finished_at)
     VALUES ($1, $2, 'csv', 'done', 'x', 'fair.csv', 100, 20, 3, 1, $3)`,
    [randomUUID(), src, at(6, 10)],
  );
  // Sources: one paused with a reason, one needing attention, one fine, one archived (none of LUME's business now).
  for (const [name, status, err] of [
    ["Webinar sheet", "paused", "A column was renamed"],
    ["Website form", "needs_attention", null],
    ["Fine sheet", "active", null],
    ["Old sheet", "archived", "Gone"],
  ] as const) {
    const id = await s.source(name);
    await h.ownerPool.query("UPDATE lead_sources SET status = $2, last_error = $3 WHERE id = $1", [
      id,
      status,
      err,
    ]);
  }
  await rollupDays(h.pool, JUNE, TZ);
});
afterAll(async () => h.close());

const get = async (u: SeededUser) =>
  (await (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/analytics/quality?${Q}` })).json();
const opens = async (token: string) =>
  (
    await (
      await h.signIn(admin)
    ).inject({ method: "GET", url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(token)}` })
  ).json().total as number;

describe("data quality (8D-1 Task 9)", () => {
  it("numbers LUME can read: the readable share, and the ones to fix, each opening its leads", async () => {
    const q = await get(admin);
    expect(q.phones).toMatchObject({
      total: 10,
      readable: 7,
      readableShare: 0.7,
      needsCountry: 2,
      invalid: 1,
    });
    expect(await opens(q.phones.drill.needsCountry)).toBe(2);
    expect(await opens(q.phones.drill.invalid)).toBe(1);
  });

  it("duplicates merged in the range, for those who see everything", async () => {
    expect((await get(admin)).duplicatesMerged).toBe(2);
    expect((await get(rep)).duplicatesMerged).toBe(0);
  });

  it("unowned leads by how long they've waited, each wait opening its leads", async () => {
    const q = await get(admin);
    expect(q.unowned).toMatchObject({ under1h: 1, under1d: 1, under7d: 1, over7d: 1 });
    for (const k of ["under_1h", "under_1d", "under_7d", "over_7d"])
      expect(await opens(q.unowned.drill[k])).toBe(1);
    // A rep sees no unowned leads at all.
    expect((await get(rep)).unowned).toMatchObject({ under1h: 0, under1d: 0, under7d: 0, over7d: 0 });
  });

  it("how long the oldest unowned lead has waited, in minutes", async () => {
    const q = await get(admin);
    expect(q.unowned.oldestMinutes).toBeGreaterThanOrEqual(10 * 24 * 60 - 1);
    expect(q.unowned.oldestMinutes).toBeLessThan(10 * 24 * 60 + 60);
    expect((await get(rep)).unowned.oldestMinutes).toBeNull();
  });

  it("sources needing a look: paused or needing attention, with what LUME last saw; not for a rep", async () => {
    const q = await get(admin);
    expect(q.sourcesNeedingLook).toEqual([
      expect.objectContaining({ name: "Webinar sheet", status: "paused", message: "A column was renamed" }),
      expect.objectContaining({ name: "Website form", status: "needs_attention", message: null }),
    ]);
    expect((await get(rep)).sourcesNeedingLook).toEqual([]);
  });

  it("imports and what didn't come in cleanly", async () => {
    const q = await get(admin);
    expect(q.imports).toEqual([expect.objectContaining({ name: "Fair list", rows: 20, rejected: 4 })]);
  });
});
