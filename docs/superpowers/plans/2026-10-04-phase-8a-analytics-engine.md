# Phase 8A: Analytics data and engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every number on the approved analytics canvas has one exact definition, computed in the business timezone, scoped to the viewer, fast at a million leads, and opening the exact leads behind it.

**Architecture:**
- Two new lead columns (first contact, first reply) are kept by a trigger on `activities`.
- Rollup tables are kept in business-timezone days and refreshed by the API's queue. They carry row-level security keyed to the viewer's *analytics* scope.
- A metric catalogue in `@lume/core` declares every metric once. The API, the drill-downs, the weekly email (8B) and the screens (8C) all read it.
- Drill-downs are signed tokens resolved through the leads list, so row-level security and masking apply as on the Leads screen.

**Tech Stack:** Postgres 17 (RLS, triggers, `date_trunc` with `AT TIME ZONE`), Fastify, Drizzle and raw SQL, pg-boss, Vitest with the API harness.

**Spec:** `docs/superpowers/specs/2026-10-04-phase-8-analytics-design.md` (§3, §4, §5.1, §5.2, §7). Canvas: https://claude.ai/artifact/6X1u5VivMqy438qemCsPRH.

## Global Constraints

- Every number is computed in `settings.timezone` (the business's), never the server's or the viewer's.
- Deleted leads (`deleted_at IS NOT NULL`) are excluded from every number and drill-down.
- Scope comes from `analytics.view` (own / team / all), not `leads.view`. Revenue fields need `analytics.revenue`; without it they are absent from the response (not zero).
- Credit:
  - won and revenue go to the owner at the moment of winning (`lead_assignment_history`);
  - cohort metrics go to the owner at arrival, else the first owner.
- The trend rule is the owner's, exactly (spec §2), and lives in `packages/core/src/analytics/trend.ts`.
- Budget: any dashboard request ≤ 300 ms at 1,000,000 leads (scale test, dev box limits recorded).
- Made-up data only in fixtures (generic names, `example.com`); no client names.
- Lead data never leaves the server. Aggregates only in anything mailed (8B).

## Review Focus

1. **A rep can't read past their analytics scope**, even with a crafted filter (`owner=someone else`) or a forged or expired drill token. That covers the rollups' RLS, the live queries and token verification. (Task 4 and Task 6 tests.)
2. **Timezone day edges:** a lead at 23:30 IST belongs to that IST day; a DST zone (America/New_York) gives 23- and 25-hour days without double counting. (Task 3 and Task 7 tests.)
3. **Rollups equal live computation** for the same range and filters, after late events (a contact or win arriving days later moves the cohort day). (Task 5 test.)
4. **Every tile's drill-down returns exactly as many leads as the tile counts**, for admin and rep. (Task 7 test.)
5. **A re-run of a day's rollup is idempotent** and safe alongside a concurrent run (an advisory lock per day). (Task 5 test.)

---

### Task 1: First contact, first reply, and "Log a call" (migration 0051)

**Files:**
- `packages/db/migrations/0051_first_contact.sql`;
- schema `leads.firstContactAt`, `leads.firstReplyAt`;
- `apps/api/src/modules/leads/calls.ts` (+ route `POST /api/v1/leads/:id/calls`);
- `apps/api/src/modules/leads/calls.test.ts`;
- `packages/core` activity type `call_logged` (wherever activity types are enumerated).

**What it does:**
- **Columns:** `ALTER TABLE leads ADD first_contact_at timestamptz, ADD first_reply_at timestamptz`.
- **Trigger** `lume_first_touch()`: `AFTER INSERT ON activities FOR EACH ROW` (SECURITY DEFINER, `search_path` fixed).
  - When the type is `whatsapp_opened`, `call_logged` or `meeting_booked`: `UPDATE leads SET first_contact_at = NEW.created_at WHERE id = NEW.lead_id AND (first_contact_at IS NULL OR first_contact_at > NEW.created_at)`.
  - `reply_logged` does the same for `first_reply_at`.
  - The trigger must not bump `version` or `updated_at`. It updates only those columns, and the leads update trigger is checked so it ignores updates touching only them.
- **Backfill** in the migration: `UPDATE leads l SET first_contact_at = a.t FROM (SELECT lead_id, min(created_at) t FROM activities WHERE type IN (...) GROUP BY lead_id) a WHERE a.lead_id = l.id;` and the same for replies.
- **Indexes:**
  - `leads (first_contact_at) WHERE deleted_at IS NULL`;
  - `leads (lead_created_at)` if it doesn't already exist (check 0046).
- **`call_logged`:**
  - Body `{ outcome: 'talked' | 'no_answer' | 'left_message', note?: string ≤ 2000 }`.
  - Needs `leads.edit` on the record (as `reply_logged` does). Writes the activity with `payload.outcome`.
  - Rate-limited with the lead activity limiter.

**Tests (TDD, write first):**
- an inserted `whatsapp_opened` sets `first_contact_at`, a later one doesn't move it, and an earlier backdated one does;
- `reply_logged` sets `first_reply_at`;
- the lead's `version` and `updated_at` are unchanged by the trigger;
- `POST /calls` writes `call_logged` and sets first contact; a rep can't log on a lead they can't edit (404/403 as the edit routes do);
- the backfill: a fixture with old activities, then migrate, gives the right columns (run the migration's backfill SQL in the test against seeded rows).

**Commit:** `feat(analytics): first contact and first reply on every lead; log a call (8A Task 1, 0051)`

### Task 2: Spend, goals, insight cooldowns (migration 0052)

**Files:**
- `packages/db/migrations/0052_goals_spend.sql`;
- schema `goals.ts`;
- `lead_sources.monthlySpend`.

**What it does:**
- `ALTER TABLE lead_sources ADD monthly_spend numeric(14,2) CHECK (monthly_spend >= 0)`.
- **`goals`:**
  - columns: `id uuid pk`, `scope text CHECK IN ('user','team','business')`, `scope_id uuid NULL` (null for business), `metric text CHECK IN ('won','revenue','calls_held','new_leads','ontime')`, `period text CHECK IN ('month','quarter')`, `period_start date`, `target numeric(14,2) CHECK > 0`, `created_by`, `created_at`, `updated_at`;
  - unique on `(scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'), metric, period, period_start)`;
  - grants: SELECT, INSERT, UPDATE, DELETE to `lume_app`;
  - no RLS: the API checks `settings.manage` to write and scope to read.
- **`analytics_insight_seen`** `(user_id, detector, subject, magnitude numeric, shown_at)`: pk `(user_id, detector, subject)`; grants to `lume_app`.
- The API routes for these are 8B. This task only lands the tables and the schema, so 0053 can follow in order.

**Tests:**
- the constraints: a duplicate goal is refused by the unique index, a negative target and an unknown metric are refused (insert as owner in the test);
- `lume_worker` can't read `goals`.

**Commit:** `feat(analytics): sources spend, goals and insight cooldown tables (8A Task 2, 0052)`

### Task 3: The catalogue, ranges and the trend rule (core)

**Files:**
- `packages/core/src/analytics/trend.ts` (+ test);
- `packages/core/src/analytics/range.ts` (+ test);
- `packages/core/src/analytics/metrics.ts` (+ test);
- `packages/core/src/analytics/hist.ts` (+ test);
- export them all from `shared.ts`.

**Interfaces (produced):**
- `trend(now: number, before: number, o?: { kind?: 'pct'|'pts'|'abs'; good?: 'up'|'down'; vs?: string; places?: number; format?: (n: number) => string }): { dir: 'up'|'down'|'flat'; tone: 'good'|'bad'|'flat'; text: string }`.
  - Copied from `apps/licence/src/lib/trend.ts` with its tests. The licence app keeps its own copy, since it is a separate product.
- `resolveRange(preset: 'today'|'yesterday'|'7d'|'30d'|'this_month'|'last_month'|'this_quarter'|'custom', tz: string, now: Date, custom?: { from: string; to: string }): { from: Date; to: Date; days: string[]; previous: { from: Date; to: Date }; label: string }`:
  - `from` and `to` are UTC instants of business-day boundaries, and `to` is exclusive;
  - `days` are `YYYY-MM-DD` business days;
  - the previous period is the same length immediately before. For "this month so far" it is the same day numbers of the previous month (spec §4.3);
  - `label` uses the owner's date words ("October 1 – 3").
- `METRICS: Record<MetricId, MetricDef>`, where `MetricDef = { id; words; basis: 'cohort'|'event'|'now'; unit: 'count'|'pct'|'money'|'duration'|'days'; trendKind: 'pct'|'pts'|'abs'; good: 'up'|'down'; revenue: boolean; drill: DrillKind | null; info: string }`.
  - Every metric in spec §4 is in it. `info` is the tooltip sentence stating the basis ("Counts leads that arrived in the range…").
- `SPEED_BUCKETS: number[]` (12 log-spaced minute edges: 5, 15, 30, 60, 120, 240, 480, 1440, 2880, 4320, 10080, ∞) and `quantileFromHist(counts: number[], edges: number[], q: number): number | null` (linear within a bucket).

**Tests:**
- trend: every case in the licence tests, plus pts and abs;
- range:
  - Asia/Kolkata: "today" at 2026-10-04T20:00Z is Oct 5 IST;
  - this_month on Oct 3 → previous Sep 1–3;
  - America/New_York across the Nov 1 DST end gives a 25-hour day;
  - custom from > to is refused;
- metrics: every id has words, info and a basis; every non-`now` metric has a drill except `velocity`; revenue metrics are flagged;
- hist: the median of a known histogram, and null for an empty one.

**Commit:** `feat(analytics): the metric catalogue, business-time ranges and the trend rule in core (8A Task 3)`

### Task 4: Rollup tables with analytics scope (migration 0053)

**Files:**
- `packages/db/migrations/0053_analytics_rollups.sql`;
- schema `analytics.ts`;
- `apps/api/src/db/context.ts` (set `lume.analytics_scope`).

**What it does:**
- **`lume_analytics_scope()`** reads `current_setting('lume.analytics_scope', true)`. `lume_sees_credit(u uuid)` mirrors `lume_sees_owner`, but on the analytics scope; null credit (unassigned) is visible to 'all' only.
- **`context.ts`** sets `lume.analytics_scope` from the actor's `analytics.view` scope (null when absent), alongside `lume.lead_scope`.
- **Tables** (all `ENABLE ROW LEVEL SECURITY` with `FOR SELECT USING (lume_sees_credit(user_id))`, a backup read policy, and SELECT to `lume_app`; writes only through SECURITY DEFINER functions):
  - `analytics_daily_cohort(day date, user_id uuid, source_id uuid, pipeline_id uuid, arrived int, contacted int, replied int, won int, contact_minutes_sum bigint, within_1h int, within_24h int, speed_hist int[12])`;
  - `analytics_daily_event(day, user_id, source_id, pipeline_id, won int, won_value numeric, won_no_value int, lost int, booked int, held int, no_show int, cancelled int, tasks_due int, tasks_on_time int, late_minutes_sum bigint, late_count int, sends int, replies72 int)`;
  - `analytics_daily_stage(day, pipeline_id, stage_id, user_id, entered int, exited int, stay_hist int[12], stay_minutes_sum bigint)`;
  - `analytics_daily_slot(day, kind text CHECK IN ('arrivals','sends','replies','booked','held'), dow smallint, hour smallint, user_id, n int)`.
  - Each has a unique index on its key, with `coalesce` for null user and source.
- **`lume_rollup_day(d date, tz text)`** (SECURITY DEFINER):
  - takes `pg_advisory_xact_lock(hashtext('analytics:'||d))`;
  - deletes the day's rows in all four tables and re-inserts them from the live tables, using the spec §4 definitions:
    - cohort credit: the owner at arrival = the first `lead_assignment_history` row at or after arrival, else `leads.owner_id`;
    - won credit: the owner at `won_at` = the last assignment at or before `won_at`, else the current owner.

**Tests:**
- as a rep (own), only rows credited to them are readable; team sees the team; all sees everything, including null credit;
- a rep with `leads.view` 'all' but `analytics.view` 'own' sees only their own rollups (the scopes are separate);
- `lume_app` can't INSERT into a rollup table directly.

**Commit:** `feat(analytics): rollup tables, kept in business days, read under the viewer's analytics scope (8A Task 4, 0053)`

### Task 5: Rollup jobs

**Files:**
- `apps/api/src/modules/analytics/rollup.ts` (+ test);
- `QUEUE_NAMES 'analytics.rollup'`;
- schedule in the existing task tick.

**What it does:**
- `rollupDays(pool, days: string[], tz)` calls `lume_rollup_day` for each day as the owner role (as the lead-count rollup does).
- **The tick:**
  - every 10 minutes: today and yesterday;
  - at 02:30 business time: the last 7 days;
  - Sundays at 03:00: days 8–90 (cohorts move as contacts and wins arrive late);
  - a missed run is caught up on start (the last 2 days).

**Tests:**
- **Idempotent:** run a day twice and the rows are equal;
- **Late events:** a contact logged 3 days after arrival moves the cohort day's `contacted` after that day is recomputed;
- **Rollup equals live:** for the fixture (Task 7), every rollup total equals the live query for the same day and filters;
- **Concurrency:** two concurrent runs of one day leave one copy (the advisory lock).

**Commit:** `feat(analytics): rollups every 10 minutes, nightly for the week, weekly for 90 days (8A Task 5)`

### Task 6: The analytics API and drill-down tokens

**Files:**
- `apps/api/src/modules/analytics/{routes,service,live,drill}.ts` (+ tests).

**Interfaces:**
- `GET /api/v1/analytics/:module?range=&from=&to=&compare=1&pipeline=&owner=&team=&source=&tag=&field.<key>=` returns:
  - `{ range: { label, from, to, previous }, tiles: Tile[], series, groups, drill: Record<string, string> }`;
  - `Tile = { id: MetricId; value: number | null; previous: number | null; trend: Trend | null; display: string; note?: string; tooFew?: boolean }`.
- Modules: `overview`, `funnel`, `team`, `revenue`, `sources`, `lost`, `segments`, `timing`, `meetings`, `templates`, `quality`. Each reads rollups for filters they carry, and `live.ts` for tag and custom-field filters (range ≤ 92 days, else 422 `RANGE_TOO_LONG` "Narrow the range to 92 days or less to use that filter.").
- `GET /api/v1/analytics/drilldown/:token?cursor` verifies the HMAC (key from the keyring, purpose `analytics-drill`), the expiry (15 min) and that the token's user is the requester. It then runs the leads list with the token's filter plus `ids from the metric's definition`, returning the Leads page shape.
- Permissions:
  - `analytics.view` required;
  - an `owner`/`team` filter outside the viewer's scope is refused 403 (not silently emptied);
  - revenue fields are dropped without `analytics.revenue`.
- `overview`, `funnel` and `team` are built first with their full tests, then the rest. Every module's numbers come from the catalogue definitions.

**Tests:**
- a rep's overview equals the admin's overview filtered to that rep;
- a forged token, an expired token, and a token minted for someone else are each refused;
- a revenue-less viewer gets no `revenue_won` tile;
- a tag filter over 92 days is refused in words;
- compare off gives null trends.

**Commit:** `feat(analytics): the analytics API — overview, funnel, team and the rest; signed drill-downs (8A Task 6)`

### Task 7: The fixture and the hand-computed answers; the scale gate

**Files:**
- `apps/api/test/fixtures/analytics.ts`;
- `apps/api/src/modules/analytics/fixture.test.ts`;
- `apps/api/test/scale/scale.test.ts` (an analytics block);
- `docs/runbooks/performance.md` (an analytics section).

**What it does:**
- **The fixture** (spec §7): 6 people, 4 sources and 6 stages, about 400 leads over 8 weeks in Asia/Kolkata, every event at a fixed instant. The expectations are a table in the test file (metric × range × viewer → value), hand-computed from the script, with a comment showing each sum.
- **Assertions:**
  - every overview, funnel and team tile matches;
  - drill-down counts equal tile counts;
  - rep = admin filtered to the rep;
  - rollup = live;
  - a 23:30 IST lead falls on its IST day;
  - a New York copy over the DST change matches its own table.
- **Scale:** at 1M leads with rollups built, `overview`, `funnel` and `team` for 30 days and for 90 days each take ≤ 300 ms (median of 5), printed `SCALE|analytics …|ms`. The runbook records them.

**Commit:** `test(analytics): a fully known business, hand-computed answers, and the 1M-lead gate (8A Task 7)`
