# Phase 7 — LUME at scale: the backend (design)

**Status:** backend design. The owner asked for backend work while travelling ("do backend work for now"). He'll
review designs later, so screens are out of scope here: every feature below ships API-first, with no UI. The
owner reviews this document on his return; the API shapes can still change then.

## Why

The owner (2026-10-03): "lume has to have a strong backend, on an average a business will handle thousands of
leads daily and bulk actions and easy usability have to be the main selling point of lume, make sure you build it
to perfection."

He chose the **Large** target for one client server:

- up to **5,000 new leads a day**, **1–2 million leads held**, **50 people working at once**;
- **bulk actions on 50,000 leads at a time**, with progress and undo;
- **lists and filters answer in under 300 ms**.

## What LUME does today, measured

`apps/api/test/scale/scale.test.ts` seeds made-up leads in batches into a disk-backed Postgres (1 CPU, 1 GB, the
dev box's limits), then times each path through the real API code (median of 5).

The table shows 200,000 leads: one tenth of the target.

| Path | ms | | Path | ms |
|---|---|---|---|---|
| List: newest, updated, oldest, page 2 | 8–15 | | Stage counts, admin | 1,600 |
| Filter: stage, owner, unassigned | 7–10 | | Stage counts, rep (own leads) | 5,089 |
| Sort by name | 1,612 | | Stage counts, team lead | 7,102 |
| Filter by tag | 1,474 | | Rep's search | 5,265 |
| Search (name, phone, email, no match) | 1,562–1,779 | | Bulk assign / stage / tag, 100 leads | 215–458 |
| Export 25,000 (owner filter) | 262 | | | |

Seven paths miss the target by 5–25× at a tenth of the size, and grow with it.

### Causes (from `EXPLAIN ANALYZE` at 200,000)

1. **Row-level security is evaluated per row through a function that can't be inlined.**
   - `leads_read` calls `lume_can_see_owner(owner_id)`. Its `SET search_path` clause stops Postgres from inlining
     it, and makes every call save and restore a setting.
   - A sequential scan of 200,000 leads touches only 6,110 buffers, which should take milliseconds, but takes
     1.4 s in that function alone.
   - It also hides the owner from the planner, so a rep's or team lead's query can't use the owner index: their
     counts and searches scan every lead in the business.
2. **Search can't use its trigram indexes.** The list asks for the newest 50, so for a rare term (or no match) the
   planner walks the primary key backwards through every lead.
3. **Sort by name has no index**: `ORDER BY lower(name), id` sorts the whole table each time.
4. **The tag filter forces a hidden full scan.** `lead_tags`' own row-level security (an `EXISTS` on `leads`) is
   planned as a hashed subplan over every lead.
5. **Stage counts aggregate every visible lead** on each load.
6. **Bulk runs one lead at a time inside one request**: a savepoint and the full write path each, about 3.5 ms a
   lead. Capped at 100 ids, so "all 3,412 matching" can't be done; 50,000 would take about 3 minutes in one HTTP
   request, with no progress, cancel or undo.

## Design

Two parts: **7A, read paths**, then **7B, bulk actions at scale**. Each part's work is proven by the scale test
(see **The gate** below).

### 7A — Read paths

1. **Row-level security, rewritten to the same rules.** One migration recreates `leads_read`, `leads_create`
   and `leads_update` with the visibility rule inline:
   - each request setting is read through a scalar subquery: `(SELECT lume_scope())`, `(SELECT lume_user())`,
     `(SELECT lume_team_members())`, `(SELECT lume_handoff_lead())`. Postgres evaluates each once per query
     (an InitPlan), not once per row.
   - The meaning doesn't change: `'all'` sees every lead; own sees `owner_id = user` (never unassigned); team sees
     `owner_id = ANY(team)`, and only with a user set; a hand-off sees its one lead; no scope sees nothing (fails
     closed).
   - `lume_can_see_owner` stays (other code may call it) but no policy uses it.
   - The RLS test suite (`packages/db` and API) runs unchanged, and gains a test for each scope's rows.
2. **The scope as a plannable filter.** `leadFilters` adds the actor's own scope as an ordinary condition:
   `owner_id = me` for own, `owner_id = ANY(team)` for team. This is redundant with row-level security, but it
   lets the planner pick the owner index. Row-level security still enforces it.
3. **Indexes.** One migration, built with the app stopped as every migration is, listed in the changelog:
   - `(lower(name), id) WHERE deleted_at IS NULL`, for sort by name;
   - `(owner_id, id DESC) WHERE deleted_at IS NULL`, for "my leads, newest first";
   - `(pipeline_id, stage_id) INCLUDE (owner_id, value) WHERE deleted_at IS NULL`, so counts read the index,
     not the table;
   - for tags, see 4.
4. **Tags on the lead.** A `tag_ids uuid[]` column on `leads`, kept in step with `lead_tags` by a trigger, with a
   GIN index:
   - the tag filter becomes `tag_ids @> ARRAY[tag]`, which needs no join and no second row-level-security check;
   - serialising a page reads it directly, with no tags query;
   - `lead_tags` stays the source of truth (history, imports, and every existing writer go through it);
   - the migration backfills it.
5. **Search through its indexes.**
   - The search runs as a candidate step: a `MATERIALIZED` CTE of matching ids, built from bitmap scans of the
     trigram indexes (name, email, Instagram, phone digits).
   - The visible, filtered, ordered page is cut from that, with a cap on candidates (10,000). Past the cap, the
     list says the search matched more than LUME shows and asks for a narrower term.
   - Terms shorter than 2 characters don't search (one letter matches everything).
6. **Counts.** With 1–3 in place, counts read the covering index, scanning only the person's own slice for own and
   team scopes. If the scale test still misses the budget at 1,000,000, LUME adds a per-(stage, owner) count
   table kept by trigger, for unfiltered counts only. Measure first; never build it blind.

### 7B — Bulk actions at scale

**Selection.** A bulk action names either:
- the leads picked, by id; or
- **everything matching a filter**: the Leads list's own filters, minus any leads unticked, plus the count the
  person saw (`expected`).

The selection is read **as the person**: their row-level security and their `leads.bulk_edit` scope. It's then
snapshotted into the run, so it can't drift while it runs. Up to **50,000** leads; more is refused with "Narrow
the selection: up to 50,000 leads at a time."

**Runs.** Every bulk action becomes a run (`bulk_runs`, with one row per lead in `bulk_run_items` holding that
lead's before-values):

- up to 500 leads run inside the request and answer at once, as today;
- more is queued (pg-boss, inside the API as imports are, one run at a time per instance) and processed in chunks
  of 500. Each chunk is its own transaction, as the person, through `withJobRequest`;
- assign, tags, delete and set-phone-country are set-based within a chunk: the eligible leads are updated in one
  statement, and history and activities are inserted in bulk;
- stage moves keep the per-lead path (stage history, won/lost stamps and the stage's automations), and stay
  correct over speed;
- each lead is still checked on its own (scope, `leads.bulk_edit`, the action's permission); a lead the person may
  not touch is skipped with its reason, never failing the run.

**Progress, cancel, done.**
- `GET /api/v1/leads/bulk-runs/:id` gives the status (queued, running, done, cancelled, failed, undone) and the
  counts: total, done, skipped (with reasons), failed.
- `POST …/cancel` stops after the current chunk; the chunks already done stay done and can be undone.
- When a queued run finishes, the person gets a notification ("LUME moved 12,408 leads to Contacted. 12 were
  skipped.").
- `GET /api/v1/leads/bulk-runs` lists the person's runs from the last 7 days.

**Undo.** `POST …/undo`, within 24 hours, by the person who ran it (or an admin with `leads.bulk_edit` at 'all'),
is itself a run:
- each lead goes back to its before-value only if it hasn't changed since (its version is still the one the run
  left), and otherwise it's skipped as "changed since";
- undoing a delete restores the lead;
- side effects outside the lead aren't reversed: a stage's automations already ran, and messages already went.
  The undo result says how many leads it restored and how many had changed.

**Audit.** One `lead.bulk` entry per run, giving the action, the selection (ids or the filter in words) and the
counts, and one per undo. The per-lead history tables (assignment, stage) are written as they are for single
edits.

**Compatibility.** `POST /api/v1/leads/bulk` (up to 100 ids) keeps its request and response, and becomes a run
underneath, so it's undoable too.

**Retention.** Run items are deleted after 30 days. The run row and its audit entry stay.

## The gate

`scale.test.ts` becomes Phase 7's standing proof:

- it seeds 200,000 leads on the dev box's scale database (`dev.sh test-db scale-up`; never the test database's
  small tmpfs) and **asserts budgets**: every list, filter, search and count path at most **150 ms** at 200,000;
- a 50,000-lead bulk assign finishes, is cancelled midway correctly, and undoes;
- CI can't run it (minutes of seeding), so it's run by hand for each 7A/7B task and recorded in the ledger;
- the 300 ms target at 2,000,000 is checked once on the owner's production-sized server when one exists. The dev
  box is a client's live machine and stays capped at 1 CPU / 1 GB for this work.

## Not in this phase

- **Screens:** "select all matching", the progress HUD, the Undo toast, the runs list. They wait for the owner's
  design review.
- A search engine (Elasticsearch and the like): Postgres trigram is enough for this target.
- Concurrency testing with 50 simultaneous people: it needs a separate server, not the client's box.
- Intake throughput beyond today's: 5,000 a day is one lead every 17 s on average, which the current intake path
  handles; a burst test is a follow-up.

## Review Focus (for the plan's tests)

1. **Row-level security unchanged in meaning.** Every scope (all, own, team, none, hand-off) sees exactly the rows
   it saw before; unassigned leads only for 'all'; with no settings set, nothing.
2. **The tag column never drifts.** Every way a tag is added or removed (single edit, bulk, import, tag deleted,
   lead deleted) leaves `tag_ids` equal to `lead_tags`.
3. **A filter selection never exceeds what the person sees,** and the snapshot holds when leads change mid-run.
4. **Undo never overwrites a newer change**, and undo of undo is refused.
5. **A crash mid-run** (process restart) resumes from the last committed chunk without doing a chunk twice.
