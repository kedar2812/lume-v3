import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bucketOf } from "@lume/core";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
let cafe: string;
let everyone: string;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";
const days = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
type Tile = { id: string; value: number | null };
const tile = (b: { tiles: Tile[] }, id: string) => b.tiles.find((t) => t.id === id)!.value;

const tag = async (label: string) => {
  const id = randomUUID();
  await h.ownerPool.query("INSERT INTO tags (id, label) VALUES ($1, $2)", [id, label]);
  return id;
};

beforeAll(async () => {
  h = await createHarness();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "all" },
    ],
  });
  rep = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "own" },
      { key: "leads.view", scope: "own" },
    ],
  });
  cafe = await tag("café");
  everyone = await tag("everyone");
  await h.ownerPool.query(
    `INSERT INTO field_definitions (id, key, label, type, options)
     VALUES (gen_random_uuid(), 'budget', 'Budget', 'select', '["Under ₹1 L", "₹1–3 L"]')`,
  );
  // Twelve June leads, half each to the rep and the admin: 5 tagged café, 4 with a ₹1–3 L budget, 6 contacted
  // (3 of them replied), 2 won (one worth 4,000), one follow-up done late. Every lead also carries "everyone".
  for (let i = 0; i < 12; i++) {
    const owner = i % 2 ? rep.id : admin.id;
    const id = await h.seedLead({ ownerId: owner });
    const created = new Date(Date.UTC(2026, 5, i + 1, 5));
    await h.queryAll(
      `UPDATE leads SET created_at = $2, custom = $3::jsonb, won_at = $4, value = $5 WHERE id = $1`,
      [
        id,
        created,
        JSON.stringify(i < 4 ? { budget: "₹1–3 L" } : {}),
        i === 0 || i === 7 ? new Date(created.getTime() + 3 * 86_400_000) : null,
        i === 0 ? 4000 : null,
      ],
    );
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [id, everyone]);
    if (i < 5) await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [id, cafe]);
    if (i < 6) {
      const contact = new Date(created.getTime() + (20 + i * 40) * 60_000);
      await h.queryAll(
        "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, 'whatsapp_opened', $2)",
        [id, contact],
      );
      if (i < 3)
        await h.queryAll(
          "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, 'reply_logged', $2)",
          [id, new Date(contact.getTime() + 3_600_000)],
        );
    }
    if (i === 2)
      await h.queryAll(
        `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, status, series_id, done_at)
         VALUES (gen_random_uuid(), $1, $2, 'Call back', $3, 'done', gen_random_uuid(), $4)`,
        [id, owner, new Date(created.getTime() + 86_400_000), new Date(created.getTime() + 2 * 86_400_000)],
      );
  }
  await rollupDays(h.pool, days, TZ);
});
afterAll(async () => h.close());

describe("tag and field filters, counted live (8D-1 Task 3)", () => {
  it("a tag every lead carries changes nothing: live tiles equal rollup tiles", async () => {
    for (const who of [admin, rep]) {
      const a = await h.signIn(who);
      const plain = (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}` })).json();
      const live = (
        await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&tag=${everyone}` })
      ).json();
      expect(live.tiles.map((t: Tile) => t.id)).toEqual(plain.tiles.map((t: Tile) => t.id));
      for (const t of plain.tiles as Tile[]) {
        const l = tile(live, t.id);
        // Rollups estimate speed to lead from a histogram; live reads the exact median: the same bucket.
        if (t.id === "speed_to_lead" && t.value !== null) expect(bucketOf(l!)).toBe(bucketOf(t.value));
        else if (t.value === null) expect(l, t.id).toBeNull();
        else expect(l, t.id).toBeCloseTo(t.value, 6);
      }
      expect(live.series.newLeads).toEqual(plain.series.newLeads);
    }
  });

  it("a tag and a field narrow to the leads that carry them", async () => {
    const a = await h.signIn(admin);
    const b = (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&tag=${cafe}` })).json();
    expect(tile(b, "new_leads")).toBe(5);
    expect(tile(b, "contacted")).toBeCloseTo(1, 6);
    expect(tile(b, "won")).toBe(1);
    const f = encodeURIComponent(JSON.stringify({ budget: ["₹1–3 L"] }));
    const c = (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&fields=${f}` })).json();
    expect(tile(c, "new_leads")).toBe(4);
    expect(tile(c, "revenue_won")).toBe(4000);
    // A drill from a filtered number opens the filtered leads.
    const open = await a.inject({
      method: "GET",
      url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(c.drill.new_leads)}`,
    });
    expect(open.json().total).toBe(4);
  });

  it("over 92 days, or on a board without a live path, a tag filter is refused in words", async () => {
    const a = await h.signIn(admin);
    const long = await a.inject({
      method: "GET",
      url: `/api/v1/analytics/overview?range=custom&from=2026-01-01&to=2026-06-30&tag=${cafe}`,
    });
    expect(long.statusCode).toBe(400);
    expect(long.json().error.code).toBe("RANGE_TOO_LONG_FOR_FILTER");
    const timing = await a.inject({ method: "GET", url: `/api/v1/analytics/timing?${Q}&tag=${cafe}` });
    expect(timing.statusCode).toBe(400);
    expect(timing.json().error.code).toBe("FILTER_NOT_SUPPORTED");
  });
});
