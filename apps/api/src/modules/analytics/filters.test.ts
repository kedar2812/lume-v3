import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let r1: SeededUser;
let r2: SeededUser;
let r3: SeededUser;
let teamId: string;
let otherTeam: string;
let s1: string;
let s2: string;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";
const days = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
const rep = [
  { key: "analytics.view", scope: "own" },
  { key: "leads.view", scope: "own" },
] as const;

const source = async (name: string) =>
  (
    await h.ownerPool.query(
      "INSERT INTO lead_sources (id, type, name) VALUES (gen_random_uuid(), 'manual', $1) RETURNING id",
      [name],
    )
  ).rows[0].id as string;
const team = async (name: string, members: string[]) => {
  const id = randomUUID();
  await h.ownerPool.query("INSERT INTO teams (id, name) VALUES ($1, $2)", [id, name]);
  for (const m of members)
    await h.ownerPool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [id, m]);
  return id;
};
const lead = async (ownerId: string, sourceId: string, day: number) => {
  const id = await h.seedLead({ ownerId });
  await h.queryAll("UPDATE leads SET created_at = $2, source_id = $3 WHERE id = $1", [
    id,
    `2026-06-${String(day).padStart(2, "0")}T05:00:00Z`,
    sourceId,
  ]);
};
const newLeads = (b: { tiles: { id: string; value: number }[] }) =>
  b.tiles.find((t) => t.id === "new_leads")!.value;

beforeAll(async () => {
  h = await createHarness();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  admin = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "all" },
      { key: "leads.view", scope: "all" },
    ],
  });
  r1 = await h.seedUser({ grants: [...rep] });
  r2 = await h.seedUser({ grants: [...rep] });
  r3 = await h.seedUser({ grants: [...rep] });
  teamId = await team("Inbound", [r1.id, r2.id]);
  otherTeam = await team("Field", [r3.id]);
  s1 = await source("Fair");
  s2 = await source("Website");
  const s3 = await source("Walk-in");
  // r1: 4 from the fair; r2: 1 from the fair, 1 from the website; r3: 1 from the website, 2 walk-ins.
  for (let d = 1; d <= 4; d++) await lead(r1.id, s1, d);
  await lead(r2.id, s1, 5);
  await lead(r2.id, s2, 6);
  await lead(r3.id, s2, 7);
  await lead(r3.id, s3, 8);
  await lead(r3.id, s3, 9);
  await rollupDays(h.pool, days, TZ);
});
afterAll(async () => h.close());

describe("filters for several people, a team, several sources (8D-1 Task 2)", () => {
  it("several people, a team and several sources narrow every number alike", async () => {
    const a = await h.signIn(admin);
    const get = async (q: string) =>
      (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&${q}` })).json();
    expect(newLeads(await get(`owner=${r1.id},${r2.id}`))).toBe(6);
    expect(newLeads(await get(`team=${teamId}`))).toBe(6);
    expect(newLeads(await get(`source=${s1},${s2}`))).toBe(7);
    expect(newLeads(await get(`team=${teamId}&source=${s2}`))).toBe(1);
    // The other modules take the same lists.
    const t = (await a.inject({ method: "GET", url: `/api/v1/analytics/team?${Q}&team=${teamId}` })).json();
    expect(t.people.map((p: { id: string }) => p.id).sort()).toEqual([r1.id, r2.id].sort());
    const s = (
      await a.inject({ method: "GET", url: `/api/v1/analytics/sources?${Q}&owner=${r3.id}` })
    ).json();
    expect(s.sources.reduce((n: number, x: { leads: number }) => n + x.leads, 0)).toBe(3);
  });

  it("a filter past one's reach is refused, never emptied", async () => {
    const me = await h.signIn(r1);
    for (const q of [`owner=${r1.id},${r3.id}`, `team=${otherTeam}`]) {
      const res = await me.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&${q}` });
      expect(res.statusCode, q).toBe(403);
      expect(res.json().error.code).toBe("OUTSIDE_REACH");
    }
    // Their own name in a list is fine.
    const mine = await me.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&owner=${r1.id}` });
    expect(newLeads(mine.json())).toBe(4);
  });

  it("an unknown team is not found; a bad list is a 400", async () => {
    const a = await h.signIn(admin);
    const unknown = await a.inject({
      method: "GET",
      url: `/api/v1/analytics/overview?${Q}&team=${randomUUID()}`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("TEAM_NOT_FOUND");
    expect(
      (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&owner=nope` })).statusCode,
    ).toBe(400);
    expect(
      (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&fields=notjson` })).statusCode,
    ).toBe(400);
  });
});
