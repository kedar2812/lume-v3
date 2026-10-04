# Phase 8D-1: the demo business and the engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every number the approved Phase 8 canvas shows is computed by the API, proven against a reference, opens exactly its leads, filters by people, teams, sources, tags and fields, and is fast at 1,000,000 leads; plus a realistic made-up business to judge the screens with.

**Architecture:** The engine stays as 8A built it:
- dashboards read the daily rollups (0053/0055) under the viewer's analytics reach;
- drill-downs recompute leads by each metric's definition.

This plan does six things on top of it:
1. It **generalises drill tokens** to any number, not only Overview tiles.
2. It turns the drill definitions into **shared SQL fragments**. The live path, used when a tag or field filter is set, counts with the same definitions, so live and rollup numbers can't drift.
3. It **widens the filters** to many people, a team, many sources, tags and fields.
4. It **adds the missing module outputs**: revenue, segments, meetings, the funnel's split, snapshot, velocity and forecast by month, the team's leaderboard metrics, timing's working-hours window, quality, and the rep's view.
5. It **feeds the three idle detectors**.
6. It adds **"Open in Leads"**, **exports**, and the **demo seed**.

**Tech Stack:**
- Fastify 5 + zod (`fastify-type-provider-zod`);
- drizzle `sql` templates over pg;
- PostgreSQL 17 functions/RLS (migrations in `packages/db/migrations`);
- `@lume/core` (metrics, range, trend, detectors);
- vitest with the API harness (`apps/api/test/harness.ts`).

Tests run on the build host: `bash scripts/dev.sh run pnpm exec vitest run <paths>`, from the repo root. Lint is `bash scripts/dev.sh run pnpm lint`.

**Spec:** `docs/superpowers/specs/2026-10-04-phase-8d-analytics-to-canvas-design.md`. It builds on `docs/superpowers/specs/2026-10-04-phase-8-analytics-design.md`, whose §4 definitions and §6 detectors stand.

## Global Constraints

- **Generic product:** no client names, business names, funnel stages or currencies hardcoded (CLAUDE.md). Demo data is generic and fictional: names from a small generic list, emails `@example.com`, phones in fictional ranges.
- **Lead data never leaves the instance:** aggregate CSV carries numbers only, never contact details.
- **Every number follows the viewer's analytics scope** (`analytics.view` own/team/all). Money fields only appear with `analytics.revenue`.
- **Budget:** 300 ms for any dashboard request at 1,000,000 leads (`LUME_SCALE_ANALYTICS_BUDGET`, default 300).
- **Live filters (tag, field) are bounded to 92 days.** A longer range answers 400 `RANGE_TOO_LONG_FOR_FILTER` "Narrow the range to 92 days or less to use tags or fields". A module without a live path answers 400 `FILTER_NOT_SUPPORTED` "This board can't be filtered by tags or fields yet".
- **Too few:** a rate cell under its minimum (10 for rates, 5 for booking slots, 3 for the lost reason × source matrix, 10 for segment groups, 5 exits for time in stage) carries `tooFew: true`.
- **Copy:** speaks as LUME, never "we". Words are plain; dates read month-first ("October 1").
- **Migrations:** the next number is 0056. A migration never rewrites another's function body unless it must; it adds functions beside it.
- **Commits:** straight to `main`, each ending with the two attribution lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01NG9jLBej5VsSnVgR2sBN5y
  ```
  Check CI after every push (public GitHub API with curl).
- **Ledger:** `.superpowers/sdd/2026-10-04-phase-8d1-seed-and-engine/progress.md` gets one line per task, plus a `Ruling:` line for each decision and its cost if wrong.

## Review Focus

1. **A filter past one's reach:** a rep sending `owner=<someone else>` or `team=<a team they're not in>` must get 403 `OUTSIDE_REACH`, never an empty or partial answer. Pinned in Task 2.
2. **Live and rollup numbers must agree:** the same range with and without a no-op tag filter (a tag every lead carries) must give identical tiles. Pinned in Task 3.
3. **An expired drill token or someone else's token:** 410 and 404, the same as 8A, for every new drill kind. Pinned in Task 1.
4. **A deleted lead inside a range:** excluded from every new module and every new drill. Pinned in Task 5 (revenue) and Task 4 (funnel snapshot).
5. **A business in a timezone west of UTC:** the working-hours window and the outside strip use business time, not UTC (`America/New_York`). Pinned in Task 8.

---

### Task 1: Drill tokens for any number

Today `mintDrill` is called only for Overview tiles, and `DrillSpec.m` is a `MetricId`. Every new module number (a funnel stage, a source row, a lost reason, a heatmap cell, a product, a meeting outcome, a person's row) needs its own drill. This task turns the drill definitions into exported SQL fragments; Task 3 counts live with them.

**Files:**
- Modify: `apps/api/src/modules/analytics/drill.ts`
- Modify: `apps/api/src/modules/analytics/routes.ts` (overview minting uses the new helper)
- Test: `apps/api/src/modules/analytics/drill.test.ts` (new)

**Interfaces:**
- Produces:
  - `type DrillKind = MetricId | "funnel_reached" | "funnel_stopped" | "stage_now" | "stuck" | "source_leads" | "source_won" | "lost_reason" | "lost_stage" | "lost_cell" | "won_back" | "segment" | "product_won" | "slot" | "meeting_outcome" | "person_cohort" | "person_won" | "unowned" | "phone_needs_country" | "phone_invalid"`.
  - `type DrillExtra = { stageId?: string | null; sourceId?: string | null; reasonId?: string | null; productId?: string | null; userId?: string | null; field?: { key: string; value: string }; slot?: { kind: "arrivals" | "sends" | "replies" | "booked" | "held" | "no_show"; dow: number; hour: number }; outcome?: "completed" | "no_show" | "cancelled" | "rescheduled" | "scheduled"; wait?: "under_1h" | "under_1d" | "under_7d" | "over_7d" }`.
  - `DrillSpec` gains `k: DrillKind` (replacing `m`) and `x?: DrillExtra`. Its `q` becomes `Pick<AnalyticsQuery, "pipelineId" | "ownerIds" | "sourceIds" | "tagIds" | "fields">` (Task 2 defines those fields; until then, keep `ownerId`/`sourceId` and widen in Task 2).
  - `export function drillFor(d: Pick<AppDeps, "keyring">, req: FastifyRequest, range: Range, q: AnalyticsQuery, k: DrillKind, x: DrillExtra | undefined, now: Date): string`, which mints with the range's days and instants and the actor's id.
  - `export const frag` holds the shared SQL pieces used by drills and live counts (Task 3):
    - `cohort(spec)`, `won(spec)`, `lost(spec)`, `meeting(spec, cond)` and `filtersOf(spec)`, each returning `SQL` over the alias `l` (leads);
    - `COHORT_OWNER` and `credit(col, q)`.
  - The route `GET /api/v1/analytics/drilldown` answers `{ kind, total, items, nextCursor }`, with the name `kind` replacing `metric`. **The web client `apps/web/src/lib/analytics/client.ts` must be updated in this task** to read `kind`.

- [ ] **Step 1: Write the failing test** `apps/api/src/modules/analytics/drill.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";
const days = Array.from({ length: 30 }, (_, i) => `2026-06-${String(i + 1).padStart(2, "0")}`);
const at = async (id: string, cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  await h.queryAll(`UPDATE leads SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [
    id,
    ...Object.values(cols),
  ]);
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
  rep = await h.seedUser({ grants: [{ key: "analytics.view", scope: "own" }, { key: "leads.view", scope: "own" }] });
  const cfg = await h.config();
  const src = (
    await h.ownerPool.query(
      "INSERT INTO lead_sources (id, type, name) VALUES (gen_random_uuid(), 'manual', 'Fair') RETURNING id",
    )
  ).rows[0].id as string;
  const [reason] = await h.queryAll<{ id: string }>("SELECT id FROM lost_reasons ORDER BY position LIMIT 1");
  const lostStage = Object.entries(cfg.stages).find(([n]) => /lost/i.test(n))![1];
  for (let i = 0; i < 4; i++) {
    const id = await h.seedLead({ ownerId: rep.id });
    await at(id, { created_at: `2026-06-0${i + 1}T05:00:00Z`, source_id: src });
    if (i === 0) await at(id, { lost_at: "2026-06-10T05:00:00Z", lost_reason_id: reason!.id, stage_id: lostStage });
  }
  await rollupDays(h.pool, days, TZ);
});
afterAll(async () => h.close());

const open = async (u: SeededUser, token: string) =>
  (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(token)}` });

describe("drill tokens for any number (8D-1 Task 1)", () => {
  it("a source row and a lost reason open exactly the leads they count", async () => {
    const admin_ = await h.signIn(admin);
    const s = (await admin_.inject({ method: "GET", url: `/api/v1/analytics/sources?${Q}` })).json();
    const fair = s.sources.find((x: { name: string }) => x.name === "Fair");
    const r = (await open(admin, fair.drill.leads)).json();
    expect(r.kind).toBe("source_leads");
    expect(r.total).toBe(fair.leads);
    const l = (await admin_.inject({ method: "GET", url: `/api/v1/analytics/lost?${Q}` })).json();
    expect((await open(admin, l.reasons[0].drill)).json().total).toBe(l.reasons[0].n);
  });

  it("someone else's token is not found; an expired one is gone", async () => {
    const s = (await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/analytics/sources?${Q}` })).json();
    const token = s.sources[0].drill.leads;
    expect((await open(rep, token)).statusCode).toBe(404);
    h.clock.advance(16 * 60_000);
    expect((await open(admin, token)).statusCode).toBe(410);
  });
});
```

- [ ] **Step 2: Run it to see it fail.**
  Run: `bash scripts/dev.sh run pnpm exec vitest run apps/api/src/modules/analytics/drill.test.ts`
  Expected: FAIL, because `fair.drill` is undefined.

- [ ] **Step 3: Implement.** In `drill.ts`:
  1. Rename `m` to `k` and add `x` to `DrillSpec`.
  2. Move the per-kind SQL out of `drillIds` into an exported `frag` object, plus a `where(spec)` switch that returns the `SQL` for any `DrillKind`.
  3. Add the new kinds:

```ts
export function kindWhere(s: DrillSpec & { q: DrillSpec["q"] & { reach?: string | null } }): SQL | null {
  const [t0, t1] = s.t;
  const span = (col: SQL) => sql`${col} >= ${t0}::timestamptz AND ${col} < ${t1}::timestamptz`;
  const x = s.x ?? {};
  const eqOrNull = (col: SQL, v: string | null | undefined) => (v ? sql`${col} = ${v}::uuid` : sql`${col} IS NULL`);
  switch (s.k) {
    case "source_leads":
      return sql`${frag.cohort(s)} AND ${eqOrNull(sql`l.source_id`, x.sourceId)}`;
    case "source_won":
      return sql`${frag.won(s)} AND ${eqOrNull(sql`l.source_id`, x.sourceId)}`;
    case "lost_reason":
      return sql`${frag.lost(s)} AND ${eqOrNull(sql`l.lost_reason_id`, x.reasonId)}`;
    case "lost_cell":
      return sql`${frag.lost(s)} AND ${eqOrNull(sql`l.lost_reason_id`, x.reasonId)} AND ${eqOrNull(sql`l.source_id`, x.sourceId)}`;
    case "lost_stage":
      return sql`${frag.lost(s)} AND ${eqOrNull(sql`(SELECT h.from_stage_id FROM lead_stage_history h WHERE h.lead_id = l.id
        AND h.changed_at <= l.lost_at ORDER BY h.changed_at DESC, h.id DESC LIMIT 1)`, x.stageId)}`;
    case "won_back":
      return sql`${frag.won(s)} AND EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id AND a.type = 'reopened'
        AND a.occurred_at >= ${t0}::timestamptz AND a.occurred_at < l.won_at)`;
    case "product_won":
      return sql`${frag.won(s)} AND ${eqOrNull(sql`l.product_id`, x.productId)}`;
    case "person_cohort":
      return sql`${frag.cohort(s)} AND ${eqOrNull(frag.COHORT_OWNER, x.userId)}`;
    case "person_won":
      return sql`${frag.won(s)} AND ${eqOrNull(sql`lume_owner_at(l.id, l.won_at, l.owner_id)`, x.userId)}`;
    case "funnel_reached":
    case "funnel_stopped":
      // Task 4 adds the furthest-stage helper; until then these are refused.
      return null;
    case "stage_now":
      return sql`l.stage_id = ${x.stageId!}::uuid AND ${frag.credit(sql`l.owner_id`, s.q)}`;
    case "stuck":
      return sql`l.stage_id = ${x.stageId!}::uuid AND EXISTS (SELECT 1 FROM stages st WHERE st.id = l.stage_id
        AND st.sla_hours IS NOT NULL AND l.stage_entered_at < now() - make_interval(hours => st.sla_hours))
        AND ${frag.credit(sql`l.owner_id`, s.q)}`;
    case "slot":
      return frag.slot(s);
    case "meeting_outcome":
      return frag.meeting(s, sql`${span(sql`m.starts_at`)} AND m.status = ${x.outcome!}`);
    case "segment":
      return sql`${frag.cohort(s)} AND l.custom @> ${JSON.stringify({ [x.field!.key]: frag.fieldValue(x.field!.value) })}::jsonb`;
    case "unowned":
      return frag.unowned(x.wait!);
    case "phone_needs_country":
      return sql`l.phone_status = 'needs_country' AND ${frag.credit(sql`l.owner_id`, s.q)}`;
    case "phone_invalid":
      return sql`l.phone_status = 'invalid' AND ${frag.credit(sql`l.owner_id`, s.q)}`;
    default:
      return frag.metric(s); // the 8A tile definitions, unchanged
  }
}
```

  In `drillIds`, call `kindWhere`. A `null` answer is refused with 404 `DRILL_NOT_FOUND`.

  `frag.slot(s)` maps each slot kind to its rollup's definition, at the business time's `dow` and `hour` (`extract(dow FROM <col> AT TIME ZONE <tz>)`). The spec carries `tz`, added to `DrillSpec` as `z`:
  - `arrivals`: `l.created_at`;
  - `sends`: a `whatsapp_confirmed_sent` activity;
  - `replies`: the same, with a `reply_logged` within 72 h;
  - `booked`: meetings by `starts_at` with status in scheduled/completed/no_show;
  - `held`: completed;
  - `no_show`: no_show.

  `frag.fieldValue("true")` is `true`, `"false"` is `false`, and any other string is itself.

  `drillFor` builds the spec from `range` (`d: [range.days[0], range.days.at(-1)]`, `t: [from, to]`, `z: tz`) and the query filters.

  Each `sources` row also gains `kind`, which is `lead_sources.type` (manual, sheet, webhook, calendly…), for the canvas's source chip. A row with `id: null` has kind `manual`.

  In every module that now carries drills (Task 1 covers `sources` and `lost`; later tasks add their own), attach them:
  - `sources`: `drill: { leads: drillFor(..., "source_leads", { sourceId: id }), won: drillFor(..., "source_won", { sourceId: id }) }` on each row;
  - `lost`: `drill: drillFor(..., "lost_reason", { reasonId: r.id })` on each reason;
  - `lost.stages[*].drill`: kind `lost_stage`;
  - `lost.wonBack.drill`: kind `won_back`.

  Module functions take `d: Pick<AppDeps, "keyring">` as their first argument from now on (routes pass `d`).

- [ ] **Step 4: Run** `drill.test.ts`, `api.test.ts`, `modules.test.ts` and `fixture.test.ts`. Expected: PASS. The overview still mints `drill[tileId]`, now through `drillFor`.
- [ ] **Step 5: Update the web client.** In `apps/web/src/lib/analytics/client.ts` the drilldown type reads `kind` (it was `metric`). Run `bash scripts/dev.sh run pnpm exec vitest run apps/web/src/components/analytics`. Expected: PASS.
- [ ] **Step 6: Commit.** `feat(analytics): drill tokens for any number — sources, lost reasons and stages, won back (8D-1 Task 1)`.

---

### Task 2: Filters for many people, a team, many sources

The canvas Filters panel picks several people or a team, and several sources. The API takes one owner and one source. This widens every module: rollup filters use `= ANY`, and the reach check covers each person.

**Files:**
- Modify: `apps/api/src/modules/analytics/routes.ts` (query schema, `toQuery`, team expansion)
- Modify: `apps/api/src/modules/analytics/service.ts` (`AnalyticsQuery`, `reachOf`, `rollupWhere`, `liveOwner`, `liveLead`)
- Modify: `apps/api/src/modules/analytics/modules.ts` (`rw`, `credit`, `leadWhere`), `insights.ts`, `drill.ts`, `weekly.ts` (anything reading `ownerId`/`sourceId`)
- Modify: `apps/web/src/lib/analytics/client.ts` (`AnalyticsParams` gains `owners?: string[]`, `team?: string`, `sources?: string[]`; `query()` joins them with commas)
- Test: `apps/api/src/modules/analytics/filters.test.ts` (new)

**Interfaces:**
- Produces:
  - `AnalyticsQuery` loses `ownerId`/`sourceId` and gains `ownerIds?: string[]` (may include `"none"`), `sourceIds?: string[]`, `tagIds?: string[]` and `fields?: Record<string, string[]>`. The last two are used in Task 3.
  - Query string:
    - `owner=<uuid>[,<uuid>…]` (up to 50, or `none`);
    - `team=<uuid>`;
    - `source=<uuid>[,…]` (up to 20);
    - `tag=<uuid>[,…]` (up to 10);
    - `fields=<JSON {key: [values]}>` (up to 3 keys, 10 values each).
  - `team` resolves to its members' ids (`SELECT user_id FROM team_members WHERE team_id = $1`), intersected with any `owner` list. An unknown team is 404 `TEAM_NOT_FOUND`.
  - `reachOf(req, ownerIds?: string[])` refuses with 403 `OUTSIDE_REACH` if any id is past the viewer's reach.

- [ ] **Step 1: Write the failing test** `filters.test.ts`. Seed it like `drill.test.ts` (two reps in a team, one rep outside, one admin), then:

```ts
it("several people, a team and several sources narrow every number alike", async () => {
  const a = await h.signIn(admin);
  const both = (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&owner=${r1.id},${r2.id}` })).json();
  const team = (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&team=${teamId}` })).json();
  const n = (b: { tiles: { id: string; value: number }[] }) => b.tiles.find((t) => t.id === "new_leads")!.value;
  expect(n(both)).toBe(6); // r1 has 4, r2 has 2, r3 (outside the team) has 3
  expect(n(team)).toBe(6);
  const srcs = (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&source=${s1},${s2}` })).json();
  expect(n(srcs)).toBe(7);
});

it("a filter past one's reach is refused, never emptied", async () => {
  const me = await h.signIn(r1);
  for (const q of [`owner=${r1.id},${r3.id}`, `team=${otherTeam}`]) {
    const res = await me.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&${q}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("OUTSIDE_REACH");
  }
});

it("an unknown team is not found; a bad list is a 400", async () => {
  const a = await h.signIn(admin);
  expect((await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&team=${crypto.randomUUID()}` })).statusCode).toBe(404);
  expect((await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&owner=nope` })).statusCode).toBe(400);
});
```

- [ ] **Step 2: Run it to see it fail** (400: unknown `team`; the owner list doesn't parse).
- [ ] **Step 3: Implement.** The query schema:

```ts
const uuidList = (max: number) =>
  z.string().regex(new RegExp(`^${UUID}(,${UUID}){0,${max - 1}}$`, "i")).transform((s) => s.split(","));
// owner: a list of people, or "none" (leads nobody owns)
owner: z.union([z.literal("none").transform(() => ["none"]), uuidList(50)]).optional(),
team: z.uuid().optional(),
source: uuidList(20).optional(),
tag: uuidList(10).optional(),
fields: z.string().max(2000).optional(), // parsed in toQuery: { key: string[] }, ≤3 keys, ≤10 values, keys /^[a-z][a-z0-9_]{0,39}$/
```

  `toQuery` becomes `async (req, raw)`. It expands `team` and parses `fields`; a bad `fields` is 400 `BAD_FILTER`.

  SQL helpers:
  - `rollupWhere`: `user_id = ANY(${ids}::uuid[])`, with `"none"` mapped to `user_id IS NULL OR …`;
  - `source_id = ANY(...)`;
  - `liveOwner`, `credit`, `leadWhere` and the drill fragments change the same way.

  Every module, `insights` and `weekly` read the arrays. `weekly` passes none.
- [ ] **Step 4: Run** `filters.test.ts` plus the whole `apps/api/src/modules/analytics` folder. Expected: PASS.
- [ ] **Step 5: Run the web analytics tests.** Expected: PASS. `AnalyticsParams.owner` is kept as a single-person alias that maps to `owners: [id]`.
- [ ] **Step 6: Commit.** `feat(analytics): filter by several people, a team, several sources (8D-1 Task 2)`.

---

### Task 3: The live path for tags and fields, with the same definitions

A tag or field filter can't read rollups. This task:
- builds `liveFilter(q)` (lead set restrictions);
- adds the 92-day guard and the unsupported-module refusal;
- adds the live Overview, which counts with Task 1's `frag` definitions (shared with drills, which the fixture proves equal to the tiles).

**Files:**
- Create: `apps/api/src/modules/analytics/live.ts`
- Modify: `service.ts` (`overview` branches to `liveOverview` when `q.tagIds?.length || q.fields`), `routes.ts` (guard)
- Test: `apps/api/src/modules/analytics/live.test.ts` (new)

**Interfaces:**
- Consumes: `frag` (Task 1); `AnalyticsQuery.tagIds/fields` (Task 2).
- Produces:
  - `export const LIVE_MAX_DAYS = 92`;
  - `export function isLive(q: AnalyticsQuery): boolean`;
  - `export function liveFilter(q: AnalyticsQuery): SQL`, over alias `l`: tags as `EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id = l.id AND lt.tag_id = ANY(...))`; fields as `(l.custom @> {key: v1} OR l.custom @> {key: v2}) AND …` per key, with booleans as JSON true/false;
  - `export function guardLive(q, range, module: string): void`, which throws the two 400s;
  - `export async function liveOverview(req, q, range, tz): Promise<{ tiles: Tile[] }>`, giving the same tile ids and the same `Tile` shape as `overview`.

  Modules with a live path are overview, funnel, sources, lost, team, revenue and segments. The other modules call `guardLive(q, range, name)` first, so they refuse.

- [ ] **Step 1: Write the failing test** `live.test.ts`. Seed 12 leads in June (as `modules.test.ts` does), tag 5 of them "café", set `custom.budget` to "₹1–3 L" on 4, contact 6, win 2 (one worth 4,000), and add one task due and done late. Also tag ALL 12 with a second tag "everyone". Then:

```ts
it("a tag every lead carries changes nothing: live tiles equal rollup tiles", async () => {
  const a = await h.signIn(admin);
  const plain = (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}` })).json();
  const live = (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&tag=${everyone}` })).json();
  for (const t of plain.tiles) {
    const l = live.tiles.find((x: { id: string }) => x.id === t.id);
    expect(l.value, t.id).toBeCloseTo(t.value ?? NaN, 6);
  }
});

it("a tag and a field narrow to the leads that carry them", async () => {
  const a = await h.signIn(admin);
  const b = (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&tag=${cafe}` })).json();
  expect(b.tiles.find((t: { id: string }) => t.id === "new_leads").value).toBe(5);
  const f = encodeURIComponent(JSON.stringify({ budget: ["₹1–3 L"] }));
  const c = (await a.inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}&fields=${f}` })).json();
  expect(c.tiles.find((t: { id: string }) => t.id === "new_leads").value).toBe(4);
});

it("over 92 days, or on a board without a live path, a tag filter is refused in words", async () => {
  const a = await h.signIn(admin);
  const long = await a.inject({ method: "GET", url: `/api/v1/analytics/overview?range=custom&from=2026-01-01&to=2026-06-30&tag=${cafe}` });
  expect(long.statusCode).toBe(400);
  expect(long.json().code).toBe("RANGE_TOO_LONG_FOR_FILTER");
  const timing = await a.inject({ method: "GET", url: `/api/v1/analytics/timing?${Q}&tag=${cafe}` });
  expect(timing.json().code).toBe("FILTER_NOT_SUPPORTED");
});
```

- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement** `live.ts`. Each tile is one aggregate over `leads l` (or `meetings`/`tasks` joined to `leads l`) restricted by `${leadBase} AND ${liveFilter(q)}`, where `leadBase` is the deleted/pipeline/source filter. The current and previous ranges run in parallel.

```ts
const cohortSql = (s) => sql`SELECT count(*)::int AS arrived,
    count(*) FILTER (WHERE f.first_contact_at IS NOT NULL)::int AS contacted,
    count(*) FILTER (WHERE f.first_reply_at IS NOT NULL)::int AS replied,
    count(*) FILTER (WHERE l.won_at IS NOT NULL)::int AS won,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM f.first_contact_at -
      greatest(l.created_at, coalesce(lume_first_assigned(l.id), l.created_at))) / 60)
      FILTER (WHERE f.first_contact_at IS NOT NULL)::float8 AS speed
  FROM leads l LEFT JOIN lead_firsts f ON f.lead_id = l.id
  WHERE ${leadBase(q)} AND ${liveFilter(q)} AND ${frag.cohort(s)}`;
```

  Use the matching `frag` for won/lost/meetings/tasks/forecast (`overdue_now` and `forecast` take `liveFilter` too). Speed reads the exact median, not the histogram. **Ruling:** live speed to lead is the exact median while rollups give a histogram estimate, so the no-op test compares speed within the histogram bucket's width. Assert that with `quantileFromHist` of a one-bucket histogram rather than `toBeCloseTo`. Cost if wrong: a few minutes' difference on that one tile under a filter.

  In `overview`: `if (isLive(q)) { guardLive(q, range, "overview"); tiles = await liveOverview(...) }`. The series reads live too: `count(*) GROUP BY day` over the cohort, and won by day.
- [ ] **Step 4: Run** `live.test.ts`, `api.test.ts` and `fixture.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(analytics): tag and field filters, counted live by the drill definitions (8D-1 Task 3)`.

---

### Task 4: The funnel — split, the snapshot, time in stage, velocity, forecast by month

**Files:**
- Modify: `apps/api/src/modules/analytics/service.ts` (`funnel`)
- Create: `apps/api/src/modules/analytics/funnel-extra.ts` (snapshot, stays, velocity, forecast; keeps `service.ts` from growing past 600 lines)
- Create: `packages/db/migrations/0056_analytics_8d.sql` (this task adds `lume_furthest_stage`; Task 8 adds `no_show` slots to the same file)
- Test: `apps/api/src/modules/analytics/funnel.test.ts` (new)

**Interfaces:**
- Produces, in the `GET /analytics/funnel` response, extra fields:
  - `split?: { by: "source" | "owner"; groups: { id: string | null; name: string; arrived: number; stages: { id: string; share: number | null; reached: number }[] }[] }` (top 5 by arrived, plus `{ id: "other", name: "Everyone else" | "Other sources" }`), from query `split=source|owner`;
  - `now: { stages: { id: string; name: string; n: number; value: number | null; avgAgeDays: number | null; drill: string }[]; openValue: number | null; openN: number }`, with value fields only with `analytics.revenue`;
  - `timeInStage: { id: string; name: string; exited: number; medianMinutes: number | null; p75Minutes: number | null; slaHours: number | null; stuckNow: number; tooFew: boolean; drill: { stuck: string } }[]`, listing every open stage in order, including those with no exits;
  - `velocity: { openLeads: number; winRate: number | null; avgDeal: number | null; cycleDays: number | null; perDay: number | null; previousPerDay: number | null; trend: Trend | null } | null` (null without `analytics.revenue`);
  - `forecast: { months: { month: string /* YYYY-MM */; label: string; latest: number; second: number; earlier: number }[]; later: number; stageNames: [string, string] } | null` (null without revenue);
  - each `stages[i]` gains `drill: { reached: string; stopped: string }`.
- Produces SQL: `lume_furthest_stage(lead uuid, pipeline uuid) RETURNS uuid` in 0056. It returns the furthest stage (by position, with won last) from `lead_stage_history.to_stage_id` plus the current stage, ignoring lost stages. The `funnel_reached`/`funnel_stopped` drills use it.

- [ ] **Step 1: Write the failing test** `funnel.test.ts`. In June, seed 10 leads from source A and 5 from source B, owned by two people. Move 6 to stage 2 (history rows), 3 of those to stage 3, and win 2 (value 1,000 each; win probability set on stages: 10/40/70). Give one lead an SLA breach: stage 1 `sla_hours = 24`, `stage_entered_at = now() - 3 days`. Add one deleted lead in stage 3 with a value. Then assert:
  - `split=source`: group A's first stage share is 1 and its arrived is 10;
  - `now.stages` totals equal the open leads by stage, the deleted lead is not counted, and `openValue` equals Σ value of open leads;
  - `timeInStage` lists all three open stages in order, and the stage with no exits has `tooFew: true` and `medianMinutes: null`;
  - `stages[1].drill.reached` opens exactly `stages[1].reached` leads, and `stopped` opens `stoppedN`;
  - `velocity.perDay` equals `openLeads × winRate × avgDeal ÷ cycleDays`, computed in the test from the seeded numbers by the spec §4 formula (90-day cohort);
  - `forecast.months` sums to the forecast tile (Overview) within 0.01;
  - a viewer without `analytics.revenue` gets `velocity: null`, `forecast: null` and no `value` on `now.stages`.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Write migration 0056 (part 1):**

```sql
-- Phase 8D (spec 2026-10-04-phase-8d-analytics-to-canvas-design §4): the furthest stage a lead reached in a
-- pipeline, open stages by position and then won (a lost lead counts where it got to before it was lost).
CREATE FUNCTION lume_furthest_stage(lead uuid, pipeline uuid) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT s.id FROM stages s
  WHERE s.pipeline_id = pipeline AND s.kind IN ('open', 'won')
    AND s.id IN (SELECT h.to_stage_id FROM lead_stage_history h WHERE h.lead_id = lead
                 UNION SELECT l.stage_id FROM leads l WHERE l.id = lead)
  ORDER BY (s.kind = 'won') DESC, s.position DESC LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION lume_furthest_stage(uuid, uuid) TO lume_app;
```

- [ ] **Step 4: Implement** `funnel-extra.ts`:
  - **Split:** read `analytics_daily_reach` grouped by `source_id` or `user_id` and `stage_id`, and `analytics_daily_cohort` grouped the same way for `arrived`. Fold everything after the top 5 into "other". Live (tag/field) uses `lume_furthest_stage` over the cohort lead set.
  - **Snapshot:** `lead_counts_now` (0048) per stage, which gives counts and value. Average age is live: `avg(extract(epoch FROM now() - l.stage_entered_at)/86400)` per open stage over leads in reach, bounded by `liveOwner`. Each stage gets a `stage_now` drill.
  - **Time in stage:** the 8A timing query, left-joined from the pipeline's open stages so every stage appears. Add `sla_hours` and the `stuck` drill.
  - **Velocity:** the 90 days before `range.to`:
    - open leads (live count);
    - win rate = won ÷ (won + lost) over leads closed in the 90 days (event rollup sums of won and lost);
    - avg deal = won_value ÷ (won − won_no_value);
    - cycle = `cycleDays` over the 90 days.

    The previous value is the same over the 90 days before the range's previous `to`. `trend` uses kind `pct`, good `up`.
  - **Forecast by month (§4.2):**
    - For each open stage, the median days from entering it (history) to `won_at`, over leads won in the last 180 days that passed through it. With fewer than 10 wins, use the pipeline median cycle minus the median days spent before the stage.
    - A lead's expected date is `greatest(stage_entered_at + median, now())`. Bucket by business-time month: the next 3 months, then "later".
    - The two latest open stages by position are named; the rest are "Earlier stages".
    - Each lead contributes `value × win_probability / 100`.
  - Add `drill.reached`/`drill.stopped` to `stages` with kinds `funnel_reached`/`funnel_stopped`, and wire `kindWhere` for them in `drill.ts`:
    - `funnel_reached`: cohort leads whose furthest stage's position is ≥ this stage's (won counts as the highest);
    - `funnel_stopped`: furthest stage = this stage.
- [ ] **Step 5: Run** `funnel.test.ts`, `api.test.ts`, `fixture.test.ts` and `live.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit.** `feat(analytics): the funnel's split, the snapshot, time in every stage, velocity, forecast by month (8D-1 Task 4)`.

---

### Task 5: The revenue module

**Files:**
- Create: `apps/api/src/modules/analytics/revenue.ts`
- Modify: `routes.ts` (`GET /api/v1/analytics/revenue`, which needs `analytics.revenue` as well as `analytics.view`)
- Test: `apps/api/src/modules/analytics/revenue.test.ts` (new)

**Interfaces:**
- Produces: `GET /analytics/revenue?…` →

```ts
{
  range: { label: string; days: string[] },
  thisMonth: { days: string[]; cumulative: number[]; goal: number | null; paceEnd: number | null; today: string },
  byMonth: { month: string; label: string; value: number; goal: number | null }[], // 12, oldest first
  byProduct: { id: string | null; name: string; deals: number; value: number; share: number | null; drill: string }[],
  fact: { product: string; dealShare: number; revenueShare: number } | null,
  total: number, previousTotal: number | null, trend: Trend | null, drill: string
}
```

  The rules:
  - `thisMonth` is the business's current month to today, independent of the range (canvas "This month").
  - `paceEnd = value so far ÷ elapsed share of the month`, `null` before 20% of the month has passed (so it isn't wild).
  - `fact` appears only when the top product by revenue has `revenueShare ≥ dealShare + 0.1` and at least 10 deals.
  - Product names: `products.name`. A null product is "Won without a package".
- Consumes: `drillFor` (Task 1); goals via `goals.ts` (`listGoals` shape: metric `revenue`, business scope).

- [ ] **Step 1: Write the failing test** `revenue.test.ts`. Seed 3 products, then wins across the last 3 months (fixed `h.clock.now` = `2026-06-15T06:00:00Z`): 4 in April, 6 in May and 5 in June so far. Values vary; one is null; one is deleted (it must not count). Set a business revenue goal for June. Assert:
  - `byMonth` has 12 entries, ending at June, with May's value equal to the seeded May sum;
  - `thisMonth.cumulative.at(-1)` equals June so far, and `paceEnd` equals June so far ÷ (15/30);
  - the `byProduct` shares sum to 1, the null-product row reads "Won without a package", and each product's drill opens its `deals` count;
  - the deleted lead's value appears nowhere;
  - without `analytics.revenue`, the route is 403.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement.**
  - **By month and this month:** from `analytics_daily_event.won_value` grouped by month and day. Business days are already the rollup's `day`, so `to_char(day, 'YYYY-MM')`.
  - **By product:** live, as `leads l` won in range by `l.product_id`, with `frag.won` credit and `liveFilter`. **Ruling:** live is fine because it reads only won leads in the range. Cost if wrong: a slower module at extreme win volume. The 1M gate measures it in Task 15.
  - **Goals:** `SELECT target FROM goals WHERE scope='business' AND metric='revenue' AND period='month' AND period_start = <month start>`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(analytics): revenue — this month against the goal, by month, by package (8D-1 Task 5)`.

---

### Task 6: Lost — the reason × source matrix, the won-back flow, what converts

**Files:**
- Modify: `apps/api/src/modules/analytics/modules.ts` (`lost`)
- Create: `apps/api/src/modules/analytics/segments.ts`
- Modify: `routes.ts` (`GET /api/v1/analytics/segments?field=<key>`)
- Test: `apps/api/src/modules/analytics/lost.test.ts` (new)

**Interfaces:**
- Produces, in `lost`:
  - `matrix: { reasons: { id: string | null; name: string }[]; sources: { id: string | null; name: string }[]; cells: { reasonId: string | null; sourceId: string | null; n: number; tooFew: boolean; drill: string }[] }` (top 6 reasons × top 5 sources; under 3 is too few);
  - `wonBackFlow: { lost: number; reopened: number; won: number; value?: number; previousValue?: number; trend: Trend | null; drill: string }`.

  `lost` = lost in range; `reopened` = of those, a `reopened` activity after `lost_at`; `won` = of the reopened, won in range. Note this differs from the 8A `wonBack` count (won in range after a reopen in range); both stay. The canvas flow reads `lost → reopened → won`.
- Produces: `GET /analytics/segments?field=<key>&…` → `{ field: { key, label, type }; groups: { value: string; label: string; arrived: number; won: number; rate: number | null; tooFew: boolean; drill: string }[]; fields: { key: string; label: string; type: string }[] }`. Fields are select, multi_select or boolean custom fields that aren't archived. The cohort is live, bounded to 92 days (`guardLive` always applies here, tag or not). A multi-select counts a lead in each value it holds.
- An unknown or unsuitable field is 400 `BAD_FIELD` "Choose a choice, multiple-choice or yes/no field".

- [ ] **Step 1: Write the failing test** `lost.test.ts`:
  - 8 leads lost in June across 2 reasons and 2 sources, with one cell under 3: assert the cells, `tooFew` on that cell, and that each cell's drill opens `n`;
  - won-back flow: 3 of the lost are reopened (`reopened` activity) and 1 of those is won in June with value 500. Assert `{ lost: 8, reopened: 3, won: 1, value: 500 }`;
  - segments: a select field `budget` with options "Under ₹1 L" and "₹1–3 L". Of 12 June arrivals, 6 under (2 won) and 6 at 1–3 (3 won). Assert the rates 1/3 and 1/2, `tooFew: true` for both (n < 10), and each drill opens `arrived`;
  - a 120-day range on segments gives 400 `RANGE_TOO_LONG_FOR_FILTER`; `field=name` gives 400 `BAD_FIELD`.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement.** The matrix is one live `GROUP BY lost_reason_id, source_id` over lost-in-range leads with credit at `lost_at`. The flow uses `count(*) FILTER (...)` over lost-in-range leads. Segments: `SELECT v, count(*), count(*) FILTER (WHERE won_at IS NOT NULL)` from a cohort lateral over `jsonb_array_elements_text` for multi-select, `->> key` for select, and `(custom->key)::boolean` for boolean. Use the field's `options` for labels and order, with "Not answered" for null.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(analytics): lost by reason and source, the won-back flow, what converts by any field (8D-1 Task 6)`.

---

### Task 7: Team — leaderboard metrics with each person's move, discipline, the full table

**Files:**
- Modify: `apps/api/src/modules/analytics/service.ts` (`team`)
- Test: `apps/api/src/modules/analytics/team.test.ts` (new)

**Interfaces:**
- Produces, in `team` (same route), each person row gaining:
  - `assigned` (new leads credited);
  - `within1h` (share contacted within an hour);
  - `replyRate`;
  - `held` (calls held);
  - `previousRank: { won: number | null; revenue: number | null; speed: number | null; ontime: number | null; replies: number | null }` (1-based ranks over the previous period, null when not ranked then);
  - `goal: { metric: "won" | "revenue"; target: number; value: number } | null` (from the person's month goal, if any);
  - `drill: { cohort: string; won: string }`.

  Top level gains `discipline: { ontime: number | null; previousOntime: number | null; trend: Trend | null; overdueNow: number; people: { id: string; ontime: number | null; overdueNow: number }[] }`.
- Ranking rules (for the screen's sorting animation):
  - **won:** desc;
  - **revenue:** desc, only with `analytics.revenue`;
  - **speed:** asc median, null last;
  - **ontime:** desc, null last;
  - **replies:** desc reply rate, null last.
  - Ties break by name.

- [ ] **Step 1: Write the failing test** `team.test.ts`. Seed 3 people with known June and May numbers (May's order differs from June's on Won). Assert:
  - June won order;
  - `previousRank.won` equals each person's May rank;
  - `within1h` and `replyRate` per person equal hand-computed shares;
  - `held` counts completed meetings per person;
  - `goal` appears for the person with a June goal;
  - the `discipline` totals equal the overview's `ontime` tile;
  - a rep with own scope gets `leaderboard: false` and only their own row.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement.** Read the same rollups for the previous period and rank in JS. `held` comes from the event rollup's `held` per `user_id`. `replyRate` = cohort replied ÷ contacted per user. `within1h` = cohort `within_1h` ÷ contacted. Goals come from a `goals` row with `scope = 'user'`, the month containing `range.to`, and metric won (or revenue if no won goal).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(analytics): the team's leaderboard metrics with each person's move, follow-up discipline, the full table (8D-1 Task 7)`.

---

### Task 8: Timing — the working-hours window and meetings

**Files:**
- Modify: `packages/db/migrations/0056_analytics_8d.sql` (part 2: `no_show` slots)
- Modify: `apps/api/src/modules/analytics/rollup.ts` (call `lume_rollup_noshow_day` between the day and the totals)
- Modify: `apps/api/src/modules/analytics/modules.ts` (`timing`)
- Modify: `apps/api/test/scale/scale.test.ts` (it calls the SQL functions directly: add the new call)
- Test: `apps/api/src/modules/analytics/timing.test.ts` (new)

**Interfaces:**
- Produces SQL (0056, part 2):

```sql
ALTER TABLE analytics_daily_slot DROP CONSTRAINT analytics_daily_slot_kind_check;
ALTER TABLE analytics_daily_slot ADD CONSTRAINT analytics_daily_slot_kind_check
  CHECK (kind IN ('arrivals', 'sends', 'replies', 'booked', 'held', 'no_show'));
-- No-shows by the meeting's start slot (8D: slot_noshow and the meetings board). Run after lume_rollup_day (which
-- clears the day's slots) and before lume_rollup_slot_totals.
CREATE FUNCTION lume_rollup_noshow_day(d date, tz text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
DECLARE t0 timestamptz := (d::timestamp AT TIME ZONE tz); t1 timestamptz := ((d + 1)::timestamp AT TIME ZONE tz);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lume.analytics.day'), d - DATE '2000-01-01');
  DELETE FROM analytics_daily_slot WHERE day = d AND kind = 'no_show';
  INSERT INTO analytics_daily_slot
  SELECT d, 'no_show', extract(dow FROM m.starts_at AT TIME ZONE tz)::smallint,
         extract(hour FROM m.starts_at AT TIME ZONE tz)::smallint, m.owner_id, count(*)::int
  FROM meetings m JOIN leads l ON l.id = m.lead_id AND l.deleted_at IS NULL
  WHERE m.starts_at >= t0 AND m.starts_at < t1 AND m.status = 'no_show'
  GROUP BY 1, 2, 3, 4, 5;
END $$;
REVOKE ALL ON FUNCTION lume_rollup_noshow_day(date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_rollup_noshow_day(date, text) TO lume_app;
```

  (If `lume_rollup_day` reads meetings under a calendar sweep setting, the new function sets the same `set_config` as `lume_rollup_day` does at its start and end. Copy those two lines from 0053.)
- Produces, in the `timing` response:
  - `window: { startHour: 7; endHour: 22 }`;
  - `arrivals`, `replies` and `booking` keep their 7×24 grids (the screen slices them) **plus** `outside: { arrivals: number; sends: number; replies: number; booked: number; held: number }`, the totals before 07:00 or from 22:00;
  - `best: { arrivals?: { dow; hour; n }; replies?: { dow; hour; rate; n }; booking?: { dow; hour; rate; n } }`, only when the cell meets its minimum;
  - each grid cell gains `drill`, minted only for cells with n > 0, kind `slot`;
  - `meetings`:
    - `kpis: { booked; held; heldRate; noShowRate; cancelled; previous: {…same} }`;
    - `flow: { booked; held; noShow; cancelled; rescheduled; upcoming }`;
    - `people: { id; name; held; noShow; cancelled }[]`;
    - `drill: { held; no_show; cancelled }`.

  The meetings counts are live over meetings in range (by `starts_at`, `created_at` for booked) with `credit(m.owner_id)`.

  **Ruling:** the window is fixed at 07:00–21:59 (15 hours, the canvas's 7×15), not taken from working hours. Working hours vary by day and would make the grid ragged. Cost if wrong: a business with night shifts sees most of its activity in the outside strip; the strip says so in numbers.

- [ ] **Step 1: Write the failing test** `timing.test.ts`:
  - business timezone `America/New_York`; a lead arriving `2026-06-02T03:30:00Z` (23:30 on June 1 in New York) lands in `outside.arrivals` on Monday June 1;
  - a lead at `2026-06-02T13:00:00Z` (09:00) lands in Tuesday's 9 o'clock cell;
  - 6 completed meetings Friday at 15:00 and 1 no-show: `booking` Friday 15 has rate 6/7 and `best.booking` points to it;
  - a `no_show` slot row exists after `rollupDays`;
  - the meetings `kpis`, `flow` and `people` equal the seeded numbers, and each drill opens its count.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Write 0056 part 2.** Call it from `rollupDays` (after `lume_rollup_day`) and from `scale.test.ts`'s direct loop.
- [ ] **Step 4: Implement** the timing additions.
- [ ] **Step 5: Run** `timing.test.ts`, `rollup.test.ts` and `modules.test.ts`. Expected: PASS.
- [ ] **Step 6: Commit.** `feat(analytics): timing in a working-hours window with the hours outside it, meetings, no-shows by slot (8D-1 Task 8)`.

---

### Task 9: Quality — readable share, duplicates merged, four waits, drills

**Files:**
- Modify: `apps/api/src/modules/analytics/modules.ts` (`quality`)
- Test: extend `modules.test.ts` (a new `describe("quality, 8D")`)

**Interfaces:**
- Produces, in `quality`:
  - `phones: { total: number; readable: number; readableShare: number | null; needsCountry: number; invalid: number; drill: { needsCountry: string; invalid: string } }`. `total` counts leads with a phone (status not `missing`); `readable` counts `valid`.
  - `duplicatesMerged: number`, the audit entries `lead.merge` in range, at all scope only (0 otherwise).
  - `unowned: { under1h; under1d; under7d; over7d; drill: Record<"under_1h" | "under_1d" | "under_7d" | "over_7d", string> }`.
  - `imports: { sourceId; name; rows: number; rejected: number }[]`.
  - The 8A fields `phoneNeedsCountry`, `phoneInvalid` and `importsRejected` stay for the current screen until 8D-2.
- [ ] **Step 1: Write the failing test.** Seed:
  - leads with phone statuses valid ×7, needs_country ×2, invalid ×1, missing ×3;
  - two `lead.merge` audit rows in June;
  - unowned leads created 30 min, 5 h, 3 days and 10 days ago (`h.clock.now` fixed);
  - one import with rows 20, errors 3, skipped 1.

  Assert:
  - `phones` is `{ total: 10, readable: 7, readableShare: 0.7 }`;
  - `duplicatesMerged` is 2 for the admin and 0 for a rep;
  - each wait bucket holds 1;
  - `imports[0]` is `{ rows: 20, rejected: 4 }`;
  - each drill opens its count.
- [ ] **Step 2: Run** it to see it fail. **Step 3: Implement** it (check the merge audit action name in `apps/api/src/modules/leads/merge*.ts`; if it differs, use the one written and record a Ruling). **Step 4: Run** it to see it pass.
- [ ] **Step 5: Commit.** `feat(analytics): data quality — readable numbers, duplicates merged, how long unowned leads wait (8D-1 Task 9)`.

---

### Task 10: The rep's own view, `/analytics/me`

**Files:**
- Create: `apps/api/src/modules/analytics/me.ts`
- Modify: `routes.ts`
- Test: `apps/api/src/modules/analytics/me.test.ts` (new)

**Interfaces:**
- Produces: `GET /api/v1/analytics/me?range…` (needs `analytics.view` at any scope; always the viewer's own numbers, ignoring `owner`/`team`) →

```ts
{
  range, heroLine: string, // e.g. "Your October so far: 9 won, 2 days to the end of the week"
  goals: { metric: "won" | "revenue" | "calls_held" | "new_leads" | "ontime"; target: number; value: number; pace: number | null }[],
  tiles: Tile[], // new_leads, contacted, reply_rate, speed_to_lead, calls_held, won, win_rate, ontime (+ revenue_won with analytics.revenue)
  followUps: { dueNow: number; ontime: number | null; next: { leadId: string; leadName: string; title: string; dueAt: string }[] }, // next 5 open, soonest first
  funnel: { stages: { id; name; share: number | null }[]; myWinRate: number | null; businessWinRate: number | null },
  replyDays: { dow: number; sends: number; rate: number | null; tooFew: boolean }[] // 7, Monday first
}
```

  `businessWinRate` is shown only when the business has ≥ 50 cohort leads in range. It's read with a SECURITY DEFINER SQL function so a rep doesn't need the 'all' scope:

```sql
-- 0056 part 3: the business's win rate for a range, a single number that names nobody (8D spec §4).
CREATE FUNCTION lume_business_win_rate(d0 date, d1 date) RETURNS TABLE (arrived int, won int)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(arrived), 0)::int, coalesce(sum(won), 0)::int FROM analytics_daily_cohort WHERE day BETWEEN d0 AND d1
$$;
REVOKE ALL ON FUNCTION lume_business_win_rate(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lume_business_win_rate(date, date) TO lume_app;
```

- [ ] **Step 1: Write the failing test** `me.test.ts`:
  - a rep with own scope, 20 leads of their own and 40 of others in June;
  - the rep's `tiles` equal the admin's overview with `owner=<rep>`;
  - `businessWinRate` equals all 60 leads' rate;
  - with only 30 leads in the business, it's `null`;
  - `owner=<other>` on `/me` is ignored (still own numbers);
  - `followUps.next` lists the rep's 5 soonest open tasks;
  - `replyDays` is Monday first.
- [ ] **Step 2: Run** it to see it fail. **Step 3: Implement** it, reusing `overview` with `ownerIds: [me]` for tiles and `funnel` for stages. **Step 4: Run** it to see it pass.
- [ ] **Step 5: Commit.** `feat(analytics): a rep's own numbers, goals, follow-ups, funnel and best reply days (8D-1 Task 10)`.

---

### Task 11: Feed the three idle detectors

`goal_pace`, `slot_noshow` and `evening_arrivals` exist in `@lume/core` with tests, but `insights.ts` never fills `ctx.goal`, `ctx.slots` or `ctx.arrivals`.

**Files:**
- Modify: `apps/api/src/modules/analytics/insights.ts`
- Test: `apps/api/src/modules/analytics/insights-fed.test.ts` (new)

**Interfaces:**
- Consumes:
  - `InsightContext.goal` (`{ month, metricWords, value, target, elapsed, daysLeft, shown }`);
  - `InsightContext.slots` (2-hour windows: `{ day, hour, booked, noShow }`);
  - `InsightContext.arrivals` (`{ total, afterHours, after, contactBefore?, evidence }`).

  Read the exact field types in `packages/core/src/analytics/insights.ts` before writing.
- Produces: none new; three more detectors can speak.

- [ ] **Step 1: Write the failing test.** On a business with 220 leads in the last 30 days (so insights are ready):
  1. A revenue goal for the month, 50% of the month gone, at 30% of the goal: `goal_pace` speaks with "At this pace, {Month} ends at 60% of the revenue goal".
  2. 25 meetings booked Mondays 09:00–11:00 with 10 no-shows, and 100 elsewhere with 5: `slot_noshow` speaks.
  3. 90 of 220 leads arriving after 18:00 (working hours 09:00–18:00): `evening_arrivals` speaks with "41% of leads arrive after hours" and "They come in after 6 pm."

  Each uses its own harness and asserts the insight is among those returned (ranking may push others out: query with a fresh user so cooldowns are empty).
- [ ] **Step 2: Run** it to see it fail.
- [ ] **Step 3: Implement.** In `insights.ts`:
  - **goal:** the business goal for the current month (prefer metric revenue with money, else won). `elapsed` = days gone ÷ days in month. `value` from the event rollup for the month so far.
  - **slots:** booked and no_show from `analytics_daily_slot` (kinds `booked`, `no_show`) in 2-hour windows for the range.
  - **arrivals:** `total` and `afterHours` from arrivals slots. "After hours" is outside the business's working hours on its working days, where days not worked count as after hours.

    Read `settings.working_hours` (`{ days: number[], start: "HH:MM", end: "HH:MM" }`); empty means `DEFAULT_WORKING_HOURS` from `@lume/core`. `after` is the end time in words ("6 pm").

    `evidence` is true only when the speed_pays inputs show the fast-contact group wins ≥ 1.5× (reuse the same numbers). Then `contactBefore` is the start time plus one hour in words.
- [ ] **Step 4: Run** it to see it pass. Also run `packages/core/src/analytics/insights.test.ts`.
- [ ] **Step 5: Commit.** `feat(analytics): goals, no-show slots and after-hours arrivals feed LUME noticed (8D-1 Task 11)`.

---

### Task 12: Open in Leads, the drill export, and aggregate CSV

**Files:**
- Modify: `apps/api/src/modules/leads/routes.ts` (`listQuery` gains `drill`; GET `/leads` and `/leads/counts` resolve it)
- Modify: `apps/api/src/modules/lead-exports/service.ts` (`makeExport` resolves `filters.drill`)
- Create: `apps/api/src/modules/analytics/csv.ts`
- Modify: `apps/api/src/modules/analytics/routes.ts` (`GET /api/v1/analytics/:module/csv`)
- Modify: `apps/web/src/lib/settings/audit.ts` (words for `analytics.export`)
- Test: `apps/api/src/modules/analytics/open.test.ts` (new)

**Interfaces:**
- Produces:
  - `export async function resolveDrill(req, keyring, now, token): Promise<string[]>`, in `drill.ts`: `readDrill`, then `drillIds`.
  - Leads list: `?drill=<token>` intersects `ids`. An expired token is 410 `DRILL_EXPIRED`, and the Leads screen (8D-2) shows "This list from Analytics has expired. Open the number again.".
  - Export: `filters.drill` is resolved the same way before `readView`, so the export is traced (6B code, check row), audited as `lead.export`, and limited like any export.
  - `GET /analytics/:module/csv?…` (modules overview, funnel, team, sources, revenue, lost, timing, templates, quality; needs `leads.export`) returns `text/csv; charset=utf-8` with `content-disposition: attachment; filename="lume-<module>-<from>-<to>.csv"`. It carries rows of numbers and labels only (people's names and source names are labels; no lead names, phones or emails). Cells starting with `= + - @` are prefixed with `'` (the formula-safe rule from L-A's export). It's audited as `analytics.export` with `{ module, from, to }`.
- [ ] **Step 1: Write the failing test** `open.test.ts`:
  - `GET /leads?drill=<new_leads token>` lists exactly the tile's leads;
  - the same for a rep's token on the rep's own leads;
  - an export with `filters: { drill }` makes a file whose row count equals the tile;
  - `GET /analytics/sources/csv` gives 200 with a header row and one row per source, containing no email or phone pattern (`/@|\+\d{6,}/` absent);
  - a person without `leads.export` gets 403;
  - an `analytics.export` audit row exists.
- [ ] **Step 2: Run** it to see it fail. **Step 3: Implement** it. The CSV builder in `csv.ts` flattens each module's response by a per-module column list (header labels in plain words). Formula-safety: prefix `'`. **Step 4: Run** it to see it pass, along with `apps/api/src/modules/lead-exports`.
- [ ] **Step 5: Commit.** `feat(analytics): open any number in Leads, export its leads, and export a board's numbers (8D-1 Task 12)`.

---

### Task 13: The fixture's references for the new numbers

Spec §2.2: each new metric has a reference calculation in the fixture, and the engine matches it.

**Files:**
- Modify: `apps/api/test/fixtures/analytics.ts`:
  - **script:** add `product: number | null` (won leads: `i % 3`), `meetings` (for `i % 5 === 0`: one meeting at arrival + 2 days 15:00 IST, status by `i % 4`: completed, no_show, cancelled, scheduled) and `reopened: Date | null` (for lost leads with `i % 14 === 3`: reopened 2 days after lost, then won 3 days later with value 700);
  - **seedFixture:** insert products, meetings, `reopened` activities and the follow-on wins;
  - **reference:** add `revenueByProduct`, `meetingsFlow`, `wonBackFlow`, `funnelSplitBySource` (first stage share per source) and `lostMatrix`.
- Modify: `apps/api/src/modules/analytics/fixture.test.ts` (compare them, for all and for one person, in both ranges)

- [ ] **Step 1: Extend the reference first** (pure functions over `script()`). Write the comparisons in `fixture.test.ts`; they fail, because `seedFixture` doesn't write the new rows yet.
- [ ] **Step 2: Run** it to see it fail.
- [ ] **Step 3: Extend `seedFixture`.**
- [ ] **Step 4: Run** `fixture.test.ts`. Expected: PASS. Every existing comparison still matches, since new wins only add to May/June, and the reference includes them.
- [ ] **Step 5: Commit.** `test(analytics): the fixture's independent answers for revenue by package, meetings, won back, the funnel split and the lost matrix (8D-1 Task 13)`.

---

### Task 14: The demo business seed

**Files:**
- Create: `apps/api/src/demo/seed.ts`, `apps/api/src/demo/names.ts` (generic first and last names; sources, products and lost reasons by role words)
- Test: `apps/api/src/demo/seed.test.ts`

**Interfaces:**
- Produces:
  - `export class DemoSeedRefused extends Error`;
  - `export async function seedDemoBusiness(pool: pg.Pool, o: { now: Date; seed?: number; months?: number; demoMode?: boolean; keyring?: Keyring }): Promise<{ people: { id: string; name: string; email: string }[]; leads: number }>`.

  `pool` must connect as a role that owns the tables (the migration owner, or the test superuser). Writes run in one transaction with `set_config('lume.lead_scope', 'all', true)`, like the 0012/0047 migrations.

  Behaviour:
  1. **Refuse:** if `SELECT count(*) FROM leads` > 0 and not `o.demoMode`, throw `DemoSeedRefused("This LUME already has leads. The demo business only goes into an empty one.")`. Refusal changes nothing.
  2. **Business:**
     - `settings` name "Brightpath Studio", timezone `Asia/Kolkata` (only if unset); keep the existing currency.
     - Working hours Mon–Sat 10:00–19:00.
     - 8 people (status active, a random unusable password hash from `crypto.randomBytes`; emails `<first>.<last>@example.com`), split into teams "Inbound" (5) and "Field" (3). Each gets the "Sales" role if one exists, else none (they still count in analytics).
  3. **Catalogue:**
     - 5 sources: Instagram ads (manual, spend ₹1,80,000), Website form, Referrals, Webinars (spend ₹45,000), Walk-in;
     - 3 products: Starter ₹25,000, Growth ₹40,000, Premium ₹90,000;
     - the default pipeline's stages, as they are (never renamed);
     - lost reasons as they are;
     - 3 tags ("café", "wedding", "repeat client");
     - 1 select field `budget` if none with that key exists ("Under ₹1 L", "₹1–3 L", "Over ₹3 L").
  4. **Leads:** about 3,000 over `months` (default 6) ending at `now`, from a seeded PRNG (mulberry32 on `seed`, default 7):
     - **Arrivals:** a weekly rhythm (Sundays at 40%), an evening peak (35% after 19:00), 6% monthly growth, and one slow month (the third, at 70%).
     - **Contacts:** 85% contacted. Median 35 min, but 25% after 19:00 wait to the next morning. The person "Leo" is slow, with a median of 3 h.
     - **Replies:** 45% of contacted.
     - **Moves:** through the open stages by probability (history rows with times).
     - **Wins:** 5.5% overall. Leads contacted within 1 h win 2× as often (speed_pays). Referrals win 3× (source_over). Webinars win at 40% of the rest (source_under, with spend set).
     - **Losses:** 30%, with reasons weighted ("No reply" the largest and rising in the last month).
     - **Meetings:** 18% of leads, Friday afternoons held best; Mondays 09:00–11:00 have 30% no-shows.
     - **Follow-ups:** 70% of contacted leads. On time 88%, but "Leo"'s Mondays are late (weekday_late).
     - **Sends:** WhatsApp sends with template versions, if templates exist; otherwise skip sends.
     - **Win-backs:** 12, reopened then won.
     - **Other:** won leads get a product and value (product default ± 20%); 4% of phones need a country; 15 unowned leads with various waits.
     - **Goals:** the current month's business revenue (110% of last month) and each person's won goal.
  5. **Rollups:** for every day from the first arrival to `now`, via `rollupDays`.

  All times are computed from `now`, so the business always ends today.

- [ ] **Step 1: Write the failing test** `seed.test.ts`:
  - deterministic: seed twice into two harnesses with the same `now`/`seed` and compare `SELECT count(*), sum(value)`, the first 10 lead names and the June overview tiles;
  - it refuses a database with one lead, and nothing else is written (the people count is unchanged);
  - after seeding, `GET /analytics/insights` as an admin returns `ready: true` and at least 3 insights, including `speed_pays` and one of `source_over`/`source_under` (sound evidence the planted patterns are real);
  - every email ends `@example.com`;
  - the overview `new_leads` for the last 30 days is between 400 and 700.
- [ ] **Step 2: Run** it to see it fail. **Step 3: Implement** it with set-based inserts (`INSERT … SELECT FROM unnest($1::uuid[], …)`), in batches of 1,000. **Step 4: Run** it to see it pass. It must finish under 60 s on the build host; record the time in the ledger.
- [ ] **Step 5: Commit.** `feat(demo): a made-up business with six months of natural data, for reviews and the demo (8D-1 Task 14)`.

---

### Task 15: The 1M gate, docs, review

**Files:**
- Modify: `apps/api/test/scale/scale.test.ts`:
  - **data:** products on won leads; meetings for 5% of leads in the last 100 days, with statuses;
  - **timing list:** add `revenue`, `segments` (with a select field), `me` (rep), `quality`, `templates`, and `funnel?split=source`;
  - **live filters:** add `overview?tag=<tag>` at 30 days.
- Modify: `docs/runbooks/performance.md` (the new rows)
- Modify: `docs/runbooks/acceptance.md` (an 8D-1 section: how to seed the demo business into a fresh dev DB and what to check)

- [ ] **Step 1: Extend the scale test.**
- [ ] **Step 2: Run the gate.**
  1. `bash scripts/dev.sh test-db scale-up`
  2. `bash scripts/dev.sh run bash -c 'LUME_SCALE=1000000 pnpm exec vitest run apps/api/test/scale'`

  Expected: every `analytics …` path ≤ 300 ms. A path over budget gets fixed (an index or a rollup) before moving on, with a Ruling line. Then run `bash scripts/dev.sh test-db scale-down`.
- [ ] **Step 3: Run the full suite, lint and typecheck:**

  ```bash
  bash scripts/dev.sh run bash -c 'pnpm lint; echo LINT=$?; pnpm typecheck; echo TC=$?; pnpm test 2>&1 | tail -5'
  ```

  All must pass.
- [ ] **Step 4: Fresh reviewer.** Dispatch one fresh opus reviewer (superpowers:requesting-code-review) over the 8D-1 commits, with the spec, this plan and the Review Focus. Fix every Important finding with a test (one fix pass). Record the minors in the ledger.
- [ ] **Step 5: Docs and ledger.** Update `performance.md` and `acceptance.md`. Close the ledger with `Final review: …`.
- [ ] **Step 6: Commit and push.** `docs(8D-1): scale figures, acceptance; review fixes`. Check CI.
