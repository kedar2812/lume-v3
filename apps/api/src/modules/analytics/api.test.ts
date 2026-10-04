import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
let money: SeededUser;
const TZ = "Asia/Kolkata";
const DAYS = ["2026-07-06", "2026-07-07", "2026-07-08"];
const Q = "range=custom&from=2026-07-06&to=2026-07-08";
const ids: Record<string, string> = {};

async function lead(
  name: string,
  ownerId: string | null,
  createdAt: string,
  o: { wonAt?: string; value?: number } = {},
) {
  const id = await h.seedLead({ ownerId, name });
  await h.queryAll(
    "UPDATE leads SET created_at = $2::timestamptz, won_at = $3::timestamptz, value = $4 WHERE id = $1",
    [id, createdAt, o.wonAt ?? null, o.value ?? null],
  );
  ids[name] = id;
  return id;
}
const touch = (leadId: string, type: string, iso: string) =>
  h.queryAll(
    "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, $2, $3::timestamptz)",
    [leadId, type, iso],
  );

beforeAll(async () => {
  h = await createHarness();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "leads.view", scope: "all" },
    ],
  });
  money = await h.seedUser({
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
  // Four arrive in the range: three of the rep's, one of the admin's. Two are contacted, one replies, two are won.
  const a = await lead("Ana Range One", rep.id, "2026-07-06T05:00:00Z", {
    wonAt: "2026-07-07T06:00:00Z",
    value: 2000,
  });
  const b = await lead("Ana Range Two", rep.id, "2026-07-07T05:00:00Z");
  await lead("Ana Range Three", rep.id, "2026-07-08T05:00:00Z", { wonAt: "2026-07-08T09:00:00Z" });
  const d = await lead("Ben Range Four", admin.id, "2026-07-07T07:00:00Z");
  await lead("Before Range", rep.id, "2026-07-05T05:00:00Z"); // the compare period (July 3–5)
  await touch(a, "whatsapp_opened", "2026-07-06T05:20:00Z");
  await touch(a, "reply_logged", "2026-07-06T08:00:00Z");
  await touch(b, "call_logged", "2026-07-07T09:00:00Z");
  void d;
  await rollupDays(h.pool, [...DAYS, "2026-07-03", "2026-07-04", "2026-07-05"], TZ);
});
afterAll(async () => h.close());

const tile = (body: { tiles: { id: string }[] }, id: string) =>
  body.tiles.find((t) => t.id === id) as unknown as {
    value: number | null;
    previous: number | null;
    trend: { text: string } | null;
    n?: number;
    note?: string;
  };

describe("the analytics API (8A Task 6)", () => {
  it("overview counts the range for everyone in reach, with the compare period and its trend", async () => {
    const c = await h.signIn(admin);
    const r = await c.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}` });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.range.label).toBe("July 6 – 8");
    expect(tile(body, "new_leads")).toMatchObject({ value: 4, previous: 1, trend: { text: "+300.0%" } });
    expect(tile(body, "contacted").value).toBe(0.5);
    expect(tile(body, "reply_rate").value).toBe(0.5);
    expect(tile(body, "won").value).toBe(2);
    expect(tile(body, "win_rate").value).toBe(0.5);
    expect(tile(body, "speed_to_lead").note).toBe("2 not contacted yet");
    expect(body.series.newLeads).toEqual([1, 2, 1]);
    expect(body.series.won).toEqual([0, 1, 1]);
  });

  it("money is there only for someone with analytics.revenue, and says what had no value", async () => {
    const plain = (
      await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}` })
    ).json();
    expect(plain.tiles.map((t: { id: string }) => t.id)).not.toContain("revenue_won");
    const rich = (
      await (await h.signIn(money)).inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}` })
    ).json();
    expect(tile(rich, "revenue_won")).toMatchObject({ value: 2000, note: "1 won without a value" });
    expect(tile(rich, "avg_deal").value).toBe(2000);
  });

  it("a rep sees their own numbers, equal to the admin's filtered to them; another's are refused", async () => {
    const mine = (
      await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}` })
    ).json();
    const filtered = (
      await (
        await h.signIn(admin)
      ).inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&owner=${rep.id}` })
    ).json();
    expect(tile(mine, "new_leads").value).toBe(3);
    for (const id of ["new_leads", "contacted", "reply_rate", "won", "win_rate"])
      expect(tile(mine, id).value).toBe(tile(filtered, id).value);
    const peek = await (
      await h.signIn(rep)
    ).inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&owner=${admin.id}` });
    expect(peek.statusCode).toBe(403);
    expect(peek.json().error.code).toBe("OUTSIDE_REACH");
  });

  it("every number opens exactly its leads, for the person it was made for, for 15 minutes", async () => {
    const c = await h.signIn(admin);
    const body = (await c.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}` })).json();
    const open = async (token: string, who = c) =>
      who.inject({ method: "GET", url: `/api/v1/analytics/drilldown?token=${token}` });
    const newLeads = (await open(body.drill.new_leads)).json();
    expect(newLeads.total).toBe(4);
    expect(newLeads.items.map((l: { name: string }) => l.name).sort()).toEqual(
      ["Ana Range One", "Ana Range Three", "Ana Range Two", "Ben Range Four"].sort(),
    );
    expect((await open(body.drill.contacted)).json().total).toBe(2);
    expect((await open(body.drill.won)).json().total).toBe(2);
    // Someone else's token, an altered one, and an old one are each refused.
    expect((await open(body.drill.won, await h.signIn(rep))).statusCode).toBe(404);
    const altered = body.drill.won.slice(0, -4) + (body.drill.won.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await open(altered)).statusCode).toBe(404);
    h.clock.advance(16 * 60_000);
    const late = await open(body.drill.won);
    expect(late.statusCode).toBe(410);
    expect(late.json().error.message).toMatch(/Open the number again/);
  });

  it("the funnel shows how far the range's leads got; the team table lists each person", async () => {
    const c = await h.signIn(admin);
    const f = (await c.inject({ method: "GET", url: `/api/v1/analytics/funnel?${Q}` })).json();
    expect(f.arrived).toBe(4);
    expect(f.stages[0].share).toBe(1); // every lead reached the first stage
    const won = f.stages.find((s: { kind: string }) => s.kind === "won");
    expect(won.reached).toBe(0); // won_at set by hand here, without moving the stage: the funnel reads stages
    const t = (await c.inject({ method: "GET", url: `/api/v1/analytics/team?${Q}` })).json();
    expect(t.leaderboard).toBe(true);
    expect(t.people.find((p: { id: string }) => p.id === rep.id)).toMatchObject({ newLeads: 3, won: 2 });
    const own = (
      await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/analytics/team?${Q}` })
    ).json();
    expect(own.leaderboard).toBe(false);
    expect(own.people.map((p: { id: string }) => p.id)).toEqual([rep.id]);
  });

  it("refuses a range that ends before it starts, and anyone without analytics", async () => {
    const c = await h.signIn(admin);
    const bad = await c.inject({
      method: "GET",
      url: "/api/v1/analytics/overview?range=custom&from=2026-07-08&to=2026-07-01",
    });
    expect(bad.statusCode).toBe(400);
    const nobody = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
    expect(
      (await (await h.signIn(nobody)).inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}` }))
        .statusCode,
    ).toBe(403);
  });
});
