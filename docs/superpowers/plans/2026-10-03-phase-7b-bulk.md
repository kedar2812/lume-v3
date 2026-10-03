# Phase 7B — Bulk actions at scale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a bulk action covers up to 50,000 leads, picked or "everything matching this filter":
- it runs in the background with progress and cancel;
- it's undoable for 24 hours;
- it keeps every per-lead history, and writes one audit entry and one notice per run.

API only: the screens wait for the owner's design review.

**Architecture:**
- **Runs and their items:** every bulk action becomes a run (`bulk_runs`). Each lead in it is an item (`bulk_run_items`) holding its before-values.
- **Inline or queued:**
  - up to 500 leads run inside the request;
  - more go to a pg-boss queue inside the API (as imports do), in chunks of 500, each chunk one transaction as the person.
- **How each action applies:**
  - assign, tags, delete and set-phone-country are set-based within a chunk;
  - stage moves keep the per-lead path, so the stage's automations run.
- **Undo** is a run, too. It restores before-values only where the lead hasn't changed since.

**Tech Stack:** Fastify, Drizzle and raw SQL, PostgreSQL 17, pg-boss 10, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-phase-7-scale-design.md` §7B, "The gate", Review Focus 3–5.

## Global Constraints

- **Never more than the person may do:**
  - the selection is read as the person (their row-level security and scope);
  - each lead is checked as today's bulk checks it: `leads.bulk_edit` on the record, plus the action's own permission (`leads.assign`, `leads.change_stage`, `leads.delete`, `leads.edit`);
  - a lead they may not touch is skipped with its reason, never failing the run.
- **Limits:**
  - up to 50,000 leads a run; more is refused with "Narrow the selection: up to 50,000 leads at a time.";
  - picked ids, up to 5,000 a request (larger selections come by filter).
- **Per-lead history is kept** exactly as single edits keep it: `lead_assignment_history`, `lead_stage_history`, activities.
- **Per run:** one `lead.bulk` audit entry, and one notice per run (instead of one per lead).
- **Copy speaks as LUME;** no client names; made-up data in tests.
- **Edge cases, as many as possible** (owner, 2026-10-03):
  - empty, one lead, exactly 50,000, 50,001;
  - duplicates;
  - invisible, deleted and unassigned leads;
  - leads changed mid-run;
  - a crash between chunks and inside a chunk;
  - cancel;
  - undo after others' changes; undo twice;
  - undo by someone else, and after 24 hours;
  - access lost mid-run.

## Review Focus

1. **A filter selection never exceeds what the person sees,** and the snapshot holds while leads change mid-run. (Task 1 test.)
2. **A crash mid-run resumes from the last committed chunk,** never doing a chunk twice and never skipping one. (Task 2 test.)
3. **Undo never overwrites a newer change** (version check), and undo of an undo is refused. (Task 3 test.)
4. **Access lost mid-run** (disabled, paused, permission revoked) stops the run at the next chunk; done chunks stay done and undoable. (Task 2 test.)
5. **Notices and audit are per run,** not per lead: a 12,000-lead assign is one notice to each new owner and one audit entry. (Task 2 test.)

---

### Task 1: Runs, selection, and the API

**Files:**
- Create: `packages/db/migrations/0050_bulk_runs.sql`, `packages/db/src/schema/bulk.ts` (+ export);
- Create: `apps/api/src/modules/leads/bulk-runs.ts` (create, read, list), `apps/api/src/modules/leads/bulk-runs.test.ts`;
- Modify: `apps/api/src/modules/leads/routes.ts`: new routes; `POST /leads/bulk` becomes a thin wrapper over a run;
- Modify: `apps/api/test/probes.ts`.

**Interfaces — produces:**
- `POST /api/v1/leads/bulk-runs` (`leads.bulk_edit`), with body
  `{ selection: { ids: uuid[] (1..5000) } | { filters: FilterQuery, except?: uuid[] (≤5000), expected?: number }, action: BulkAction }`.
  - 200: `{ run }` when done inline (≤ 500 leads);
  - 202: `{ run }` when queued;
  - 422: `TOO_MANY`, `NOTHING_SELECTED`.
- `GET /api/v1/leads/bulk-runs/:id`: the run, `{ id, action, status, total, done, skipped, failed, skippedBy: Record<code, number>, createdAt, startedAt, finishedAt, undoUntil, canUndo, undoOf }`. Readable by its maker, or by someone with `leads.bulk_edit` at 'all'.
- `GET /api/v1/leads/bulk-runs`: the person's runs from the last 7 days, newest first. Those with `leads.bulk_edit` at 'all' see everyone's.

```sql
-- 0050 (sketch; comments in the file explain each choice)
CREATE TABLE bulk_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  action jsonb NOT NULL,
  selection jsonb NOT NULL,               -- {ids:n} or {filters, except:n, expected}: never the ids themselves
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','cancelled','failed','undone')),
  total int NOT NULL, done int NOT NULL DEFAULT 0, skipped int NOT NULL DEFAULT 0, failed int NOT NULL DEFAULT 0,
  skipped_by jsonb NOT NULL DEFAULT '{}',
  cancel_requested boolean NOT NULL DEFAULT false,
  undo_of uuid REFERENCES bulk_runs (id),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
CREATE UNIQUE INDEX bulk_runs_one_undo ON bulk_runs (undo_of) WHERE undo_of IS NOT NULL;
CREATE INDEX bulk_runs_recent ON bulk_runs (user_id, created_at DESC);
CREATE TABLE bulk_run_items (
  run_id uuid NOT NULL REFERENCES bulk_runs (id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads (id),
  position int NOT NULL,
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','done','skipped','failed')),
  code text,
  before jsonb,
  after_version int,
  PRIMARY KEY (run_id, lead_id)
);
CREATE INDEX bulk_run_items_pending ON bulk_run_items (run_id, position) WHERE result = 'pending';
```

- [ ] **Step 1: Tests first** (`bulk-runs.test.ts`):
  - picked ids, inline: 3 leads, then assign. Response 200 with `status: 'done'`, `done: 3`; the leads moved.
  - **The selection boundaries:**
    - empty ids, or a filter matching nothing: 422 `NOTHING_SELECTED`;
    - 5,001 ids: 400;
    - duplicate ids count once;
    - a filter at exactly the cap (cap lowered for tests with `setBulkCapForTests(3)`): 3 is accepted, 4 is 422 `TOO_MANY`.
  - **A filter selection as the person (Review Focus 1):**
    - a rep's filter never includes another's lead;
    - `except` removes leads;
    - `expected` differing from the actual count comes back as `{ total, expected }`;
    - a lead added after the snapshot isn't in the run.
  - **Over 500 (`setInlineMaxForTests(2)`):**
    - 3 leads: 202, `status: 'queued'`, nothing changed yet;
    - `h.runBulk()` (harness, like `runImports`) then processes it.
  - **Reading runs:**
    - its maker reads it; another rep gets 404; an admin with `leads.bulk_edit` 'all' reads it;
    - the list is the person's own, last 7 days.
  - **`POST /leads/bulk` still answers `{ updated, skipped }`** as before, and its run is undoable.
  - **Probes** for the new routes.
- [ ] **Step 2: RED.** Run `bash scripts/dev.sh run pnpm exec vitest run apps/api/src/modules/leads/bulk-runs.test.ts`; expect failures.
- [ ] **Step 3: Implement.**
  - Migration, schema, `createRun`.
  - Validate the action exactly as `runBulk` does today: unknown tags, lost reason and target user are checked once, at the start.
  - Snapshot the ids as the person: `SELECT id FROM leads WHERE leadFilters(...) [AND id <> ALL(except)] ORDER BY id LIMIT cap+1`. Insert the items (`INSERT … SELECT unnest`), then run inline or enqueue.
  - Harness: `deps.bulk = { enqueue }` and `h.runBulk()`.
- [ ] **Step 4: GREEN, the suite, commit, push, CI, ledger.**

### Task 2: The engine: chunks, set-based actions, progress, cancel, resume

**Files:**
- Create: `apps/api/src/modules/leads/bulk-engine.ts` (+ test `bulk-engine.test.ts`), `apps/api/src/modules/leads/bulk-queue.ts`;
- Modify: `apps/api/src/app.ts` / server wiring (start the queue like imports'); `packages/core/src/queues.ts` (`"bulk.run"`);
- Modify: `apps/api/src/modules/notifications/notify.ts` (kind `bulk_done`).

**Interfaces — produces:** `processRun(deps, runId): Promise<void>` (idempotent: it only takes `pending` items).

**How a chunk runs** (one transaction, as the person: `withJobRequest`, with their actor reloaded for each chunk):
1. Take the next 500 `pending` items by position (`FOR UPDATE SKIP LOCKED` is not needed: one run at a time).
2. Lock their leads, read as the person (`SELECT … FROM leads WHERE id = ANY($ids) FOR UPDATE`). Missing means not visible or deleted: skipped `NOT_VISIBLE`.
3. Check each lead's permission in JS (`canOnRecord`), exactly as `runBulk` does. Refused leads are skipped with the code.
4. Apply the action:
   - **assign** (set-based):
     - history rows with reason `'bulk'` and `assigned` activities, inserted in bulk *before* the owner changes;
     - the update runs with scope 'all' for this statement only, as LUME, after the checks above (the multi-lead form of the hand-off); scope restored;
     - new owners are tallied for the run's notice.
   - **tags** (set-based): delete and insert `lead_tags`. `tag_ids` follows by trigger. Bump the version; a `field_changed` activity.
   - **delete** (set-based): soft delete with a version bump. `cancelLeadTasks` runs only for leads that have open tasks.
   - **set_phone_country:** each number is normalised in JS, then one `UPDATE … FROM unnest(…)`. `ALREADY_VALID`, `NO_NUMBER` and `STILL_INVALID` are skipped.
   - **stage** (per lead, in savepoints): `moveStage`. `REQUIRED_FIELDS`, `LOST_REASON_REQUIRED` and the like are skipped with their code.
5. Write each item's `before` (owner, stage, tag ids, deleted, phone fields, whatever the action changes), its `after_version` and its result, in the same transaction.
6. Update the run's counts.
7. **Cancel:** checked before each chunk.
8. **Access lost** (actor null: disabled or paused; or no `leads.bulk_edit`): the run ends `failed` with "Their access changed". Done chunks stay.

**Per run:**
- **Audit:** one `lead.bulk` entry at the end: `{ type, total, done, skipped, selection }`. No per-lead `lead.assign`, `lead.stage` or `lead.delete` entries for bulk; the history tables keep each lead.
- **Notices:**
  - the maker gets `bulk_done`: "LUME moved 12,408 leads to Contacted. 12 were skipped.", for queued runs only (an inline run answers in the response);
  - each new owner of an assign gets one `lead_assigned`: "{n} leads were assigned to you by {name}".

- [ ] **Step 1: Tests first** (`bulk-engine.test.ts`, inline cap 0 so everything queues):
  - **Every action over 7 leads with a chunk size of 3** (`setChunkForTests(3)`): every lead changed once; history rows and activities as single edits make them; `tag_ids` right; deleted leads' open tasks cancelled.
  - **Skips with reasons:** an invisible lead; a lead someone else owns for a rep with own `leads.assign`; a stage that needs a field; a lost stage without a reason (refused at the start instead); `set_phone_country` on a valid number. `skippedBy` counts each code.
  - **Crash between chunks and inside a chunk (Review Focus 2):** a test hook throws after chunk 2 commits, or mid-chunk 3. Then `processRun` again: every lead is changed exactly once; history counts prove no chunk ran twice.
  - **Cancel:** cancel after chunk 1. The run is `cancelled`, chunk 1 done, the rest pending-then-skipped (`CANCELLED`).
  - **Access lost (Review Focus 4):** the maker disabled between chunks gives `failed`, with done chunks kept.
  - **Per run (Review Focus 5):** a 7-lead assign to Sam is one `lead_assigned` notice to Sam, one `bulk_done` to the maker, one `lead.bulk` audit entry, and zero `lead.assign` entries.
  - **Concurrent edits:** a lead edited between snapshot and chunk is acted on in its current state, and its `before` is taken at the chunk.
- [ ] **Step 2: RED → Step 3: implement → Step 4: GREEN, the suite, commit, push, CI, ledger.**

### Task 3: Undo

**Files:** `apps/api/src/modules/leads/bulk-undo.ts` (+ test), routes, probes.

**Interfaces — produces:** `POST /api/v1/leads/bulk-runs/:id/undo`, which gives 202/200 with `{ run }` (the undo run).
- Refused with:
  - `UNDO_EXPIRED` after 24 hours;
  - `ALREADY_UNDONE`, or one undo per run (the unique index);
  - `NOT_UNDOABLE` for an undo run, or one still running;
  - 404 for someone who can't read the run.

**What it restores:** for each `done` item whose lead's `version` still equals `after_version`, put back `before`. Otherwise skip it as `CHANGED_SINCE`.
- **assign:** the old owner, with history reason `'undo'`.
- **stage:** the old stage directly, with a history row; the stage's automations aren't run.
- **tags:** the exact old tag set.
- **delete:** `deleted_at = NULL`; cancelled tasks aren't revived.
- **phone:** the old phone fields.

The original run ends `undone`.

- [ ] **Tests first:**
  - undo of each action restores exactly;
  - a lead changed after the run is skipped `CHANGED_SINCE` and keeps the newer change (Review Focus 3);
  - undo twice gives 409; undo of an undo is refused;
  - after 24 hours (clock moved) it's refused;
  - another rep gets 404; an admin with 'all' may undo;
  - undo of a partly cancelled run restores only the done items;
  - undo is itself chunked and resumable (crash hook).
- [ ] **RED → GREEN, the suite, commit, push, CI, ledger.**

### Task 4: The gate, retention, docs, review

- [ ] **Retention:** the hourly tick deletes `bulk_run_items` of runs finished more than 30 days ago (test-first). The run row stays.
- [ ] **Scale test:** at 200,000 leads, time bulk assign, stage, tag and delete over 50,000 leads by filter (queued, processed to completion), then cancel midway and undo. Budget: each 50,000-lead action finishes within 120 s on the 1-CPU scale database; record the times.
- [ ] **Docs:** `docs/runbooks/performance.md` (bulk section), the changelog (0050), and the audit words for `lead.bulk` (run counts) and `bulk_done` in the web's audit and notification wording (test-first).
- [ ] **The full suite, lint, typecheck, e2e** (the leads and board specs use bulk), push, CI.
- [ ] **One fresh reviewer (opus)** over the 7B diff against this plan and the spec; one fix pass; close the ledger. Then the summary for the owner.
