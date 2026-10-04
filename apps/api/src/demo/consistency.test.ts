import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../test/harness";
import { seedDemoBusiness } from "./seed";

/**
 * The numbers add up (8D-1, "test on real data"): on the demo business — six months of natural data — every board
 * answers for every range and every kind of viewer, and the numbers agree with each other the way a careful owner
 * would check them: the same count on every board that shows it, each person's numbers adding up to the business's,
 * every drill-down opening exactly its number, a rep's view equal to the admin's filtered to them, and the CSV equal
 * to the screen.
 */
let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;
let lead: AuthedClient;
let plain: AuthedClient;
let repUser: SeededUser;
let teamIds: string[];
let teamId: string;
const NOW = new Date();
const RANGES = ["today", "yesterday", "7d", "30d", "90d", "this_month", "last_month", "this_quarter"];
const BOARDS = [
  "overview",
  "funnel",
  "team",
  "sources",
  "revenue",
  "lost",
  "timing",
  "templates",
  "quality",
  "insights",
  "me",
];
type Tile = { id: string; value: number | null };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  h = await createHarness();
  h.clock.now = NOW;
  await seedDemoBusiness(h.ownerPool, { now: NOW, seed: 11 });
  admin = await h.signIn(
    await h.seedUser({
      grants: [
        { key: "analytics.view", scope: "all" },
        { key: "analytics.revenue", scope: null },
        { key: "leads.view", scope: "all" },
        { key: "leads.export", scope: null },
      ],
      totp: true,
    }),
  );
  plain = await h.signIn(
    await h.seedUser({
      grants: [
        { key: "analytics.view", scope: "all" },
        { key: "leads.view", scope: "all" },
      ],
    }),
  );
  // A rep: one of the demo's own people, given a password-less session (they can't sign in for real).
  const [riya] = await h.queryAll<{ id: string; email: string }>(
    "SELECT id, email::text FROM users WHERE name = 'Riya Shah'",
  );
  repUser = { id: riya!.id, email: riya!.email, password: "" };
  await h.grant(riya!.id, [
    { key: "analytics.view", scope: "own" },
    { key: "analytics.revenue", scope: null },
    { key: "leads.view", scope: "own" },
  ]);
  rep = await h.signIn(repUser);
  // A team lead of the demo's "Inbound" team.
  [{ id: teamId }] = (await h.queryAll<{ id: string }>("SELECT id FROM teams WHERE name = 'Inbound'")) as [
    { id: string },
  ];
  teamIds = (
    await h.queryAll<{ user_id: string }>("SELECT user_id FROM team_members WHERE team_id = $1", [teamId])
  ).map((r) => r.user_id);
  const tl = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "team" },
      { key: "analytics.revenue", scope: null },
      { key: "leads.view", scope: "team" },
    ],
  });
  await h.ownerPool.query("INSERT INTO team_members (team_id, user_id, is_lead) VALUES ($1, $2, true)", [
    teamId,
    tl.id,
  ]);
  lead = await h.signIn(tl);
}, 300_000);
afterAll(async () => h.close());

const get = async (c: AuthedClient, path: string): Promise<Json> => {
  const r = await c.inject({ method: "GET", url: `/api/v1/analytics/${path}` });
  expect(r.statusCode, `${path}: ${r.body.slice(0, 300)}`).toBe(200);
  return r.json();
};
const tile = (o: Json, id: string) => (o.tiles as Tile[]).find((t) => t.id === id)?.value ?? null;
const opens = async (c: AuthedClient, token: string) =>
  (
    await c.inject({ method: "GET", url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(token)}` })
  ).json().total as number;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Words that would show a hole on screen ("NaN", "undefined", "Infinity"), skipping drill tokens (random base64). */
function wordsWithHoles(v: unknown, key = ""): string[] {
  if (key === "drill" || key === "token") return [];
  if (typeof v === "string") return /\b(NaN|undefined|Infinity|null)\b/.test(v) ? [`${key}: ${v}`] : [];
  if (Array.isArray(v)) return v.flatMap((x) => wordsWithHoles(x, key));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => wordsWithHoles(x, k));
  return [];
}

describe("the demo business is in states LUME's own writers leave", () => {
  // A stage move clears what no longer applies (leads/write.ts): a won lead isn't lost, a reopened one is neither.
  it("no lead is both won and lost; a lost reason only on a lost lead; the stage agrees with the dates", async () => {
    const bad = await h.queryAll<{ problem: string; n: number }>(`
      SELECT 'won and lost' AS problem, count(*)::int AS n FROM leads WHERE won_at IS NOT NULL AND lost_at IS NOT NULL
      UNION ALL SELECT 'reason without lost', count(*)::int FROM leads WHERE lost_reason_id IS NOT NULL AND lost_at IS NULL
      UNION ALL SELECT 'won stage without won_at', count(*)::int FROM leads l JOIN stages s ON s.id = l.stage_id
        WHERE s.kind = 'won' AND l.won_at IS NULL
      UNION ALL SELECT 'won_at outside a won stage', count(*)::int FROM leads l JOIN stages s ON s.id = l.stage_id
        WHERE s.kind <> 'won' AND l.won_at IS NOT NULL
      UNION ALL SELECT 'lost stage without lost_at', count(*)::int FROM leads l JOIN stages s ON s.id = l.stage_id
        WHERE s.kind = 'lost' AND l.lost_at IS NULL
      UNION ALL SELECT 'lost_at outside a lost stage', count(*)::int FROM leads l JOIN stages s ON s.id = l.stage_id
        WHERE s.kind <> 'lost' AND l.lost_at IS NOT NULL`);
    expect(bad.filter((b) => b.n > 0)).toEqual([]);
  });

  it("every win and loss has its move in the stage history, at that moment; every reopen leaves the lost stage", async () => {
    const bad = await h.queryAll<{ problem: string; n: number }>(`
      SELECT 'win without its move' AS problem, count(*)::int AS n FROM leads l WHERE l.won_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM lead_stage_history h JOIN stages s ON s.id = h.to_stage_id
                        WHERE h.lead_id = l.id AND s.kind = 'won' AND h.changed_at = l.won_at)
      UNION ALL SELECT 'loss without its move', count(*)::int FROM leads l WHERE l.lost_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM lead_stage_history h JOIN stages s ON s.id = h.to_stage_id
                        WHERE h.lead_id = l.id AND s.kind = 'lost' AND h.changed_at = l.lost_at)
      UNION ALL SELECT 'reopen not out of a lost stage', count(*)::int FROM activities a WHERE a.type = 'reopened'
        AND NOT EXISTS (SELECT 1 FROM lead_stage_history h JOIN stages s ON s.id = h.from_stage_id
                        WHERE h.lead_id = a.lead_id AND s.kind = 'lost' AND h.changed_at = a.occurred_at)`);
    expect(bad.filter((b) => b.n > 0)).toEqual([]);
  });
});

describe("the demo business's numbers add up", () => {
  it("every board answers every range for every kind of viewer, with no NaN, Infinity or undefined in it", async () => {
    const problems: string[] = [];
    for (const [who, c] of [
      ["admin", admin],
      ["rep", rep],
      ["team lead", lead],
      ["no money", plain],
    ] as const)
      for (const board of BOARDS)
        for (const range of RANGES) {
          if (board === "revenue" && who === "no money") continue;
          const r = await c.inject({ method: "GET", url: `/api/v1/analytics/${board}?range=${range}` });
          if (r.statusCode !== 200)
            problems.push(`${who} ${board} ${range} → ${r.statusCode} ${r.body.slice(0, 160)}`);
          else {
            const bad = wordsWithHoles(r.json());
            if (bad.length) problems.push(`${who} ${board} ${range}: ${bad.slice(0, 3).join(" | ")}`);
          }
        }
    expect(problems).toEqual([]);
  }, 240_000);

  for (const range of ["30d", "90d", "this_month", "last_month"])
    it(`the same count on every board that shows it — ${range}`, async () => {
      const [o, s, f, t, l, rv, tm] = await Promise.all(
        ["overview", "sources", "funnel", "team", "lost", "revenue", "timing"].map((b) =>
          get(admin, `${b}?range=${range}`),
        ),
      );
      const newLeads = tile(o!, "new_leads")!;
      expect(sum(s!.sources.map((x: Json) => x.leads)), "sources' leads").toBe(newLeads);
      expect(f!.arrived, "funnel arrived").toBe(newLeads);
      // Unowned arrivals aren't anyone's row on the team board.
      const unowned = (await get(admin, `overview?range=${range}&owner=none`)).tiles.find(
        (x: Tile) => x.id === "new_leads",
      ).value;
      expect(sum(t!.people.map((p: Json) => p.assigned)) + unowned, "team's assigned + unowned").toBe(
        newLeads,
      );
      const won = tile(o!, "won")!;
      expect(sum(s!.sources.map((x: Json) => x.won)), "sources' won").toBe(won);
      expect(sum(t!.people.map((p: Json) => p.won)), "team's won").toBe(won);
      expect(sum(rv!.byProduct.map((p: Json) => p.deals)), "packages' deals").toBe(won);
      const revenue = tile(o!, "revenue_won")!;
      expect(sum(s!.sources.map((x: Json) => x.revenue)), "sources' revenue").toBeCloseTo(revenue, 2);
      expect(rv!.total, "revenue total").toBeCloseTo(revenue, 2);
      expect(sum(rv!.byProduct.map((p: Json) => p.value)), "packages' revenue").toBeCloseTo(revenue, 2);
      const lost = tile(o!, "lost")!;
      expect(l!.total, "lost total").toBe(lost);
      expect(sum(l!.reasons.map((r: Json) => r.n)), "reasons").toBe(lost);
      // The flow starts from every loss in the range: those still lost, and those reopened since (none lost again here).
      expect(l!.wonBackFlow.lost, "won-back flow's lost").toBe(lost + l!.wonBackFlow.reopened);
      expect(tm!.meetings.kpis.held, "meetings held").toBe(tile(o!, "calls_held"));
      expect(tm!.meetings.kpis.booked, "meetings booked").toBe(tile(o!, "calls_booked"));
      expect(sum(tm!.meetings.people.map((p: Json) => p.held)), "held per person").toBe(
        tile(o!, "calls_held"),
      );
      // Each lead's furthest stage is counted once.
      expect(sum(f!.stages.map((x: Json) => x.stoppedN)), "funnel stopped").toBeLessThanOrEqual(newLeads);
      for (let i = 1; i < f!.stages.length; i++)
        expect(f!.stages[i].reached, `funnel reach ${i}`).toBeLessThanOrEqual(f!.stages[i - 1].reached);
      // Every arrival lands in one weekday-hour cell.
      expect(sum(tm!.arrivals.flat()), "timing arrivals").toBe(newLeads);
      // The funnel's snapshot of each stage now agrees with the forecast and velocity's open leads.
      expect(f!.now.openN, "open now").toBe(f!.velocity.openLeads);
    });

  it("every drill-down opens exactly its number", { timeout: 120_000 }, async () => {
    const o = await get(admin, "overview?range=90d");
    for (const id of ["new_leads", "won", "lost", "calls_held", "calls_booked"]) {
      const want = tile(o, id)!;
      if (id === "calls_held" || id === "calls_booked") {
        // A lead can have several calls: the list holds leads, at most as many as the calls.
        expect(await opens(admin, o.drill[id]), id).toBeLessThanOrEqual(want);
      } else expect(await opens(admin, o.drill[id]), id).toBe(want);
    }
    const s = await get(admin, "sources?range=90d");
    for (const x of s.sources) {
      expect(await opens(admin, x.drill.leads), `source ${x.name}`).toBe(x.leads);
      expect(await opens(admin, x.drill.won), `source won ${x.name}`).toBe(x.won);
    }
    const f = await get(admin, "funnel?range=90d");
    for (const x of f.stages) {
      expect(await opens(admin, x.drill.reached), `reached ${x.name}`).toBe(x.reached);
      expect(await opens(admin, x.drill.stopped), `stopped ${x.name}`).toBe(x.stoppedN);
    }
    for (const x of f.now.stages) expect(await opens(admin, x.drill), `now ${x.name}`).toBe(x.n);
    const l = await get(admin, "lost?range=90d");
    for (const x of l.reasons) expect(await opens(admin, x.drill), `reason ${x.name}`).toBe(x.n);
    for (const x of l.matrix.cells) expect(await opens(admin, x.drill), "lost cell").toBe(x.n);
    expect(await opens(admin, l.wonBackFlow.drill), "won-back flow").toBe(l.wonBackFlow.won);
    const rv = await get(admin, "revenue?range=90d");
    for (const x of rv.byProduct) expect(await opens(admin, x.drill), `package ${x.name}`).toBe(x.deals);
    const t = await get(admin, "team?range=90d");
    for (const p of t.people) {
      expect(await opens(admin, p.drill.cohort), `cohort ${p.name}`).toBe(p.assigned);
      expect(await opens(admin, p.drill.won), `won ${p.name}`).toBe(p.won);
    }
  });

  it("a rep's numbers are the admin's filtered to them; a team lead's are the admin's filtered to the team", async () => {
    for (const range of ["30d", "90d"]) {
      const mine = await get(rep, `overview?range=${range}`);
      const filtered = await get(admin, `overview?range=${range}&owner=${repUser.id}`);
      for (const t of mine.tiles as Tile[])
        expect([range, t.id, t.value]).toEqual([range, t.id, tile(filtered, t.id)]);
      const me = await get(rep, `me?range=${range}`);
      for (const t of me.tiles as Tile[])
        expect(["me", range, t.id, t.value]).toEqual(["me", range, t.id, tile(filtered, t.id)]);
      const team = await get(lead, `overview?range=${range}`);
      const byTeam = await get(admin, `overview?range=${range}&team=${teamId}`);
      for (const t of team.tiles as Tile[])
        expect(["team", range, t.id, t.value]).toEqual(["team", range, t.id, tile(byTeam, t.id)]);
      // And the team lead's team board lists exactly their team's people.
      const tb = await get(lead, `team?range=${range}`);
      for (const p of tb.people) expect(teamIds, p.name).toContain(p.id);
    }
  });

  it(
    "a filter every lead passes changes nothing on any board that reads live",
    { timeout: 120_000 },
    async () => {
      const [{ id: tag }] = (
        await h.ownerPool.query(
          "INSERT INTO tags (id, label) VALUES (gen_random_uuid(), 'everyone') RETURNING id",
        )
      ).rows as [{ id: string }];
      await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) SELECT id, $1 FROM leads", [tag]);
      for (const range of ["30d", "this_month"]) {
        const a = await get(admin, `overview?range=${range}`);
        const b = await get(admin, `overview?range=${range}&tag=${tag}`);
        for (const t of a.tiles as Tile[]) {
          // Speed to lead: rollups estimate it from a histogram; lateness: rollups round each day's minutes (rulings).
          if (t.id === "speed_to_lead") continue;
          if (t.id === "lateness" && t.value !== null)
            expect(Math.abs(tile(b, t.id)! - t.value), "lateness").toBeLessThan(1);
          else expect(["overview", range, t.id, tile(b, t.id)]).toEqual(["overview", range, t.id, t.value]);
        }
        const pick = {
          sources: (x: Json) => x.sources.map((s: Json) => [s.id, s.leads, s.won, s.revenue]),
          funnel: (x: Json) => x.stages.map((s: Json) => [s.id, s.reached, s.stoppedN]),
          lost: (x: Json) => [x.total, x.reasons.map((r: Json) => [r.id, r.n]), x.wonBackFlow.won],
          team: (x: Json) => x.people.map((p: Json) => [p.id, p.won, p.assigned, p.held]),
          revenue: (x: Json) => [x.total, x.byProduct.map((p: Json) => [p.id, p.deals, p.value])],
        } as const;
        for (const [board, f] of Object.entries(pick)) {
          const plainB = await get(admin, `${board}?range=${range}`);
          const liveB = await get(admin, `${board}?range=${range}&tag=${tag}`);
          expect([board, range, f(liveB)]).toEqual([board, range, f(plainB)]);
        }
      }
      // Every source, and the one pipeline: read from the leads, the heatmaps and time in stage equal their rollups.
      const every = (await h.queryAll<{ id: string }>("SELECT id FROM lead_sources"))
        .map((x) => x.id)
        .join(",");
      const [{ id: pipeline }] = (await h.queryAll<{ id: string }>("SELECT id FROM pipelines")) as [
        { id: string },
      ];
      expect(
        (await h.queryAll<{ n: number }>("SELECT count(*)::int AS n FROM leads WHERE source_id IS NULL"))[0]!
          .n,
      ).toBe(0);
      const heat = (x: Json) => [
        x.arrivals,
        x.replies,
        x.booking,
        x.stages.map((s: Json) => [s.id, s.exited, s.medianMinutes]),
      ];
      const plainT = await get(admin, "timing?range=90d");
      for (const f of [`source=${every}`, `pipeline=${pipeline}`]) {
        const t = await get(admin, `timing?range=90d&${f}`);
        expect([f, t.note ?? null]).toEqual([f, null]);
        expect([f, heat(t)]).toEqual([f, heat(plainT)]);
      }
      const stays = (x: Json) =>
        x.timeInStage.map((s: Json) => [s.id, s.exited, s.medianMinutes, s.p75Minutes]);
      expect(stays(await get(admin, `funnel?range=90d&source=${every}`))).toEqual(
        stays(await get(admin, "funnel?range=90d")),
      );
    },
  );

  it("each board's CSV holds the same numbers as the board", async () => {
    const s = await get(admin, "sources?range=30d");
    const csv = (await admin.inject({ method: "GET", url: "/api/v1/analytics/sources/csv?range=30d" })).body;
    const rows = csv
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n")
      .slice(1);
    expect(rows).toHaveLength(s.sources.length);
    for (const [i, x] of s.sources.entries()) {
      const cells = rows[i]!.split(",");
      expect(Number(cells[1]), x.name).toBe(x.leads);
      expect(Number(cells[4]), x.name).toBe(x.won);
    }
    const o = await get(admin, "overview?range=30d");
    const ocsv = (await admin.inject({ method: "GET", url: "/api/v1/analytics/overview/csv?range=30d" }))
      .body;
    expect(ocsv.trim().split("\r\n")).toHaveLength(o.tiles.length + 1);
  });

  it("LUME noticed speaks in finished sentences", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await get(admin, "insights?range=90d");
      for (const x of r.insights) {
        expect(x.title, x.id).toMatch(/^[A-Z"“‘0-9].+[^.\s]$/);
        expect(x.body, x.id).toMatch(/\.$/);
        expect(`${x.title} ${x.body}`, x.id).not.toMatch(/undefined|NaN|null|\{|\}/);
      }
    }
  });
});
