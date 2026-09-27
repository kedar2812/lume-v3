# Phase 2B-1 — Google Sheets, the Refresh moment and the arrival glow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client connects a Google Sheet once (via the owner-provided service account). New rows become leads automatically every few minutes, or at once on **Refresh**, which plays the approved v5 moment. What arrived since your last visit glows in.

**Architecture:**
- **The 2A intake engine is reused unchanged.** The per-row write (map → lock → match → create/merge/skip) moves into one shared `writeRow` that both the CSV runner and the new sheet sync call.
- **Setting up a sheet reuses the import draft.** A CSV snapshot of the sheet becomes an `imports` row of kind `sheet`, so the Columns, Rules and Preview steps, and their endpoints, are the 2A ones.
- **Syncs.**
  - Syncs are pg-boss jobs (`sheets.sync`) in the API process.
  - They are requested through one atomic `requestSync`, which starts a sync or joins the one under way.
  - A per-minute ticker requests the due ones.
- **The Refresh card** polls a progress endpoint. Its counts are computed under the viewer's own row-level security.

**Tech Stack:** Node 22, TypeScript strict, Fastify 5, Zod 4, Drizzle, Postgres 17 (FORCE RLS), pg-boss 10, Next.js 16, motion 12, Vitest, Playwright. The Google APIs are called with `fetch` and `node:crypto`; there is no Google SDK dependency.

**Spec:** `docs/superpowers/specs/2026-09-27-phase-2b-google-sheets-design.md` (this plan covers §3–5, §7, §8, §9 without OAuth, §10 and §11). Its parent is `docs/superpowers/specs/2026-09-27-phase-2-intake-design.md`.

## Global Constraints

- LUME is a product for many clients. Nothing names a client. Sheets is an **optional module, off by default**. With it off, no Refresh, no job, no Integrations entries beyond the switch, and the app works exactly as before.
- Lead data leaves the server only to Google, and only for the sheet this client connected. LUME **never writes** to a sheet.
- UI copy speaks as **"LUME"** ("LUME will try again in 2 minutes"), never "we".
- **One accent blue `#2A5BFF` in both themes** (`var(--accent)`). Dark `--accent-ink` `#8aa7ff` is for text only.
- **Official third-party marks only.** The Google Sheets mark is `/brand/google-sheets.png`, unmodified, on a white tile (`--tile` in light, and a white tile in dark too). This includes animations.
- The LUME mark is `/lume-mark.png`, used as-is. Never generate, trace or resize-in-source the logo.
- **No sound** for syncs or new leads.
- The card says **"Syncing new enquiries"**, never a sheet's name.
- Every number on screen is real, from the server. There are no placeholders.
- Every new route is in `apps/api/test/probes.ts` (the permission matrix fails CI otherwise).
- **Reduce Motion:** a still card and plain fades, with no morph and no drifting rows.
- **Focus:** stays on Refresh throughout.
- **Announcements:** one polite live announcement at the start and one at the end.
- Secrets never go in git. The service-account key lives only in the environment (`GOOGLE_SERVICE_ACCOUNT_JSON`, base64). Only its `client_email` is ever shown.
- **The dev box `lumedev` is a client's LIVE server:**
  - Docker only, under `/root/lume-dev`, with ports bound to 127.0.0.1.
  - Never run bootstrap-server.sh.
  - Keep usage near 1.5 CPU / 3 GB.
  - **Ask the owner before any `reset-db`**; the dev DB is his demo.
- Gate before every commit (prints `GATE_OK`): `G="C:/Users/Admin/AppData/Local/Temp/claude/F--projects-kedar-lume-v3/0343b798-3cbd-41fe-9a07-8b9807d5a52f/scratchpad"; bash "$G/gate.sh" > "$G/gate.log" 2>&1; tail -1 "$G/gate.log"`.
- **Commits:** straight to `main`, then push and watch CI. Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01UF1mSqBG9YPMx84wpEN6Wu
  ```
- **Test commands** (the toolbox on the build host):
  - Unit and integration: `bash scripts/dev.sh run bash -c 'pnpm --filter <pkg> exec vitest run <path>'`.
  - e2e: `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec playwright test <spec>'`.
- **Pitfalls:**
  - Use the Edit tool (not a Python heredoc) for strings containing `\n`.
  - Playwright `getByLabel` matches substrings; pass `{ exact: true }` where needed.
  - RTL `getByText` matches an element's own text only.

## Review Focus

1. **A sheet whose rows come back shorter than the header,** or with blank rows between filled ones. Google omits trailing empty cells and rows. Rows must be padded to the header's width, and blank rows skipped but still counted in positions, so that `row 14` in a message is the sheet's row 14. *Test: Task 5 `toGrid` cases, and Task 6 "blank rows and short rows".*
2. **Two Refreshes at once, or a Refresh during a scheduled sync.** There is one sync, and both cards show its progress. *Test: Task 6 `requestSync` concurrency, and Task 9 "two refreshes join one sync".*
3. **A tab renamed in Google.** LUME follows it by its numeric id and keeps syncing; it is not "needs attention". *Test: Task 6 "a renamed tab is followed".*
4. **A header that differs only in case or spacing** (`"Phone "` against `"phone"`). This is not a rename. *Test: Task 5 `headerDrift` cases.*
5. **The person who connected the sheet is disabled, or loses Import.** The source becomes "needs attention" with a message naming what to do. It does not fail silently, and an admin saving the source takes it over. *Test: Task 6 "the person it runs as loses access", and Task 8 "saving again takes it over".*

## File map

**API (`apps/api/src/modules/sheets/`, new):**

| File | What it holds |
|---|---|
| `google.ts` | Google client: service-account token, Drive `modifiedTime`, Sheets metadata and values; `GoogleError`; `parseSheetLink`; `rowsRange` |
| `grid.ts` | Pure helpers: `toGrid`, `headerDrift`, `anchorHash`, `sheetFingerprint`, `gridToCsv` |
| `config.ts` | The encrypted per-source config (`SheetConfig`), seal and open |
| `requests.ts` | `requestSync`: atomic start-or-join |
| `sync.ts` | `runSync`: one sync, end to end; `Attention` |
| `queue.ts` | pg-boss worker for `sheets.sync`, plus the per-minute ticker |
| `service.ts` | Integration switch, inspect, drafts, save (connect or edit), list, detail, patch, remove, sync now, dismiss, problems CSV |
| `refresh.ts` | Status, start refresh, progress |
| `routes.ts` | All `/api/v1/integrations*` and `/api/v1/sheets*` routes |

**API (existing files, modified):**

| File | Change |
|---|---|
| `modules/imports/row.ts` (new) | `writeRow`: the per-row engine, shared |
| `modules/imports/runner.ts` | Uses `writeRow`; exports `isDataError` and `givesAway` |
| `modules/imports/start.ts` | `prepareStart` extracted; `tagParts` exported |
| `modules/imports/service.ts` | Excludes kind `sheet` from lists; exports `defaultRules` |
| `modules/leads/routes.ts`, `modules/leads/query.ts` | The arrivals endpoints and the `arrivedAfter` filter |
| `modules/catalog/service.ts` | `listSources` hides drafts |
| `app.ts` | `AppDeps.google` and `AppDeps.sheets` |
| `main.ts` | The Google client and the sheets queue |

**Tests:**
- `apps/api/test/google-fake.ts`: the fake Google, over HTTP, with controls.
- `apps/api/test/harness.ts`: `google` option, `fake`, `runSyncs()`.
- `apps/api/test/probes.ts`: the new routes.

**DB:**
- `packages/db/migrations/0016_sheets.sql`.
- `packages/db/src/schema/intake.ts`: new columns and tables.
- `packages/db/src/schema/identity.ts` (users): `leadsSeenAt`.
- `packages/db/src/intake.test.ts`: grants.

**Core and config:**
- `packages/core/src/queues.ts`: `sheets.sync`.
- `packages/core/src/intake/read.ts`: exports `nameHeaders`.
- `packages/config/src/schema.ts`: `GOOGLE_SERVICE_ACCOUNT_JSON`, `LUME_GOOGLE_ENDPOINT`, `LUME_SHEETS_MAX_ROWS`.

**Worker:** `apps/worker/src/maintenance.ts` and `boss.ts`: retention for syncs and refreshes.

**Web:**

| File | What it holds |
|---|---|
| `lib/sheets/client.ts`, `lib/sheets/types.ts` | The API client and its types |
| `lib/settings/areas.ts` | New "Integrations" area |
| `lib/settings/audit.ts` | Wording for `sheet.*` and `integration.*` |
| `lib/leads/history.ts` | "Imported from {sheet}, row N" |
| `app/(app)/settings/integrations/page.tsx`, `app/(app)/settings/integrations/[id]/page.tsx` | The two Settings pages |
| `components/integrations/Integrations.tsx`, `SheetSourceList.tsx`, `SourceDetail.tsx`, `AttentionBanner.tsx`, `integrations.module.css` | The Integrations screens |
| `components/sheets/AddSheetSheet.tsx`, `SheetStep.tsx`, `StartFromStep.tsx` | The Add a sheet wizard |
| `components/sheets/RefreshButton.tsx`, `useRefresh.ts`, `refresh.module.css` | The Refresh moment |
| `components/leads/useArrivals.ts` | The arrival glow |
| `components/leads/LeadsScreen.tsx`, `LeadsTable.tsx`, `leads.module.css` | Refresh, the glow, and the "N new since" line |
| `components/board/BoardScreen.tsx` | Refresh |
| `components/imports/PreviewStep.tsx`, `ColumnsStep.tsx` | `mode="sheet"` and `notice` props |

**e2e:**
- `apps/web/e2e/google-fake.ts`: the webServer entry.
- `apps/web/e2e/sheets.spec.ts`, `apps/web/e2e/sheets-helpers.ts`.
- `apps/web/e2e/api-server.mjs`: Google env.
- `apps/web/playwright.config.ts`: the fake as a webServer.

**Docs:**
- `docs/design/refresh-sync-v5.html`: the approved motion reference, copied in.
- The spec's §14 amendments.
- `docs/runbooks/acceptance.md`: a 2B-1 section.
- `apps/web/e2e-live/acceptance-2b1.mjs`.

---

### Task 0: Design reference and spec amendments

**Files:**
- Create: `docs/design/refresh-sync-v5.html` (copy)
- Modify: `docs/superpowers/specs/2026-09-27-phase-2b-google-sheets-design.md` (append §14)

**Interfaces:** Produces the committed motion reference `docs/design/refresh-sync-v5.html`, which Task 13 reads. Produces the amendments A1–A12, which later tasks cite.

- [ ] **Step 1: Copy the approved mockup into the repo** (the brainstorm folder is git-ignored)

```bash
mkdir -p docs/design
cp ".superpowers/brainstorm/2363-1790517289/content/refresh-sync-v5.html" docs/design/refresh-sync-v5.html
sed -i 's#/files/lume-mark.png#../../apps/web/public/lume-mark.png#g; s#/files/google-sheets.png#../../apps/web/public/brand/google-sheets.png#g' docs/design/refresh-sync-v5.html
grep -c "lume-mark.png" docs/design/refresh-sync-v5.html
```
Expected: a count ≥ 2, and the file opens in a browser from `docs/design/` with both marks showing.

- [ ] **Step 2: Append the amendments to the spec**

Append this section to the end of the spec file:

```markdown
## 14. Amendments (from planning 2B-1, 2026-09-27)

- **A1. Setting up a sheet reuses the import draft.**
  - A CSV snapshot of the sheet's first 20,000 rows becomes an `imports` row of kind `sheet`, so Columns, Rules and Preview are the 2A steps and endpoints.
  - Connecting a sheet therefore needs both Manage integrations (`integrations.manage`, the catalogue's permission for "Sheets, Calendly, webhooks") and Import leads (`leads.import`).
  - The draft's source is a `lead_sources` row with status `draft`. It becomes the real source on save. An edit uses a throwaway draft source, so the 7-day draft sweep can never delete a live source.
- **A2. A sheet runs as the person who last saved it** (`run_as`). If they can no longer import leads, or no longer give leads to others while the rules do, the source needs attention until an admin saves it again.
- **A3. "Only rows added from now on"** records every row already in the sheet as a baseline (by fingerprint, result `skipped`, code `BEFORE_START`) on the first sync, without creating leads. Rows are recognised by identity, not position.
- **A4. `head_hash` covers the header, the first data row and the last row read.** A full re-read happens when it changes, and at least hourly while the sheet keeps changing. This catches rows inserted or removed anywhere above the end.
- **A5. Health counts are computed when asked** (from `source_rows` and `source_syncs`), not kept in a `stats` column. The saved header list (`headers`) replaces `header_signature`.
- **A6. A sheet row's fingerprint** is the raw date cell (time included, when a column is mapped to the lead's date) plus phone, email and Instagram. A repeat enquiry with a new timestamp is a new row. Without a date column, LUME tells the admin a repeat can't be told apart.
- **A7. Progress is counted per row** in the row's own transaction, which is exact, rather than every 50 rows.
- **A8. The "last seen Leads" marker is `users.leads_seen_at`,** set with the server's clock by `POST /api/v1/leads/arrivals/seen`. It is not stored in `preferences`, whose merge rebuilds the object.
- **A9. Refresh is cheap to press twice.** A second press by the same person within 3 s returns the same refresh. Every press joins syncs already under way. A source synced in the last 10 s reuses that result.
- **A10. The board gets Refresh too;** the glow is table-only.
- **A11. The Google client retries 429/5xx itself,** 3 times (1 s, 2 s, 4 s). A sync that still fails backs off: the next try is `poll_seconds × 2^failures`, capped at 1 hour.
- **A12. Remove archives the source.** Its leads keep it, so "From {sheet}" still reads right. Nothing more syncs.
- **A13. Integrations are managed with `integrations.manage`.** That is the catalogue's permission for "Sheets, Calendly, webhooks", and the 2A spec's own table uses it. It replaces `settings.manage` everywhere this spec names it for Sheets: the switch, connecting, looking after sheets, and the attention banner.
```

- [ ] **Step 3: Commit**

```bash
git add docs/design/refresh-sync-v5.html docs/superpowers/specs/2026-09-27-phase-2b-google-sheets-design.md
git commit -m "docs: 2B-1 planning amendments, and the approved Refresh motion kept in the repo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UF1mSqBG9YPMx84wpEN6Wu"
```

---

### Task 1: Data — migration 0016, schema, queue name, retention

**Files:**
- Create: `packages/db/migrations/0016_sheets.sql`
- Modify: `packages/db/src/schema/intake.ts`, the users table in `packages/db/src/schema/` (find it with `grep -ln 'pgTable("users"' packages/db/src/schema/*.ts`), `packages/core/src/queues.ts`, `apps/worker/src/maintenance.ts`, `apps/worker/src/boss.ts`
- Test: `packages/db/src/intake.test.ts`, `apps/worker/src/maintenance.integration.test.ts`

**Interfaces:**
- Produces the Drizzle tables `schema.sourceRows`, `schema.sourceSyncs` and `schema.sourceRefreshes`.
- Produces new `schema.leadSources` columns: `headers`, `columnSettings`, `runAs`, `pollSeconds`, `nextSyncAt`, `lastModified`, `rowsRead`, `headHash`, `fullReadAt`, `currentSyncId`, `syncLockUntil`, `rrCursor`, `failures`, `attentionCode`, `newColumns`, `configVersion`, `syncedConfigVersion` and `baseline`.
- Produces `schema.users.leadsSeenAt`, `schema.settings.integrations` (`{ googleSheets?: { enabled: boolean } }`), and `imports.kind` gaining `"sheet"` plus `imports.targetSourceId`.
- Produces the queue name `"sheets.sync"` and the worker job `maintenance.purgeSheetSyncs()`.

- [ ] **Step 1: Write the failing DB test** (append to `packages/db/src/intake.test.ts`, inside its existing top-level `describe`, reusing its `db` helper and roles)

```ts
  it("0016: sheet sources keep their sync state, rows are unique per source, and the worker only sweeps", async () => {
    const owner = db.pool("lume_owner");
    const src = "0190e0c0-0000-7000-8000-00000000f001";
    await owner.query(
      "INSERT INTO lead_sources (id, type, name, status) VALUES ($1, 'google_sheet', 'Enquiries', 'draft')",
      [src],
    );
    const { rows } = await owner.query(
      "SELECT poll_seconds, rows_read, config_version, baseline, new_columns FROM lead_sources WHERE id = $1",
      [src],
    );
    expect(rows[0]).toEqual({ poll_seconds: 120, rows_read: 0, config_version: 1, baseline: false, new_columns: [] });
    await expect(
      owner.query("UPDATE lead_sources SET poll_seconds = 30 WHERE id = $1", [src]),
    ).rejects.toThrow(/poll/);
    await owner.query(
      "INSERT INTO source_rows (source_id, fingerprint, result, row_number) VALUES ($1, 'fp1', 'created', 2)",
      [src],
    );
    await expect(
      owner.query(
        "INSERT INTO source_rows (source_id, fingerprint, result, row_number) VALUES ($1, 'fp1', 'error', 3)",
        [src],
      ),
    ).rejects.toThrow(/source_rows_once/);
    await owner.query(
      "INSERT INTO imports (id, source_id, kind, status, file_sha256, file_name, file_bytes) VALUES ('0190e0c0-0000-7000-8000-00000000f002', $1, 'sheet', 'draft', 'x', 'Enquiries', 1)",
      [src],
    );
    const worker = db.pool("lume_worker");
    await expect(worker.query("SELECT fingerprint FROM source_rows")).rejects.toThrow(/permission/);
    await expect(worker.query("DELETE FROM source_syncs WHERE requested_at < now()")).resolves.toBeDefined();
    await expect(worker.query("DELETE FROM source_refreshes WHERE created_at < now()")).resolves.toBeDefined();
    const u = await owner.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'leads_seen_at'");
    expect(u.rowCount).toBe(1);
    const s = await owner.query("SELECT integrations FROM settings WHERE id = 1");
    expect(s.rows[0]?.integrations ?? {}).toEqual({});
  });
```

(If the file's helper is named differently from `db.pool(role)`, use its existing role-pool helper. Read the top 30 lines of the file first and match it exactly.)

- [ ] **Step 2: Run it and watch it fail**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/db exec vitest run src/intake.test.ts'`
Expected: FAIL, with `column "poll_seconds" does not exist`.

- [ ] **Step 3: Write the migration** `packages/db/migrations/0016_sheets.sql`

```sql
-- Phase 2B-1 (spec 2026-09-27-phase-2b §4, amendments A1–A8). A Google Sheet is a lead source that is read again
-- and again: it remembers where it read to, which rows it has dealt with, and every sync it ran.
ALTER TABLE settings ADD COLUMN integrations jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN leads_seen_at timestamptz;

ALTER TABLE lead_sources DROP CONSTRAINT lead_sources_status;
ALTER TABLE lead_sources ADD CONSTRAINT lead_sources_status
  CHECK (status IN ('draft', 'active', 'paused', 'needs_attention', 'archived'));
ALTER TABLE lead_sources
  ADD COLUMN headers jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN column_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN run_as uuid REFERENCES users (id),
  ADD COLUMN poll_seconds integer NOT NULL DEFAULT 120 CONSTRAINT lead_sources_poll CHECK (poll_seconds BETWEEN 60 AND 3600),
  ADD COLUMN next_sync_at timestamptz,
  ADD COLUMN last_modified text,
  ADD COLUMN rows_read integer NOT NULL DEFAULT 0,
  ADD COLUMN head_hash text,
  ADD COLUMN full_read_at timestamptz,
  ADD COLUMN current_sync_id uuid,
  ADD COLUMN sync_lock_until timestamptz,
  ADD COLUMN rr_cursor integer NOT NULL DEFAULT 0,
  ADD COLUMN failures integer NOT NULL DEFAULT 0,
  ADD COLUMN attention_code text,
  ADD COLUMN new_columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN config_version integer NOT NULL DEFAULT 1,
  ADD COLUMN synced_config_version integer,
  ADD COLUMN baseline boolean NOT NULL DEFAULT false;
CREATE INDEX lead_sources_due ON lead_sources (next_sync_at) WHERE type = 'google_sheet' AND status = 'active';

ALTER TABLE imports DROP CONSTRAINT imports_kind;
ALTER TABLE imports ADD CONSTRAINT imports_kind CHECK (kind IN ('csv', 'sheet'));
-- An edit of a live sheet's columns is a draft on a throwaway source; this names the live one (A1).
ALTER TABLE imports ADD COLUMN target_source_id uuid REFERENCES lead_sources (id) ON DELETE CASCADE;

CREATE TABLE source_rows (
  id bigserial PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES lead_sources (id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  result text NOT NULL CONSTRAINT source_rows_result
    CHECK (result IN ('pending', 'created', 'merged', 'skipped', 'error', 'dismissed', 'superseded')),
  lead_id uuid,
  sync_id uuid,
  row_number integer NOT NULL,
  problems jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_enc bytea,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_tried_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_rows_once UNIQUE (source_id, fingerprint)
);
CREATE INDEX source_rows_problems ON source_rows (source_id, row_number) WHERE result = 'error';
CREATE INDEX source_rows_by_sync ON source_rows (sync_id);
CREATE INDEX source_rows_created ON source_rows (source_id, first_seen_at) WHERE result = 'created';

CREATE TABLE source_syncs (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES lead_sources (id) ON DELETE CASCADE,
  trigger text NOT NULL CONSTRAINT source_syncs_trigger CHECK (trigger IN ('schedule', 'refresh', 'connect', 'manual')),
  requested_by uuid REFERENCES users (id),
  status text NOT NULL CONSTRAINT source_syncs_status CHECK (status IN ('queued', 'running', 'done', 'failed')),
  rows_total integer NOT NULL DEFAULT 0,
  rows_read integer NOT NULL DEFAULT 0,
  created integer NOT NULL DEFAULT 0,
  merged integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text
);
CREATE INDEX source_syncs_recent ON source_syncs (source_id, requested_at DESC);

CREATE TABLE source_refreshes (
  id uuid PRIMARY KEY,
  requested_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  sync_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_refreshes_by_user ON source_refreshes (requested_by, created_at DESC);

-- Configuration-like, as in 0015: no RLS; the API enforces permissions. The worker only sweeps old history.
REVOKE ALL ON source_rows, source_syncs, source_refreshes FROM lume_worker;
REVOKE ALL ON SEQUENCE source_rows_id_seq FROM lume_worker;
GRANT SELECT (id, requested_at), DELETE ON source_syncs TO lume_worker;
GRANT SELECT (id, created_at), DELETE ON source_refreshes TO lume_worker;
```

- [ ] **Step 4: Add the Drizzle schema.** In `packages/db/src/schema/intake.ts`:
  - Add the new `leadSources` columns.
  - Widen `status` and `imports.kind`.
  - Add `imports.targetSourceId`.
  - Add the three tables.

```ts
// leadSources: replace the status line and add after archivedAt:
  status: text("status")
    .$type<"draft" | "active" | "paused" | "needs_attention" | "archived">()
    .notNull()
    .default("active"),
  // …existing columns…
  headers: jsonb("headers").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  columnSettings: jsonb("column_settings").notNull().default(sql`'{}'::jsonb`),
  runAs: uuid("run_as"),
  pollSeconds: integer("poll_seconds").notNull().default(120),
  nextSyncAt: tz("next_sync_at"),
  lastModified: text("last_modified"),
  rowsRead: integer("rows_read").notNull().default(0),
  headHash: text("head_hash"),
  fullReadAt: tz("full_read_at"),
  currentSyncId: uuid("current_sync_id"),
  syncLockUntil: tz("sync_lock_until"),
  rrCursor: integer("rr_cursor").notNull().default(0),
  failures: integer("failures").notNull().default(0),
  attentionCode: text("attention_code"),
  newColumns: jsonb("new_columns").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  configVersion: integer("config_version").notNull().default(1),
  syncedConfigVersion: integer("synced_config_version"),
  baseline: boolean("baseline").notNull().default(false),

// imports: kind and the new column
  kind: text("kind").$type<"csv" | "sheet">().notNull(),
  targetSourceId: uuid("target_source_id"),

// new tables (add `boolean` to the pg-core import list)
export type SourceRowResult = "pending" | "created" | "merged" | "skipped" | "error" | "dismissed" | "superseded";
export const sourceRows = pgTable(
  "source_rows",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sourceId: uuid("source_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    result: text("result").$type<SourceRowResult>().notNull(),
    leadId: uuid("lead_id"),
    syncId: uuid("sync_id"),
    rowNumber: integer("row_number").notNull(),
    problems: jsonb("problems").notNull().default(sql`'[]'::jsonb`),
    warnings: jsonb("warnings").notNull().default(sql`'[]'::jsonb`),
    rawEnc: bytea("raw_enc"),
    firstSeenAt: tz("first_seen_at").notNull().defaultNow(),
    lastTriedAt: tz("last_tried_at").notNull().defaultNow(),
  },
  (t) => [unique("source_rows_once").on(t.sourceId, t.fingerprint)],
);
export type SyncTrigger = "schedule" | "refresh" | "connect" | "manual";
export const sourceSyncs = pgTable("source_syncs", {
  id: uuid("id").primaryKey(),
  sourceId: uuid("source_id").notNull(),
  trigger: text("trigger").$type<SyncTrigger>().notNull(),
  requestedBy: uuid("requested_by"),
  status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull(),
  rowsTotal: integer("rows_total").notNull().default(0),
  rowsRead: integer("rows_read").notNull().default(0),
  created: integer("created").notNull().default(0),
  merged: integer("merged").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  requestedAt: tz("requested_at").notNull().defaultNow(),
  startedAt: tz("started_at"),
  finishedAt: tz("finished_at"),
  error: text("error"),
});
export const sourceRefreshes = pgTable("source_refreshes", {
  id: uuid("id").primaryKey(),
  requestedBy: uuid("requested_by").notNull(),
  syncIds: uuid("sync_ids").array().notNull(),
  createdAt: tz("created_at").notNull().defaultNow(),
});
```

Make three more additions:
- In the users table file: `leadsSeenAt: tz("leads_seen_at"),`.
- In the settings table: `integrations: jsonb("integrations").$type<{ googleSheets?: { enabled: boolean } }>().notNull().default(sql\`'{}'::jsonb\`),`.
- Export the new tables wherever `intake.ts`'s tables are re-exported (check `packages/db/src/schema/index.ts`).

The drift test (`schema.drift.test.ts`) compares Drizzle with the database, so every column above must match the SQL exactly.

- [ ] **Step 5: Add the queue name and the retention sweep**

`packages/core/src/queues.ts`: add `"sheets.sync",` and `"sheets.retention",` after `"imports.retention",`.

Add to `apps/worker/src/maintenance.ts`, inside the returned object, and add `purgeSheetSyncs(): Promise<{ syncs: number; refreshes: number }>` to the exported `MaintenanceJobs` type:

```ts
    /** Spec §4: sync history is kept 30 days, and a Refresh's record 1 day. Nothing else is touched. */
    async purgeSheetSyncs() {
      const t = now().getTime();
      const syncs = await pool.query("DELETE FROM source_syncs WHERE requested_at < $1", [new Date(t - 30 * 86_400_000)]);
      const refreshes = await pool.query("DELETE FROM source_refreshes WHERE created_at < $1", [new Date(t - 86_400_000)]);
      return { syncs: syncs.rowCount ?? 0, refreshes: refreshes.rowCount ?? 0 };
    },
```

`apps/worker/src/boss.ts`: after the `imports.retention` block:

```ts
  await boss.schedule("sheets.retention", "41 3 * * *", {}, { tz: "UTC" });
  await boss.work("sheets.retention", { batchSize: 1 }, async () => {
    const r = await opts.maintenance.purgeSheetSyncs();
    opts.log.info(r, "sheet sync history purged");
  });
```

Add a case to `apps/worker/src/maintenance.integration.test.ts`, following its `purgeImportFiles` case (same setup helpers):

```ts
  it("purgeSheetSyncs deletes syncs after 30 days and refreshes after 1 day, nothing newer", async () => {
    // insert (as lume_owner) one lead_sources row, two source_syncs (31 days old, 1 day old) and two
    // source_refreshes (2 days old, 1 hour old), using the file's owner pool and clock helper
    const r = await jobs.purgeSheetSyncs();
    expect(r).toEqual({ syncs: 1, refreshes: 1 });
  });
```

Write the four inserts with the same owner-pool helper the file's import-retention test uses, setting `requested_at`/`created_at` explicitly relative to the test clock.

- [ ] **Step 6: Run the DB, worker and drift tests**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/db exec vitest run && pnpm --filter @lume/worker exec vitest run src/maintenance.integration.test.ts'`
Expected: PASS, including `schema.drift.test.ts`.

- [ ] **Step 7: Gate and commit**

```bash
git add packages/db packages/core/src/queues.ts apps/worker
git commit -m "feat(db): sheet sources remember where they read to, every row they dealt with, and every sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01UF1mSqBG9YPMx84wpEN6Wu"
```

---

### Task 2: Configuration — the Google key, its endpoint, and the row limit

**Files:**
- Modify: `packages/config/src/schema.ts`
- Test: `packages/config/src/config.test.ts`

**Interfaces:** `apiSchema` gains three variables:
- `GOOGLE_SERVICE_ACCOUNT_JSON?: string`: base64 of the key file. It is validated to hold `client_email` and `private_key`.
- `LUME_GOOGLE_ENDPOINT?: string`: a URL. Tests and e2e point it at the fake.
- `LUME_SHEETS_MAX_ROWS: number`: default 50000.

- [ ] **Step 1: Write the failing tests** (append inside the api describe of `config.test.ts`)

```ts
  it("Google Sheets settings are optional; a key must be a base64 service-account JSON", () => {
    const none = loadConfig(apiSchema, apiEnv);
    expect(none.GOOGLE_SERVICE_ACCOUNT_JSON).toBeUndefined();
    expect(none.LUME_SHEETS_MAX_ROWS).toBe(50_000);
    const key = Buffer.from(
      JSON.stringify({ type: "service_account", client_email: "lume@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" }),
    ).toString("base64");
    const ok = loadConfig(apiSchema, { ...apiEnv, GOOGLE_SERVICE_ACCOUNT_JSON: key, LUME_GOOGLE_ENDPOINT: "http://127.0.0.1:3112" });
    expect(ok.GOOGLE_SERVICE_ACCOUNT_JSON).toBe(key);
    const bad = issuesOf(() => loadConfig(apiSchema, { ...apiEnv, GOOGLE_SERVICE_ACCOUNT_JSON: "bm90IGpzb24=" }));
    expect(bad.join("\n")).toMatch(/GOOGLE_SERVICE_ACCOUNT_JSON/);
    expect(issuesOf(() => loadConfig(apiSchema, { ...apiEnv, LUME_SHEETS_MAX_ROWS: "10" })).join()).toMatch(/LUME_SHEETS_MAX_ROWS/);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/config exec vitest run'`
Expected: FAIL. The key is unknown, and `LUME_SHEETS_MAX_ROWS` is undefined.

- [ ] **Step 3: Implement** (in `apiSchema`, after `LUME_VERSION`)

```ts
  // Google Sheets (spec 2B §3): the key file Google gives for a service account, base64-encoded. Only its
  // client_email is ever shown; the key itself never leaves the environment.
  GOOGLE_SERVICE_ACCOUNT_JSON: optional(
    z.string().refine((v) => {
      try {
        const j = JSON.parse(Buffer.from(v, "base64").toString("utf8")) as Record<string, unknown>;
        return typeof j.client_email === "string" && typeof j.private_key === "string";
      } catch {
        return false;
      }
    }, "must be the service account's JSON key file, base64-encoded"),
  ),
  LUME_GOOGLE_ENDPOINT: optional(z.url({ protocol: /^https?$/ })),
  LUME_SHEETS_MAX_ROWS: z.coerce.number().int().min(1000).max(500_000).default(50_000),
```

- [ ] **Step 4: Run the tests**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

Message: `feat(config): an optional Google service-account key, its endpoint, and the sheet row limit`, with the trailer.

---

### Task 3: The Google client, and a fake Google to test it against

**Files:**
- Create: `apps/api/test/google-fake.ts`, `apps/api/src/modules/sheets/google.ts`
- Test: `apps/api/src/modules/sheets/google.test.ts`

**Interfaces:**
- Produces, from `google.ts`:
  - `type ServiceAccount = { clientEmail: string; privateKey: string; tokenUri: string }`
  - `parseServiceAccount(b64?: string): ServiceAccount | null`
  - `type SheetTab = { sheetId: number; title: string; rowCount: number }`
  - `type SpreadsheetMeta = { title: string; tabs: SheetTab[] }`
  - `class GoogleError extends Error { kind: "access" | "not_found" | "rate" | "unavailable" | "bad_request" }`
  - `isTransient(e: unknown): boolean`
  - `type GoogleSheets = { readonly email: string; modifiedTime(id: string): Promise<string>; spreadsheet(id: string): Promise<SpreadsheetMeta>; values(id: string, ranges: string[]): Promise<string[][][]> }`
  - `createGoogleSheets(o: { account: ServiceAccount; endpoint?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number }): GoogleSheets`
  - `parseSheetLink(link: string): { spreadsheetId: string; gid: number | null } | null`
  - `rowsRange(tab: string, from: number, to: number): string`
- Produces, from `test/google-fake.ts`:
  - `startGoogleFake(o?: { port?: number }): Promise<GoogleFake>`
  - `type GoogleFake`, with `url`, `env` (the base64 key), `email`, `put`, `append`, `setRows`, `renameTab`, `unshare`, `share`, `remove`, `fail`, `calls` and `close`
  - `type FakeSpreadsheet = { title: string; tabs: { sheetId: number; title: string; rows: string[][] }[]; sharedWith: string[] }`

- [ ] **Step 1: Write the fake** `apps/api/test/google-fake.ts`

```ts
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the three Google endpoints LUME calls (spec 2B §11), over real HTTP: the token exchange,
 * Drive's file metadata and Sheets' metadata and values. It behaves as Google does where LUME depends
 * on it:
 * - trailing empty cells and rows are left out;
 * - an unshared file is 403 on Sheets and 404 on Drive;
 * - modifiedTime moves on every change.
 * Tests drive it through its methods; e2e drives it through /__fake/*.
 */
export type FakeTab = { sheetId: number; title: string; rows: string[][] };
export type FakeSpreadsheet = { title: string; tabs: FakeTab[]; sharedWith: string[] };
export type GoogleFake = {
  url: string;
  email: string;
  /** The service-account key file, base64, as GOOGLE_SERVICE_ACCOUNT_JSON holds it. */
  env: string;
  put(id: string, s: FakeSpreadsheet): void;
  append(id: string, tab: string, rows: string[][]): void;
  setRows(id: string, tab: string, rows: string[][]): void;
  renameTab(id: string, from: string, to: string): void;
  unshare(id: string): void;
  share(id: string): void;
  remove(id: string): void;
  /** The next `count` Google calls (not the token) answer with this HTTP status. */
  fail(status: number, count?: number): void;
  /** Every Google call's method and path, in order ("GET /v4/spreadsheets/abc"). */
  calls: string[];
  close(): Promise<void>;
};

const EMAIL = "lume-sheets@lume-test.iam.gserviceaccount.com";

export async function startGoogleFake(o: { port?: number } = {}): Promise<GoogleFake> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const sheets = new Map<string, FakeSpreadsheet & { modified: number }>();
  const tokens = new Set<string>();
  const calls: string[] = [];
  let clock = Date.parse("2026-09-27T00:00:00Z");
  let failing: { status: number; left: number } | null = null;
  let url = "";

  const touch = (id: string) => {
    const s = sheets.get(id);
    if (s) s.modified = clock += 1000;
  };
  const tabOf = (id: string, title: string) => {
    const t = sheets.get(id)?.tabs.find((x) => x.title === title);
    if (!t) throw new Error(`fake: no tab ${title} in ${id}`);
    return t;
  };
  const trimmed = (rows: string[][]) => {
    const out = rows.map((r) => {
      const c = [...r];
      while (c.length && c.at(-1) === "") c.pop();
      return c;
    });
    while (out.length && out.at(-1)!.length === 0) out.pop();
    return out;
  };
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const googleError = (res: http.ServerResponse, code: number, status: string, message: string) =>
    send(res, code, { error: { code, status, message } });
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c: Buffer) => (b += c.toString("utf8")));
      req.on("end", () => resolve(b));
    });
  // "'Tab ''x'''!5:104" → { tab: "Tab 'x'", from: 5, to: 104 }
  const parseRange = (r: string) => {
    const m = /^'((?:[^']|'')*)'!(\d+):(\d+)$/.exec(r);
    if (!m) return null;
    return { tab: m[1]!.replace(/''/g, "'"), from: Number(m[2]), to: Number(m[3]) };
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://fake");
    // Controls, for e2e (the tests in this repo call the methods directly).
    if (u.pathname.startsWith("/__fake/")) {
      const body = req.method === "GET" ? {} : (JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>);
      const [, , what, id, action] = u.pathname.split("/");
      if (what === "key") return send(res, 200, { env: api.env, email: EMAIL });
      if (what === "fail") {
        api.fail(Number(body.status), Number(body.count ?? 1));
        return send(res, 200, {});
      }
      if (what === "spreadsheets" && id) {
        if (!action) api.put(id, body as unknown as FakeSpreadsheet);
        else if (action === "append") api.append(id, String(body.tab), body.rows as string[][]);
        else if (action === "rows") api.setRows(id, String(body.tab), body.rows as string[][]);
        else if (action === "unshare") api.unshare(id);
        else if (action === "share") api.share(id);
        return send(res, 200, {});
      }
      return send(res, 404, {});
    }
    if (u.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const [h, c, sig] = (form.get("assertion") ?? "").split(".");
      const ok =
        !!h &&
        !!c &&
        !!sig &&
        verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, "base64url"));
      const claims = ok ? (JSON.parse(Buffer.from(c!, "base64url").toString("utf8")) as { iss?: string }) : {};
      if (!ok || claims.iss !== EMAIL) return send(res, 400, { error: "invalid_grant" });
      const token = randomBytes(16).toString("hex");
      tokens.add(token);
      return send(res, 200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
    }
    calls.push(`${req.method} ${u.pathname}`);
    if (!tokens.has((req.headers.authorization ?? "").replace(/^Bearer /, "")))
      return googleError(res, 401, "UNAUTHENTICATED", "Request had invalid authentication credentials.");
    if (failing && failing.left > 0) {
      failing.left--;
      return googleError(res, failing.status, failing.status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE", "fake failure");
    }
    const drive = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (drive) {
      const s = sheets.get(decodeURIComponent(drive[1]!));
      if (!s || !s.sharedWith.includes(EMAIL)) return googleError(res, 404, "NOT_FOUND", "File not found.");
      return send(res, 200, { modifiedTime: new Date(s.modified).toISOString() });
    }
    const meta = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(u.pathname);
    const values = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchGet$/.exec(u.pathname);
    const id = decodeURIComponent((meta ?? values)?.[1] ?? "");
    const s = sheets.get(id);
    if (!meta && !values) return googleError(res, 404, "NOT_FOUND", "Unknown path.");
    if (!s) return googleError(res, 404, "NOT_FOUND", "Requested entity was not found.");
    if (!s.sharedWith.includes(EMAIL)) return googleError(res, 403, "PERMISSION_DENIED", "The caller does not have permission");
    if (meta)
      return send(res, 200, {
        properties: { title: s.title },
        sheets: s.tabs.map((t) => ({
          properties: { sheetId: t.sheetId, title: t.title, gridProperties: { rowCount: Math.max(1000, t.rows.length) } },
        })),
      });
    const valueRanges = [];
    for (const r of u.searchParams.getAll("ranges")) {
      const p = parseRange(r);
      const tab = p && s.tabs.find((t) => t.title === p.tab);
      if (!p || !tab) return googleError(res, 400, "INVALID_ARGUMENT", `Unable to parse range: ${r}`);
      const rows = trimmed(tab.rows.slice(p.from - 1, p.to));
      valueRanges.push({ range: r, majorDimension: "ROWS", ...(rows.length ? { values: rows } : {}) });
    }
    return send(res, 200, { spreadsheetId: id, valueRanges });
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const api: GoogleFake = {
    url,
    email: EMAIL,
    env: Buffer.from(
      JSON.stringify({ type: "service_account", client_email: EMAIL, private_key: pem, token_uri: `${url}/token` }),
    ).toString("base64"),
    put(id, s) {
      sheets.set(id, { ...structuredClone(s), modified: (clock += 1000) });
    },
    append(id, tab, rows) {
      tabOf(id, tab).rows.push(...structuredClone(rows));
      touch(id);
    },
    setRows(id, tab, rows) {
      tabOf(id, tab).rows = structuredClone(rows);
      touch(id);
    },
    renameTab(id, from, to) {
      tabOf(id, from).title = to;
      touch(id);
    },
    unshare(id) {
      const s = sheets.get(id);
      if (s) s.sharedWith = s.sharedWith.filter((e) => e !== EMAIL);
    },
    share(id) {
      const s = sheets.get(id);
      if (s && !s.sharedWith.includes(EMAIL)) s.sharedWith.push(EMAIL);
    },
    remove(id) {
      sheets.delete(id);
    },
    fail(status, count = 1) {
      failing = { status, left: count };
    },
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  return api;
}
```

- [ ] **Step 2: Write the failing client tests** `apps/api/src/modules/sheets/google.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGoogleFake, type GoogleFake } from "../../../test/google-fake";
import {
  GoogleError,
  createGoogleSheets,
  isTransient,
  parseServiceAccount,
  parseSheetLink,
  rowsRange,
  type GoogleSheets,
} from "./google";

let fake: GoogleFake;
let g: GoogleSheets;
const slept: number[] = [];
beforeAll(async () => {
  fake = await startGoogleFake();
  g = createGoogleSheets({
    account: parseServiceAccount(fake.env)!,
    endpoint: fake.url,
    sleep: async (ms) => void slept.push(ms),
  });
  fake.put("s1", {
    title: "Website enquiries",
    sharedWith: [fake.email],
    tabs: [
      { sheetId: 0, title: "Form responses", rows: [["Name", "Phone"], ["Aisha Khan", "0501234567", ""], [], ["Omar", "0502223333"]] },
      { sheetId: 77, title: "Q3 'West'", rows: [["Name"], ["Lina"]] },
    ],
  });
});
afterAll(() => fake.close());

describe("the Google client", () => {
  it("reads the spreadsheet's tabs, by id and title", async () => {
    expect(await g.spreadsheet("s1")).toEqual({
      title: "Website enquiries",
      tabs: [
        { sheetId: 0, title: "Form responses", rowCount: 1000 },
        { sheetId: 77, title: "Q3 'West'", rowCount: 1000 },
      ],
    });
    expect(g.email).toBe(fake.email);
  });

  it("reads several ranges in one call, as Google formats them (trailing blanks left out)", async () => {
    const [head, body, west] = await g.values("s1", [
      rowsRange("Form responses", 1, 1),
      rowsRange("Form responses", 2, 5001),
      rowsRange("Q3 'West'", 2, 2),
    ]);
    expect(head).toEqual([["Name", "Phone"]]);
    expect(body).toEqual([["Aisha Khan", "0501234567"], [], ["Omar", "0502223333"]]);
    expect(west).toEqual([["Lina"]]);
  });

  it("modifiedTime moves when the sheet changes; the token is fetched once and reused", async () => {
    const before = await g.modifiedTime("s1");
    fake.append("s1", "Form responses", [["Zoe", "0504445555"]]);
    const after = await g.modifiedTime("s1");
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it("an unshared sheet is an access error; a missing one is not_found", async () => {
    fake.put("private", { title: "P", sharedWith: [], tabs: [{ sheetId: 0, title: "A", rows: [["x"]] }] });
    await expect(g.spreadsheet("private")).rejects.toMatchObject({ kind: "access" });
    await expect(g.modifiedTime("private")).rejects.toMatchObject({ kind: "not_found" });
    await expect(g.spreadsheet("nope")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("retries 429 and 5xx with backoff, then gives up as rate or unavailable (transient)", async () => {
    slept.length = 0;
    fake.fail(429, 2);
    await expect(g.spreadsheet("s1")).resolves.toMatchObject({ title: "Website enquiries" });
    expect(slept).toEqual([1000, 2000]);
    fake.fail(503, 4);
    const e = await g.spreadsheet("s1").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GoogleError);
    expect((e as GoogleError).kind).toBe("unavailable");
    expect(isTransient(e)).toBe(true);
    expect(isTransient(new GoogleError("access", "x"))).toBe(false);
  });

  it("a broken key is refused as access, not retried forever", async () => {
    const bad = createGoogleSheets({
      account: { ...parseServiceAccount(fake.env)!, clientEmail: "someone-else@x.iam.gserviceaccount.com" },
      endpoint: fake.url,
      sleep: async () => undefined,
    });
    await expect(bad.spreadsheet("s1")).rejects.toMatchObject({ kind: "access" });
  });
});

describe("links and ranges", () => {
  it("parses a sheet's link, its gid, or a bare id", () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=77`)).toEqual({ spreadsheetId: id, gid: 77 });
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing&gid=0`)).toEqual({ spreadsheetId: id, gid: 0 });
    expect(parseSheetLink(`  ${id}  `)).toEqual({ spreadsheetId: id, gid: null });
    expect(parseSheetLink("https://example.com/not-a-sheet")).toBeNull();
    expect(parseSheetLink("")).toBeNull();
  });
  it("quotes a tab title, doubling its apostrophes", () => {
    expect(rowsRange("Q3 'West'", 5, 104)).toBe("'Q3 ''West'''!5:104");
  });
  it("parseServiceAccount reads the key file, or returns null", () => {
    expect(parseServiceAccount(undefined)).toBeNull();
    expect(parseServiceAccount("not base64 json")).toBeNull();
    expect(parseServiceAccount(fake.env)).toMatchObject({ clientEmail: fake.email, tokenUri: `${fake.url}/token` });
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/sheets/google.test.ts'`
Expected: FAIL, `Cannot find module './google'`.

- [ ] **Step 4: Implement** `apps/api/src/modules/sheets/google.ts`

```ts
import { createSign } from "node:crypto";

/** The key file Google issues for a service account, as LUME needs it. */
export type ServiceAccount = { clientEmail: string; privateKey: string; tokenUri: string };
export type SheetTab = { sheetId: number; title: string; rowCount: number };
export type SpreadsheetMeta = { title: string; tabs: SheetTab[] };
export type GoogleErrorKind = "access" | "not_found" | "rate" | "unavailable" | "bad_request";

export class GoogleError extends Error {
  constructor(
    readonly kind: GoogleErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}
/** A failure that passes on its own (Google busy or out of quota): try again later, don't pause the sheet. */
export const isTransient = (e: unknown): boolean =>
  e instanceof GoogleError && (e.kind === "rate" || e.kind === "unavailable");

/** What LUME asks of Google: read-only, one spreadsheet at a time. */
export type GoogleSheets = {
  readonly email: string;
  modifiedTime(spreadsheetId: string): Promise<string>;
  spreadsheet(spreadsheetId: string): Promise<SpreadsheetMeta>;
  /** Each A1 range's rows as Google formats them: trailing empty cells and rows are left out. */
  values(spreadsheetId: string, ranges: string[]): Promise<string[][][]>;
};

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
].join(" ");
const RETRIES = [1000, 2000, 4000];

export function parseServiceAccount(b64: string | undefined): ServiceAccount | null {
  if (!b64) return null;
  try {
    const j = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
    if (typeof j.client_email !== "string" || typeof j.private_key !== "string") return null;
    return {
      clientEmail: j.client_email,
      privateKey: j.private_key,
      tokenUri: typeof j.token_uri === "string" ? j.token_uri : "https://oauth2.googleapis.com/token",
    };
  } catch {
    return null;
  }
}

/** A sheet's link (or its bare id) → the spreadsheet id, and the tab it pointed at when it says. */
export function parseSheetLink(link: string): { spreadsheetId: string; gid: number | null } | null {
  const text = link.trim();
  const inUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/.exec(text);
  const bare = /^[A-Za-z0-9_-]{25,}$/.test(text) ? text : null;
  const spreadsheetId = inUrl?.[1] ?? bare;
  if (!spreadsheetId) return null;
  const gid = /[#?&]gid=(\d+)/.exec(text);
  return { spreadsheetId, gid: gid ? Number(gid[1]) : null };
}

/** Whole rows `from`..`to` of one tab, in A1 notation, the title quoted as Google requires. */
export const rowsRange = (tab: string, from: number, to: number): string =>
  `'${tab.replace(/'/g, "''")}'!${from}:${to}`;

const b64url = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");

export function createGoogleSheets(o: {
  account: ServiceAccount;
  endpoint?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): GoogleSheets {
  const http = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const sheetsBase = o.endpoint ?? "https://sheets.googleapis.com";
  const driveBase = o.endpoint ?? "https://www.googleapis.com";
  let token: { value: string; until: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && now() < token.until) return token.value;
    const iat = Math.floor(now() / 1000);
    const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
      iss: o.account.clientEmail,
      scope: SCOPES,
      aud: o.account.tokenUri,
      iat,
      exp: iat + 3600,
    })}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(o.account.privateKey, "base64url");
    let res: Response;
    try {
      res = await http(o.account.tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${unsigned}.${sig}`,
        }),
      });
    } catch {
      throw new GoogleError("unavailable", "LUME couldn't reach Google.");
    }
    if (res.status >= 500) throw new GoogleError("unavailable", "Google's sign-in service is unavailable.");
    if (!res.ok) throw new GoogleError("access", "Google refused LUME's service-account key.");
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: j.access_token, until: now() + (j.expires_in - 60) * 1000 };
    return token.value;
  }

  async function call<T>(url: string): Promise<T> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await http(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
      } catch (e) {
        if (e instanceof GoogleError) throw e;
        res = null; // the network failed: treated like a 503
      }
      if (res?.ok) return (await res.json()) as T;
      const status = res?.status ?? 503;
      if (status === 401 && !refreshed) {
        refreshed = true;
        token = null;
        attempt--;
        continue;
      }
      if ((status === 429 || status >= 500) && attempt < RETRIES.length) {
        await sleep(RETRIES[attempt]!);
        continue;
      }
      const body = res ? ((await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } }) : {};
      const message = body.error?.message ?? `Google answered ${status}.`;
      if (status === 429 || body.error?.status === "RESOURCE_EXHAUSTED") throw new GoogleError("rate", message);
      if (status >= 500) throw new GoogleError("unavailable", message);
      if (status === 404) throw new GoogleError("not_found", message);
      if (status === 401 || status === 403) throw new GoogleError("access", message);
      throw new GoogleError("bad_request", message);
    }
  }

  const enc = encodeURIComponent;
  return {
    email: o.account.clientEmail,
    async modifiedTime(id) {
      const j = await call<{ modifiedTime: string }>(
        `${driveBase}/drive/v3/files/${enc(id)}?fields=modifiedTime&supportsAllDrives=true`,
      );
      return j.modifiedTime;
    },
    async spreadsheet(id) {
      const j = await call<{
        properties: { title: string };
        sheets: { properties: { sheetId: number; title: string; gridProperties?: { rowCount?: number } } }[];
      }>(
        `${sheetsBase}/v4/spreadsheets/${enc(id)}?fields=${enc("properties.title,sheets.properties(sheetId,title,gridProperties.rowCount)")}`,
      );
      return {
        title: j.properties.title,
        tabs: j.sheets.map((s) => ({
          sheetId: s.properties.sheetId,
          title: s.properties.title,
          rowCount: s.properties.gridProperties?.rowCount ?? 0,
        })),
      };
    },
    async values(id, ranges) {
      const qs = ranges.map((r) => `ranges=${enc(r)}`).join("&");
      const j = await call<{ valueRanges?: { values?: unknown[][] }[] }>(
        `${sheetsBase}/v4/spreadsheets/${enc(id)}/values:batchGet?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&${qs}`,
      );
      return ranges.map((_, i) => (j.valueRanges?.[i]?.values ?? []).map((row) => row.map((c) => String(c ?? ""))));
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: the Step 3 command. Expected: PASS (11 tests).

- [ ] **Step 6: Gate and commit**

Message: `feat(api): a read-only Google Sheets client with its own service-account sign-in, tested against a fake Google`, with the trailer.

---
### Task 4: One row engine for imports and sheets (`writeRow`)

A refactor: the CSV importer keeps behaving exactly as it does, and every 2A test stays green. The per-row decision (map → safety net → lock → match → create, merge or skip) moves out of `runner.ts` into `row.ts`, so the sheet sync can call the same code.

**Files:**
- Create: `apps/api/src/modules/imports/row.ts`
- Modify: `apps/api/src/modules/imports/runner.ts`
- Test: `apps/api/src/modules/imports/row.test.ts` (new); the existing `run.test.ts` and `acceptance.test.ts` stay unchanged and green

**Interfaces:**
- Produces, from `row.ts`:
  - `type RowCounter = "created" | "merged" | "skipped" | "empty" | "errors" | "warnings" | "name_from_contact" | "missing_stage_fields" | "phone_needs_country"`
  - `type RowResult = { result: "created" | "merged" | "skipped" | "error"; leadId: string | null; problems: Issue[]; warnings: Issue[]; alsoMatched: string[]; draft: LeadDraft | null; counters: Partial<Record<RowCounter, number>> }`
  - `type RowInput = { sourceId: string; rules: Rules; mapping: Mapping; ctx: FullMapContext; cells: string[]; origin: Record<string, unknown>; nextTurn: () => Promise<number> }`
  - `writeRow(req: FastifyRequest, o: RowInput): Promise<RowResult>`
- Produces, from `runner.ts` (newly exported): `isDataError(e: unknown): boolean`, `refusalReason(e: unknown): string` and `givesAway(rules: Rules, mapping: Mapping, actor: ActorRecord): boolean`. The new `givesAway` signature takes rules and mapping instead of the import row.

- [ ] **Step 1: Write the failing test** `apps/api/src/modules/imports/row.test.ts`

This drives `writeRow` directly, inside a job request, as the sheet sync will.

```ts
import { ALL_GRANTS, DEFAULT_RULES, type Mapping } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { loadMapContext } from "./context";
import { withJobRequest } from "./job-request";
import { writeRow } from "./row";

let h: Harness;
let userId: string;
beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  userId = await h.seedUser({ grants: ALL_GRANTS, totp: true });
});
afterAll(async () => h.close());

const mapping: Mapping = {
  columns: [
    { column: 0, to: "field", field: "name" },
    { column: 1, to: "field", field: "phone" },
  ],
  createMissingTags: false,
};

describe("writeRow", () => {
  it("creates, then merges the same contact, recording where each came from", async () => {
    const actor = (await h.actorOf(userId))!;
    const [{ id: pipelineId }] = await h.queryAll<{ id: string }>("SELECT id FROM pipelines WHERE is_default");
    const [{ id: stageId }] = await h.queryAll<{ id: string }>(
      "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position LIMIT 1",
      [pipelineId],
    );
    const [{ id: sourceId }] = await h.queryAll<{ id: string }>(
      "INSERT INTO lead_sources (id, type, name, status) VALUES (gen_random_uuid(), 'google_sheet', 'Enquiries', 'active') RETURNING id",
    );
    const rules = DEFAULT_RULES({ pipelineId, stageId, country: "AE" });
    let turn = 0;
    const run = (cells: string[], row: number) =>
      withJobRequest({ app: h.app, pool: h.pool, actor, requestId: `t:${row}`, allLeads: true }, async (req) => {
        const ctx = await loadMapContext(req, { pipelineId, headerCount: 2 });
        return writeRow(req, {
          sourceId,
          rules,
          mapping,
          ctx,
          cells,
          origin: { sourceId, sheet: "Enquiries", row },
          nextTurn: async () => turn++,
        });
      });
    const a = await run(["Row Writer", "0507778888"], 2);
    expect(a).toMatchObject({ result: "created", counters: { created: 1 } });
    expect(a.draft?.phone.e164).toBe("+971507778888");
    const b = await run(["Row Writer again", "+971 50 777 8888"], 9);
    expect(b).toMatchObject({ result: "merged", leadId: a.leadId, counters: { merged: 1 } });
    const acts = await h.queryAll<{ type: string; payload: Record<string, unknown> }>(
      "SELECT type, payload FROM activities WHERE lead_id = $1 ORDER BY created_at",
      [a.leadId],
    );
    expect(acts.find((x) => x.type === "imported")?.payload).toMatchObject({ sheet: "Enquiries", row: 2 });
    expect(acts.find((x) => x.type === "imported_again")?.payload).toMatchObject({ sheet: "Enquiries", row: 9 });
    const c = await run(["", ""], 10);
    expect(c).toMatchObject({ result: "skipped", counters: { empty: 1 }, draft: null });
  });
});
```

`h.app`, `h.pool`, `h.actorOf` and `h.queryAll` exist on the 2A harness. If `h.app` isn't exposed yet, add `app` to the `Harness` type and the returned object (`app,`). The harness already builds it.

- [ ] **Step 2: Run it and watch it fail**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/imports/row.test.ts'`
Expected: FAIL, `Cannot find module './row'`.

- [ ] **Step 3: Create** `apps/api/src/modules/imports/row.ts`

This is the body of the old `oneRow`, without the `import_rows` bookkeeping. The logic is unchanged line for line, except that:
- `save(...)` becomes a returned `RowResult`;
- the activity payload starts from `origin`;
- the round-robin turn comes from `nextTurn()`.

```ts
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { mapRow, startOfDayUtc, type Issue, type LeadDraft, type Mapping, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import { loadFieldRegistry } from "../../leads/fields";
import { insertLead, mergeFill, mergeIntoLead } from "../leads/writer";
import { contactProbes, findMatches, type FullMapContext } from "./context";

export type RowCounter =
  | "created"
  | "merged"
  | "skipped"
  | "empty"
  | "errors"
  | "warnings"
  | "name_from_contact"
  | "missing_stage_fields"
  | "phone_needs_country";
export type RowResult = {
  result: "created" | "merged" | "skipped" | "error";
  leadId: string | null;
  problems: Issue[];
  warnings: Issue[];
  alsoMatched: string[];
  /** The row as a lead, when it read as one (null for an empty row or one mapRow refused). */
  draft: LeadDraft | null;
  counters: Partial<Record<RowCounter, number>>;
};
export type RowInput = {
  sourceId: string;
  rules: Rules;
  mapping: Mapping;
  ctx: FullMapContext;
  cells: string[];
  /** Where the lead's history says it came from: { importId, file, row } or { sourceId, sheet, row }. */
  origin: Record<string, unknown>;
  /** The next turn in round-robin ownership, from a counter the caller's run keeps. */
  nextTurn: () => Promise<number>;
};

/** A transaction-scoped lock on one contact key (its first 64 bits), so two runs can't both create it. */
const lockContact = (hex: string) =>
  sql`SELECT pg_advisory_xact_lock(('x' || ${hex.slice(0, 16)})::bit(64)::bigint)`;
const warned = (w: Issue[]) => (w.length ? 1 : 0);

/**
 * Spec 2A §6.9–§6.10 for one row, inside the caller's transaction (every lead visible, acting as the
 * person the run belongs to): map → check → lock the contacts → match → create, merge or skip.
 */
export async function writeRow(req: FastifyRequest, o: RowInput): Promise<RowResult> {
  const { rules, mapping, ctx, cells } = o;
  const out = (
    result: RowResult["result"],
    f: Partial<Omit<RowResult, "result" | "counters">>,
    counters: RowResult["counters"],
  ): RowResult => ({
    result,
    leadId: f.leadId ?? null,
    problems: f.problems ?? [],
    warnings: f.warnings ?? [],
    alsoMatched: f.alsoMatched ?? [],
    draft: f.draft ?? null,
    counters,
  });

  const outcome = mapRow(cells, mapping, rules, ctx);
  if (outcome.kind === "empty")
    return out("skipped", { problems: [{ column: null, code: "EMPTY_ROW", message: "Empty row" }] }, { empty: 1 });
  if (outcome.kind === "error")
    return out(
      "error",
      { problems: outcome.problems, warnings: outcome.warnings },
      { errors: 1, warnings: warned(outcome.warnings) },
    );

  const draft = outcome.draft;
  const warnings = [...outcome.warnings];
  // A safety net behind mapRow: the field registry's own create schema, exactly as a hand-made lead meets it.
  const custom = (await loadFieldRegistry(req)).custom.create.safeParse(draft.custom);
  if (!custom.success)
    return out(
      "error",
      {
        draft,
        warnings,
        problems: custom.error.issues.map((i) => ({
          column: null,
          code: "INVALID_FIELD",
          message: `${i.path.join(".")}: ${i.message}`,
        })),
      },
      { errors: 1, warnings: warned(warnings) },
    );
  const customData = custom.data as Record<string, unknown>;

  for (const p of contactProbes(draft, rules.matchOn).sort((a, b) => a.hash.localeCompare(b.hash)))
    await req.db.execute(lockContact(p.hash));
  const matches = rules.matchOn.length ? await findMatches(req, draft, rules.matchOn) : [];
  const contact = {
    phoneRaw: draft.phone.raw,
    phoneE164: draft.phone.e164,
    phoneCountryIso: draft.phone.countryIso,
    phoneStatus: draft.phone.status,
    email: draft.email,
    instagramHandle: draft.instagram,
  };
  const also = matches.slice(1).map((m) => m.leadId);

  if (matches.length && rules.onMatch !== "duplicate") {
    const target = matches[0]!.leadId;
    if (rules.onMatch === "skip")
      return out(
        "skipped",
        {
          draft,
          leadId: target,
          warnings,
          alsoMatched: also,
          problems: [{ column: null, code: "MATCHED_SKIPPED", message: "Matches an existing lead; skipped." }],
        },
        { skipped: 1, warnings: warned(warnings) },
      );
    const [lead] = await req.db.select().from(schema.leads).where(eq(schema.leads.id, target));
    const tagIds = (
      await req.db
        .select({ id: schema.leadTags.tagId })
        .from(schema.leadTags)
        .where(eq(schema.leadTags.leadId, target))
    ).map((t) => t.id);
    // A merge takes an owner only from the row's owner column; the owner rule is for leads it creates.
    const { fill, filled } = mergeFill(
      lead!,
      {
        contact,
        value: draft.value,
        leadCreatedAt: draft.leadCreatedAt,
        ownerId: draft.ownerId ?? null,
        custom: customData,
        tagIds: draft.tagIds,
      },
      tagIds,
      rules.reopenClosedTo,
    );
    await mergeIntoLead(req, lead!, fill, {
      type: "imported_again",
      payload: { ...o.origin, filled, extraPhones: draft.extraPhones, warnings: warnings.map((w) => w.code) },
    });
    return out(
      "merged",
      { draft, leadId: target, warnings, alsoMatched: also },
      { merged: 1, warnings: warned(warnings) },
    );
  }

  // Create: the owner from the row, else the owner rule (turn-taking in a fixed order: by name, then id).
  let ownerId: string | null = draft.ownerId ?? null;
  if (draft.ownerId === undefined) {
    if (rules.owner.mode === "user") {
      const chosen = rules.owner.userId;
      ownerId = ctx.people.find((p) => p.id === chosen && p.active)?.id ?? null;
      if (!ownerId)
        warnings.push({
          column: null,
          code: "OWNER_RULE_INACTIVE",
          message: "The chosen owner can't take leads now; left unassigned.",
        });
    } else if (rules.owner.mode === "round_robin") {
      const ids = rules.owner.userIds;
      const turns = ctx.people
        .filter((p) => p.active && ids.includes(p.id))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      if (!turns.length)
        warnings.push({
          column: null,
          code: "OWNER_RULE_INACTIVE",
          message: "Nobody chosen to take turns can take leads now; left unassigned.",
        });
      else ownerId = turns[(await o.nextTurn()) % turns.length]!.id;
    }
  }
  const stageId = draft.stageId ?? rules.stageId;
  const stage = ctx.stagesFull.find((s) => s.id === stageId);
  if (!stage)
    return out(
      "error",
      {
        draft,
        warnings,
        problems: [{ column: null, code: "STAGE_GONE", message: "The stage for new leads no longer exists." }],
      },
      { errors: 1, warnings: warned(warnings) },
    );
  // The lead's own date, when the row has one, is when it entered its stage (and closed, if closed).
  const origin = draft.leadCreatedAt ? startOfDayUtc(draft.leadCreatedAt, ctx.timezone) : null;
  const leadId = await insertLead(req, {
    pipelineId: rules.pipelineId,
    stageId,
    ownerId,
    name: draft.name,
    contact,
    value: draft.value,
    productId: null,
    leadCreatedAt: draft.leadCreatedAt,
    custom: customData,
    tagIds: draft.tagIds,
    sourceId: o.sourceId,
    lostReasonId: draft.lostReasonId,
    closedAt: stage.kind === "open" ? null : (origin ?? new Date()),
    stageKind: stage.kind,
    stageEnteredAt: origin ?? new Date(),
    activity: {
      type: "imported",
      payload: { ...o.origin, extraPhones: draft.extraPhones, warnings: warnings.map((w) => w.code) },
    },
    assignReason: "imported",
  });
  // A stage's required fields aren't enforced on import (2A spec §6.5), but the leads missing them are counted.
  const core: Record<string, unknown> = {
    name: draft.name,
    phone: draft.phone.raw,
    email: draft.email,
    instagram: draft.instagram,
    value: draft.value,
    lead_created_at: draft.leadCreatedAt,
    owner: ownerId,
    stage: stageId,
    source: o.sourceId,
  };
  const filledIds = new Set(
    ctx.fields
      .filter((f) => {
        const v = f.isCore ? core[f.key] : customData[f.key];
        return v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length);
      })
      .map((f) => f.id),
  );
  const missing = stage.requiredFieldIds.some((id) => !filledIds.has(id));
  if (missing)
    warnings.push({
      column: null,
      code: "MISSING_STAGE_FIELDS",
      message: `${stage.name} asks for fields this lead doesn't have yet.`,
    });
  return out(
    "created",
    { draft, leadId, warnings, alsoMatched: also },
    {
      created: 1,
      warnings: warned(warnings),
      name_from_contact: draft.nameFromContact ? 1 : 0,
      phone_needs_country: draft.phone.status === "needs_country" ? 1 : 0,
      missing_stage_fields: missing ? 1 : 0,
    },
  );
}
```

- [ ] **Step 4: Make `runner.ts` use it**

In `runner.ts`:
- Delete `lockContact`, `type Counter`, `type Saved`, and everything in `oneRow` after the claim.
- Remove the imports that are now unused: `mapRow`, `startOfDayUtc`, `Issue`, `insertLead`, `mergeFill`, `mergeIntoLead`, `loadFieldRegistry`, `contactProbes`, `findMatches`.
- Export `isDataError`, and move the reason text out of `refuseRow` into an exported `refusalReason`.
- Replace `givesAway` with the version below, and update its one call site in `runRows` to `givesAway(imp.rules as Rules, imp.mapping as Mapping, actor)`.
- Add `import { writeRow } from "./row";`.

```ts
/** Does this run give leads to people other than the person it runs as? Then it needs leads.assign too. */
export function givesAway(rules: Rules, mapping: Mapping, actor: ActorRecord): boolean {
  return (
    rules.owner.mode === "round_robin" ||
    (rules.owner.mode === "user" && rules.owner.userId !== actor.userId) ||
    mapping.columns.some((c) => c.to === "field" && c.field === "owner")
  );
}

/** Why the database refused a row, in a line short enough for a report. */
export const refusalReason = (e: unknown): string =>
  String((e as { cause?: { message?: unknown } })?.cause?.message ?? (e as Error)?.message ?? e).slice(0, 200);
```

In `refuseRow`, replace the `reason` computation with `const reason = refusalReason(e);`.

The new `oneRow`:

```ts
/** Claim the row, write it through the shared engine (row.ts), record its result and the counts. */
async function oneRow(
  req: FastifyRequest,
  keyring: Keyring,
  run: Run,
  ctx: FullMapContext,
  cells: string[],
  rowNumber: number,
) {
  const { imp, rules, mapping } = run;
  const [claimed] = await req.db
    .insert(R)
    .values({
      importId: imp.id,
      rowIndex: rowNumber,
      result: "pending",
      rawEnc: keyring.encrypt(JSON.stringify(cells), `import-row:${imp.id}:${rowNumber}`),
    })
    .onConflictDoNothing()
    .returning({ id: R.id });
  if (!claimed) return; // an earlier attempt already finished this row

  const r = await writeRow(req, {
    sourceId: imp.sourceId,
    rules,
    mapping,
    ctx,
    cells,
    origin: { importId: imp.id, file: imp.fileName, row: rowNumber },
    nextTurn: async () => {
      const { rows } = await req.db.execute<{ n: number }>(
        sql`UPDATE imports SET rr_cursor = rr_cursor + 1 WHERE id = ${imp.id} RETURNING rr_cursor - 1 AS n`,
      );
      return Number(rows[0]!.n);
    },
  });
  await req.db
    .update(R)
    .set({
      result: r.result,
      leadId: r.leadId,
      problems: r.problems,
      warnings: r.warnings,
      alsoMatched: r.alsoMatched,
      // Only a row that became (or matched) a lead has a person to recognise again.
      fingerprint: r.draft && r.result !== "error" ? fingerprint(r.draft, cells) : null,
    })
    .where(eq(R.id, claimed.id));
  const sets = Object.entries(r.counters)
    .filter(([, n]) => n)
    .map(([k, n]) => sql`${sql.identifier(k)} = ${sql.identifier(k)} + ${n}`);
  await req.db.execute(
    sql`UPDATE imports SET ${sql.join([...sets, sql`cursor_row = GREATEST(cursor_row, ${rowNumber})`], sql`, `)} WHERE id = ${imp.id}`,
  );
}
```

The fingerprint semantics are unchanged. Before, a fingerprint was set for skipped-matched, merged and created rows only. Now it is set exactly when `draft` exists and the result isn't `error`, which is the same set: `INVALID_FIELD` and `STAGE_GONE` return `error`.

- [ ] **Step 5: Run the new test and every import test**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/imports'`
Expected: PASS. That is the new `row.test.ts` plus every existing import test (run, imports, acceptance, queue, job-request), unchanged.

- [ ] **Step 6: Gate and commit**

Message: `refactor(api): one row engine (writeRow) for imports now and sheets next — imports behave exactly as before`, with the trailer.

---

### Task 5: Reading a sheet as rows (`grid.ts`)

These are pure functions with no I/O. They cover:
- turning Google's rows into numbered rows, and a grid into the CSV snapshot a draft reads;
- telling a renamed column from a new one;
- recognising a row again, and noticing that rows moved.

**Files:**
- Create: `apps/api/src/modules/sheets/grid.ts`
- Modify: `packages/core/src/intake/read.ts` (export `nameHeaders`)
- Test: `apps/api/src/modules/sheets/grid.test.ts`

**Interfaces:**
- Consumes: `LeadDraft`, `Mapping` and `readCsv` from `@lume/core`.
- Produces:
  - `type SheetRow = { number: number; cells: string[] }`
  - `isBlank(cells: string[]): boolean`
  - `toRows(raw: string[][], firstNumber: number, width: number): SheetRow[]`: blank rows are dropped, but every kept row keeps its own sheet row number; cells are padded or cut to `width`.
  - `type Drift = { broken: { column: number; was: string; now: string | null }[]; added: string[] }`
  - `headerDrift(saved: string[], now: string[], mapping: Mapping): Drift`
  - `anchorHash(header: string[], first: string[] | undefined, tail: string[] | undefined): string`
  - `sheetFingerprint(cells: string[], mapping: Mapping): string`: from raw cells only, so it never depends on today's fields, tags or rules.
  - `gridToCsv(rows: string[][]): string`

- [ ] **Step 1: Write the failing tests** `apps/api/src/modules/sheets/grid.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { readCsv, type Mapping } from "@lume/core";
import { anchorHash, gridToCsv, headerDrift, isBlank, sheetFingerprint, toRows } from "./grid";

const mapping: Mapping = {
  columns: [
    { column: 0, to: "field", field: "lead_created_at" },
    { column: 1, to: "field", field: "name" },
    { column: 2, to: "field", field: "phone" },
    { column: 3, to: "ignore" },
  ],
  createMissingTags: false,
};

describe("toRows (Review Focus 1)", () => {
  it("pads short rows, cuts long ones, skips blank rows but keeps every row's own number", () => {
    const rows = toRows([["a", "b"], [], ["", "  "], ["c"], ["d", "e", "f", "g"]], 5, 3);
    expect(rows).toEqual([
      { number: 5, cells: ["a", "b", ""] },
      { number: 8, cells: ["c", "", ""] },
      { number: 9, cells: ["d", "e", "f"] },
    ]);
    expect(isBlank(["", " "])).toBe(true);
  });
});

describe("headerDrift (Review Focus 4)", () => {
  const saved = ["Timestamp", "Full name", "Phone", "Notes"];
  it("case and spacing aren't a rename", () => {
    expect(headerDrift(saved, [" timestamp", "FULL  NAME", "phone ", "Notes"], mapping)).toEqual({ broken: [], added: [] });
  });
  it("a mapped column renamed or removed is broken; an ignored one renamed is not", () => {
    expect(headerDrift(saved, ["Timestamp", "Name", "Phone", "Remarks"], mapping)).toEqual({
      broken: [{ column: 1, was: "Full name", now: "Name" }],
      added: [],
    });
    expect(headerDrift(saved, ["Timestamp", "Full name"], mapping).broken).toEqual([{ column: 2, was: "Phone", now: null }]);
  });
  it("a column inserted before mapped ones shifts them: broken, never guessed", () => {
    expect(headerDrift(saved, ["Timestamp", "Source", "Full name", "Phone", "Notes"], mapping).broken[0]).toEqual({
      column: 1,
      was: "Full name",
      now: "Source",
    });
  });
  it("new columns at the end are offered, not broken", () => {
    expect(headerDrift(saved, [...saved, "Budget", ""], mapping)).toEqual({ broken: [], added: ["Budget"] });
  });
});

describe("recognising rows", () => {
  it("a row's fingerprint is its raw date cell plus its contact cells, so a later enquiry is a new row", () => {
    const a = sheetFingerprint(["27/09/2026 10:15:02", "Aisha Khan", "0501234567", ""], mapping);
    const edited = sheetFingerprint(["27/09/2026 10:15:02", "A. Khan", " 0501234567 ", "note"], mapping);
    const later = sheetFingerprint(["27/09/2026 18:40:11", "Aisha Khan", "0501234567", ""], mapping);
    expect(edited).toBe(a); // an edited name or an unmapped note doesn't make it a new enquiry
    expect(later).not.toBe(a);
  });
  it("a row with no date or contact filled is recognised by all its cells", () => {
    const x = sheetFingerprint(["", "Only a name", "", "n"], mapping);
    expect(sheetFingerprint(["", " Only a name ", "", "n"], mapping)).toBe(x);
    expect(sheetFingerprint(["", "Another name", "", "n"], mapping)).not.toBe(x);
  });
  it("the anchor changes when the header, the first row or the last row read changes", () => {
    const base = anchorHash(["Name"], ["A"], ["Z"]);
    expect(anchorHash(["Name"], ["A"], ["Z"])).toBe(base);
    expect(anchorHash(["Name"], ["B"], ["Z"])).not.toBe(base);
    expect(anchorHash(["Name"], ["A"], ["Y"])).not.toBe(base);
    expect(anchorHash(["Name"], ["A"], undefined)).not.toBe(base);
  });
});

describe("gridToCsv", () => {
  it("round-trips through the 2A reader with row numbers intact (blank rows, quotes and line breaks included)", () => {
    const csv = gridToCsv([["Name", "Note"], ["Aisha", 'said "hi", then left'], [], ["Omar", "line one\nline two"]]);
    const r = readCsv(new TextEncoder().encode(csv), { headerRow: 1 });
    if (!r.ok) throw new Error(r.message);
    expect(r.headers).toEqual(["Name", "Note"]);
    expect(r.rows).toEqual([["Aisha", 'said "hi", then left'], ["", ""], ["Omar", "line one\nline two"]]);
    expect(r.rowNumbers).toEqual([2, 3, 4]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/sheets/grid.test.ts'`
Expected: FAIL, `Cannot find module './grid'`.

- [ ] **Step 3: Implement**

In `packages/core/src/intake/read.ts`, change `function nameHeaders(` to `export function nameHeaders(`. The sync (Task 6) names the live header row exactly as the draft's reader named it.

`apps/api/src/modules/sheets/grid.ts`:

```ts
import { createHash } from "node:crypto";
import Papa from "papaparse";
import type { Mapping } from "@lume/core";

export type SheetRow = { number: number; cells: string[] };
export type Drift = { broken: { column: number; was: string; now: string | null }[]; added: string[] };

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const norm = (s: string | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export const isBlank = (cells: string[]): boolean => cells.every((c) => c.trim() === "");

/**
 * Google's rows (trailing empty cells and rows left out) → rows as wide as the header. A blank row is
 * skipped, but every row keeps the number it has in the sheet, so "row 14" means row 14 there.
 */
export function toRows(raw: string[][], firstNumber: number, width: number): SheetRow[] {
  const out: SheetRow[] = [];
  raw.forEach((r, i) => {
    if (isBlank(r)) return;
    const cells = r.slice(0, width);
    while (cells.length < width) cells.push("");
    out.push({ number: firstNumber + i, cells });
  });
  return out;
}

/**
 * Spec §5.4. A mapped column whose header no longer matches (renamed, removed, or shifted by an inserted
 * column) is broken: LUME never guesses. Case and spacing don't count. Headers after the saved ones are
 * new columns, offered to map.
 */
export function headerDrift(saved: string[], now: string[], mapping: Mapping): Drift {
  const broken = mapping.columns
    .filter((c) => c.to !== "ignore" && norm(saved[c.column]) !== norm(now[c.column]))
    .map((c) => ({ column: c.column, was: saved[c.column] ?? "", now: now[c.column]?.trim() || null }));
  const added = now
    .slice(saved.length)
    .map((h) => h.trim())
    .filter(Boolean);
  return { broken, added };
}

/** Header, first data row and the last row read (amendment A4): if any changed, rows moved. */
export const anchorHash = (header: string[], first: string[] | undefined, tail: string[] | undefined): string =>
  sha([header.map((h) => norm(h)), first ?? null, tail ?? null]);

const IDENTITY = ["lead_created_at", "phone", "email", "instagram"] as const;

/**
 * Amendment A6. A row is recognised by the raw cells of its date column (time included) and its contact
 * columns, so editing its name or an unmapped cell doesn't make it a new enquiry. It is read from the
 * cells alone, never from the mapped lead, so a change to fields, tags or rules can't make an old row
 * look new. A row with none of those filled is recognised by all its cells.
 */
export function sheetFingerprint(cells: string[], mapping: Mapping): string {
  const identity = IDENTITY.map((key) => {
    const c = mapping.columns.find((x) => x.to === "field" && x.field === key);
    return c ? (cells[c.column] ?? "").trim().toLowerCase() : "";
  });
  if (identity.some(Boolean)) return sha(["lead", ...identity]);
  return sha(["cells", ...cells.map((c) => c.trim())]);
}

/** A grid as the CSV a draft import reads (UTF-8, commas), so Columns, Rules and Preview work unchanged. */
export const gridToCsv = (rows: string[][]): string =>
  Papa.unparse(
    rows.map((r) => (r.length ? r : [""])),
    { newline: "\n" },
  );
```

If `papaparse` is not already an `@lume/api` dependency, add it with the same versions as `packages/core`: `bash scripts/dev.sh add --filter @lume/api papaparse @types/papaparse`.

- [ ] **Step 4: Run the tests**

Run: the Step 2 command. Expected: PASS (9 tests).

- [ ] **Step 5: Gate and commit**

Message: `feat(api): read a sheet as numbered rows, tell a renamed column from a new one, and recognise a row again`, with the trailer.

---
### Task 6: The sync engine — `requestSync` and `runSync`

**Files:**
- Create: `apps/api/src/modules/sheets/config.ts`, `apps/api/src/modules/sheets/requests.ts`, `apps/api/src/modules/sheets/sync.ts`
- Modify: `apps/api/src/app.ts` (the `AppDeps` fields only), `apps/api/test/harness.ts`, `apps/api/src/modules/imports/start.ts` (export `tagParts`)
- Test: `apps/api/src/modules/sheets/sync.test.ts`

**Interfaces:**
- Consumes:
  - `GoogleSheets`, `GoogleError`, `isTransient` and `rowsRange` (Task 3);
  - `toRows`, `headerDrift`, `anchorHash`, `sheetFingerprint` and `isBlank` (Task 5);
  - `writeRow`, `givesAway`, `isDataError` and `refusalReason` (Task 4);
  - `nameHeaders` (core).
- Produces:
  - `config.ts`:
    - `type SheetConfig = { spreadsheetId: string; sheetId: number; tabTitle: string; headerRow: number; auth: "service_account" }`
    - `sealConfig(k: Keyring, sourceId: string, c: SheetConfig): Buffer`
    - `openConfig(k: Keyring, sourceId: string, blob: Buffer): SheetConfig`
  - `requests.ts`:
    - `type TxLike = { execute: NodePgDatabase<typeof schema>["execute"] }`
    - `requestSync(db: TxLike, o: { sourceId: string; trigger: SyncTrigger; requestedBy: string | null; reuseWithinMs?: number }): Promise<{ syncId: string; fresh: boolean } | null>`. Call it inside a transaction. `fresh` means the caller must enqueue the sync.
  - `sync.ts`:
    - `type SyncDeps = { app: FastifyInstance; pool: pg.Pool; keyring: Keyring; google: GoogleSheets; maxRows: number; now?: () => Date }`
    - `runSync(o: SyncDeps, syncId: string): Promise<void>`
    - `class Attention extends Error { code: AttentionCode }`
    - `type AttentionCode = "ACCESS_LOST" | "SHEET_GONE" | "TAB_GONE" | "COLUMNS_CHANGED" | "TOO_MANY_ROWS" | "RUN_AS_ACCESS"`
    - `readSheetRows(o: { google: GoogleSheets; spreadsheetId: string; tab: string; from: number; lastRow: number; limit: number }): Promise<string[][]>`
  - `AppDeps` gains `google?: GoogleSheets | null` and `sheets?: { enqueue(syncId: string): Promise<void>; maxRows: number }`.
  - The harness:
    - `createHarness({ google: true })` starts the fake Google;
    - the harness gains `fake: GoogleFake | null`, `google: GoogleSheets | null`, `app: FastifyInstance`, `keyring` (already present) and `runSyncs(): Promise<void>`, which runs every enqueued sync id.

- [ ] **Step 1: Wire the harness and AppDeps** (so the tests below can be written)

In `apps/api/src/app.ts` `AppDeps` (after `jobPool`):

```ts
  /** Google Sheets (spec 2B): the read-only client when this server has a service-account key, else null. */
  google?: GoogleSheets | null;
  /** The sheet sync queue in this process, and the most rows a sheet may have (LUME_SHEETS_MAX_ROWS). */
  sheets?: { enqueue(syncId: string): Promise<void>; maxRows: number };
```

Add `import type { GoogleSheets } from "./modules/sheets/google";`.

In `apps/api/test/harness.ts`:
- Add `google?: boolean` to the options `createHarness` takes (the second parameter's object).
- Before `buildApp`:

```ts
  const fake = opts.google ? await startGoogleFake() : null;
  const google = fake
    ? createGoogleSheets({ account: parseServiceAccount(fake.env)!, endpoint: fake.url, sleep: async () => undefined })
    : null;
  const syncs: string[] = [];
```

- Pass these into `buildApp({...})`: `google, sheets: { enqueue: async (id) => void syncs.push(id), maxRows: 50 },`
- Add to the returned harness object:

```ts
    app,
    fake,
    google,
    async runSyncs() {
      for (let id = syncs.shift(); id; id = syncs.shift())
        await runSync({ app, pool, keyring, google: google!, maxRows: 50 }, id);
    },
```

- Add the matching fields to the `Harness` type: `app: FastifyInstance; fake: GoogleFake | null; google: GoogleSheets | null; runSyncs(): Promise<void>;`
- In `close()`, add `await fake?.close();` before the pools end.
- Imports: `startGoogleFake, type GoogleFake` from `./google-fake`; `createGoogleSheets, parseServiceAccount, type GoogleSheets` from `../src/modules/sheets/google`; `runSync` from `../src/modules/sheets/sync`.

In `apps/api/src/modules/imports/start.ts`, change `function tagParts(` to `export function tagParts(`.

- [ ] **Step 2: Write the failing tests** `apps/api/src/modules/sheets/sync.test.ts`

```ts
import { ALL_GRANTS, DEFAULT_RULES, newId, type Mapping, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { sealConfig } from "./config";
import { requestSync } from "./requests";
import { runSync } from "./sync";

let h: Harness;
let adminId: string;
let rules: Rules;
const HEAD = ["Timestamp", "Name", "Phone", "Owner email"];
const mapping: Mapping = {
  columns: [
    { column: 0, to: "field", field: "lead_created_at" },
    { column: 1, to: "field", field: "name" },
    { column: 2, to: "field", field: "phone" },
    { column: 3, to: "field", field: "owner" },
  ],
  createMissingTags: false,
};
const row = (i: number, name = `Sheet Lead ${i}`) => [`2026-09-${String(i).padStart(2, "0")} 10:00`, name, `05077${String(i).padStart(5, "0")}`, ""];

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true });
  adminId = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  const [{ id: pipelineId }] = await h.queryAll<{ id: string }>("SELECT id FROM pipelines WHERE is_default");
  const [{ id: stageId }] = await h.queryAll<{ id: string }>(
    "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position LIMIT 1",
    [pipelineId],
  );
  rules = { ...DEFAULT_RULES({ pipelineId, stageId, country: "AE" }), unknownOwner: "error" };
});
afterAll(async () => h.close());

/** A connected, active sheet source (what Task 8's save does), with the fake holding its rows. */
async function connect(rows: string[][], over: Record<string, unknown> = {}) {
  const spreadsheetId = `ss-${newId()}`;
  h.fake!.put(spreadsheetId, {
    title: "Website enquiries",
    sharedWith: [h.fake!.email],
    tabs: [{ sheetId: 7, title: "Form responses", rows: [HEAD, ...rows] }],
  });
  const id = newId();
  await h.pool.query(
    `INSERT INTO lead_sources (id, type, name, status, config_enc, mapping, rules, headers, column_settings, run_as, baseline)
     VALUES ($1, 'google_sheet', 'Website enquiries', 'active', $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      sealConfig(h.keyring, id, { spreadsheetId, sheetId: 7, tabTitle: "Form responses", headerRow: 1, auth: "service_account" }),
      over.mapping ?? mapping,
      over.rules ?? rules,
      JSON.stringify(HEAD),
      { dateOrders: { 0: "YMD" }, decimalMarks: {} },
      over.runAs ?? adminId,
      over.baseline ?? false,
    ],
  );
  return { id, spreadsheetId };
}
const db = () => drizzle(h.pool, { schema });
async function sync(sourceId: string) {
  const r = await db().transaction((tx) => requestSync(tx, { sourceId, trigger: "manual", requestedBy: null }));
  if (!r) throw new Error("source can't sync");
  await runSync({ app: h.app, pool: h.pool, keyring: h.keyring, google: h.google!, maxRows: 50 }, r.syncId);
  return (await h.pool.query("SELECT * FROM source_syncs WHERE id = $1", [r.syncId])).rows[0];
}
const source = async (id: string) => (await h.pool.query("SELECT * FROM lead_sources WHERE id = $1", [id])).rows[0];
const leadsFrom = (id: string) =>
  h.queryAll<{ id: string; name: string }>("SELECT id, name FROM leads WHERE source_id = $1 AND deleted_at IS NULL ORDER BY name", [id]);
const valueCalls = () => h.fake!.calls.filter((c) => c.endsWith("values:batchGet")).length;

beforeEach(() => h.fake!.calls.splice(0));

describe("a sync", () => {
  it("creates a lead per row, then does nothing more while the sheet is unchanged", async () => {
    const s = await connect([row(1), row(2), row(3)]);
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 3, rows_total: 3, rows_read: 3 });
    expect((await leadsFrom(s.id)).map((l) => l.name)).toEqual(["Sheet Lead 1", "Sheet Lead 2", "Sheet Lead 3"]);
    const before = valueCalls();
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 0, rows_total: 0 });
    expect(valueCalls()).toBe(before); // Drive said "unchanged": no rows were read
    expect(await source(s.id)).toMatchObject({ rows_read: 3, failures: 0, current_sync_id: null });
  });

  it("reads only rows added since, and a repeat enquiry from the same person merges", async () => {
    const s = await connect([row(4), row(5)]);
    await sync(s.id);
    h.fake!.append(s.spreadsheetId, "Form responses", [row(6), ["2026-09-30 18:00", "Sheet Lead 4 again", row(4)[2]!, ""]]);
    expect(await sync(s.id)).toMatchObject({ created: 1, merged: 1, rows_total: 2 });
    const acts = await h.queryAll<{ type: string }>(
      "SELECT a.type FROM activities a JOIN leads l ON l.id = a.lead_id WHERE l.name = 'Sheet Lead 4'",
    );
    expect(acts.map((a) => a.type)).toContain("imported_again");
  });

  it("a re-sorted sheet is read again in full, and nothing is created twice", async () => {
    const s = await connect([row(7), row(8), row(9)]);
    await sync(s.id);
    h.fake!.setRows(s.spreadsheetId, "Form responses", [HEAD, row(10), row(9), row(7), row(8)]);
    expect(await sync(s.id)).toMatchObject({ created: 1, rows_total: 1 });
    expect(await leadsFrom(s.id)).toHaveLength(4);
  });

  it("Review Focus 1: blank rows and short rows keep their row numbers", async () => {
    const s = await connect([row(11), [], ["2026-09-12 10:00", "Short Row"], [], row(13)]);
    await sync(s.id);
    const [act] = await h.queryAll<{ payload: { row: number; sheet: string } }>(
      "SELECT a.payload FROM activities a JOIN leads l ON l.id = a.lead_id WHERE l.name = 'Short Row' AND a.type = 'imported'",
    );
    expect(act!.payload).toMatchObject({ row: 4, sheet: "Website enquiries" });
  });

  it("a problem row is retried when the rules change, and one fixed in the sheet replaces it", async () => {
    const unknownOwner = ["2026-09-15 10:00", "Owner Unknown", "0507700015", "nobody@nowhere.test"];
    const s = await connect([row(14), unknownOwner, ["not a date", "Bad Date", "0507700016", ""]]);
    expect(await sync(s.id)).toMatchObject({ created: 1, errors: 2 });
    // Fix one in the sheet: a new date is a new fingerprint (the date cell is part of it); the old problem is superseded.
    h.fake!.setRows(s.spreadsheetId, "Form responses", [HEAD, row(14), unknownOwner, ["2026-09-16 10:00", "Bad Date", "0507700016", ""]]);
    expect(await sync(s.id)).toMatchObject({ created: 1 });
    // Change the rule the other one broke: it's retried under the new rules, same entry.
    await h.pool.query(
      "UPDATE lead_sources SET rules = jsonb_set(rules, '{unknownOwner}', '\"fallback\"'), config_version = config_version + 1 WHERE id = $1",
      [s.id],
    );
    expect(await sync(s.id)).toMatchObject({ created: 1 });
    const results = await h.queryAll<{ result: string }>(
      "SELECT result FROM source_rows WHERE source_id = $1 ORDER BY row_number, result",
      [s.id],
    );
    expect(results.map((r) => r.result).sort()).toEqual(["created", "created", "created", "superseded"]);
  });

  it("Review Focus 3: a renamed tab is followed by its id", async () => {
    const s = await connect([row(17)]);
    await sync(s.id);
    h.fake!.renameTab(s.spreadsheetId, "Form responses", "Leads (renamed)");
    h.fake!.append(s.spreadsheetId, "Leads (renamed)", [row(18)]);
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 1 });
    expect((await source(s.id)).status).toBe("active");
  });

  it("a renamed mapped column pauses the sheet — LUME never guesses", async () => {
    const s = await connect([row(19)]);
    await sync(s.id);
    h.fake!.setRows(s.spreadsheetId, "Form responses", [["Timestamp", "Full name", "Phone", "Owner email"], row(19), row(20)]);
    expect(await sync(s.id)).toMatchObject({ status: "failed", error: "COLUMNS_CHANGED" });
    expect(await source(s.id)).toMatchObject({ status: "needs_attention", attention_code: "COLUMNS_CHANGED" });
    expect((await source(s.id)).last_error).toMatch(/“Name” is now called “Full name”/);
    expect(await leadsFrom(s.id)).toHaveLength(1);
    const [a] = await h.queryAll<{ action: string }>("SELECT action FROM audit_log WHERE entity_id = $1", [s.id]);
    expect(a!.action).toBe("sheet.needs_attention");
  });

  it("a new column at the end is only offered", async () => {
    const s = await connect([row(21)]);
    h.fake!.setRows(s.spreadsheetId, "Form responses", [[...HEAD, "Budget"], [...row(21), "900"]]);
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 1 });
    expect((await source(s.id)).new_columns).toEqual(["Budget"]);
  });

  it("an unshared sheet needs attention (access); a deleted one says so", async () => {
    const a = await connect([row(22)]);
    h.fake!.unshare(a.spreadsheetId);
    await sync(a.id);
    expect(await source(a.id)).toMatchObject({ status: "needs_attention", attention_code: "ACCESS_LOST" });
    expect((await source(a.id)).last_error).toContain(h.fake!.email);
    const b = await connect([row(23)]);
    h.fake!.remove(b.spreadsheetId);
    await sync(b.id);
    expect(await source(b.id)).toMatchObject({ attention_code: "SHEET_GONE" });
  });

  it("Google being down is a passing failure: the sheet stays active and backs off", async () => {
    const s = await connect([row(24)]);
    h.fake!.fail(503, 8);
    const before = Date.now();
    expect(await sync(s.id)).toMatchObject({ status: "failed" });
    const after = await source(s.id);
    expect(after).toMatchObject({ status: "active", failures: 1, current_sync_id: null });
    expect(new Date(after.next_sync_at).getTime()).toBeGreaterThanOrEqual(before + 240_000 - 1000);
    h.fake!.fail(503, 0);
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 1 });
    expect((await source(s.id)).failures).toBe(0);
  });

  it("Review Focus 5: the person it runs as losing Import pauses it with a reason", async () => {
    // Assign is granted too (the owner column gives leads away), so losing Import alone is what stops it.
    const rep = await h.seedUser({
      grants: ["leads.import", "leads.view", "leads.create", "leads.assign"].map((key) => ({ key, scope: "all" as const })),
      totp: true,
    });
    const s = await connect([row(25)], { runAs: rep });
    await h.revokeGrant(rep, "leads.import");
    expect(await sync(s.id)).toMatchObject({ status: "failed", error: "RUN_AS_ACCESS" });
    expect((await source(s.id)).last_error).toMatch(/can no longer add leads/);
    expect(await leadsFrom(s.id)).toHaveLength(0);
  });

  it("“only rows from now on”: the first sync records what's there and creates nothing", async () => {
    const s = await connect([row(26), row(27)], { baseline: true });
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 0 });
    expect(await h.queryAll("SELECT 1 FROM source_rows WHERE source_id = $1 AND result = 'skipped'", [s.id])).toHaveLength(2);
    h.fake!.append(s.spreadsheetId, "Form responses", [row(28)]);
    expect(await sync(s.id)).toMatchObject({ created: 1 });
    expect((await source(s.id)).baseline).toBe(false);
  });

  it("a sheet over the row limit needs attention", async () => {
    const s = await connect(Array.from({ length: 51 }, (_, i) => row(i + 100)));
    await sync(s.id);
    expect(await source(s.id)).toMatchObject({ status: "needs_attention", attention_code: "TOO_MANY_ROWS" });
  });
});

describe("requestSync (Review Focus 2)", () => {
  it("two requests at once make one sync; the second joins it", async () => {
    const s = await connect([row(29)]);
    const [a, b] = await Promise.all([
      db().transaction((tx) => requestSync(tx, { sourceId: s.id, trigger: "refresh", requestedBy: adminId })),
      db().transaction((tx) => requestSync(tx, { sourceId: s.id, trigger: "schedule", requestedBy: null })),
    ]);
    expect(a!.syncId).toBe(b!.syncId);
    expect([a!.fresh, b!.fresh].sort()).toEqual([false, true]);
    expect(await h.queryAll("SELECT 1 FROM source_syncs WHERE source_id = $1", [s.id])).toHaveLength(1);
  });

  it("a sync finished moments ago is reused when asked to; a paused source can't sync", async () => {
    const s = await connect([row(30)]);
    const done = await sync(s.id);
    const again = await db().transaction((tx) =>
      requestSync(tx, { sourceId: s.id, trigger: "refresh", requestedBy: adminId, reuseWithinMs: 10_000 }),
    );
    expect(again).toEqual({ syncId: done.id, fresh: false });
    await h.pool.query("UPDATE lead_sources SET status = 'paused' WHERE id = $1", [s.id]);
    expect(await db().transaction((tx) => requestSync(tx, { sourceId: s.id, trigger: "manual", requestedBy: null }))).toBeNull();
  });
});
```

The `rules` JSON is passed as an object to `pg`, which serialises it. The `DEFAULT_RULES` defaults are `matchOn: ["phone", "email", "instagram"]` and `onMatch: "merge"`, which the merge test needs. The "Owner email" column maps to `owner`, and `unknownOwner: "error"` makes an unknown email a problem row.

- [ ] **Step 3: Run it and watch it fail**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/sheets/sync.test.ts'`
Expected: FAIL, `Cannot find module './config'`.

- [ ] **Step 4: Implement** `config.ts`

```ts
import type { Keyring } from "@lume/core";

/** Where a sheet source reads from (spec §4); sealed in lead_sources.config_enc, bound to the source's id. */
export type SheetConfig = {
  spreadsheetId: string;
  /** The tab's numeric id: stable when the tab is renamed. */
  sheetId: number;
  tabTitle: string;
  /** 1-based row of the header in the sheet. */
  headerRow: number;
  auth: "service_account";
};
const context = (sourceId: string) => `sheet-source:${sourceId}`;
export const sealConfig = (k: Keyring, sourceId: string, c: SheetConfig): Buffer =>
  k.encrypt(JSON.stringify(c), context(sourceId));
export const openConfig = (k: Keyring, sourceId: string, blob: Buffer): SheetConfig =>
  JSON.parse(k.decrypt(blob, context(sourceId))) as SheetConfig;
```

- [ ] **Step 5: Implement** `requests.ts`

```ts
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newId } from "@lume/core";
import type { SyncTrigger, schema } from "@lume/db";

/** A transaction (or database) to run in; always call requestSync inside a transaction. */
export type TxLike = { execute: NodePgDatabase<typeof schema>["execute"] };

/**
 * Spec §5.1 and amendment A9. A sync for this source: a new one (fresh: the caller enqueues it after
 * commit), the one already under way (joined), or, with reuseWithinMs, one that finished moments ago.
 * Null when the source can't sync now (paused, needs attention, archived, not a sheet). The lock is
 * the source row itself, so two requests at once can never start two syncs.
 */
export async function requestSync(
  db: TxLike,
  o: { sourceId: string; trigger: SyncTrigger; requestedBy: string | null; reuseWithinMs?: number },
): Promise<{ syncId: string; fresh: boolean } | null> {
  if (o.reuseWithinMs) {
    const { rows } = await db.execute<{ id: string }>(sql`
      SELECT s.id FROM source_syncs s JOIN lead_sources l ON l.id = s.source_id
      WHERE s.source_id = ${o.sourceId} AND s.status = 'done' AND l.current_sync_id IS NULL
        AND s.finished_at > now() - make_interval(secs => ${o.reuseWithinMs / 1000})
      ORDER BY s.finished_at DESC LIMIT 1`);
    if (rows[0]) return { syncId: rows[0].id, fresh: false };
  }
  const id = newId();
  const { rows } = await db.execute<{ stale: string | null }>(sql`
    WITH old AS (SELECT id, current_sync_id FROM lead_sources WHERE id = ${o.sourceId} FOR UPDATE)
    UPDATE lead_sources l SET current_sync_id = ${id}, sync_lock_until = now() + interval '15 minutes'
    FROM old
    WHERE l.id = old.id AND l.type = 'google_sheet' AND l.status = 'active'
      AND (l.current_sync_id IS NULL OR l.sync_lock_until < now())
    RETURNING old.current_sync_id AS stale`);
  if (rows[0]) {
    // A sync whose lock ran out (its process died) is closed, so nothing waits on it for ever.
    if (rows[0].stale)
      await db.execute(
        sql`UPDATE source_syncs SET status = 'failed', error = 'stopped', finished_at = now() WHERE id = ${rows[0].stale} AND status IN ('queued', 'running')`,
      );
    await db.execute(
      sql`INSERT INTO source_syncs (id, source_id, trigger, requested_by, status) VALUES (${id}, ${o.sourceId}, ${o.trigger}, ${o.requestedBy}, 'queued')`,
    );
    return { syncId: id, fresh: true };
  }
  const { rows: current } = await db.execute<{ id: string | null }>(
    sql`SELECT current_sync_id AS id FROM lead_sources WHERE id = ${o.sourceId} AND type = 'google_sheet' AND status = 'active'`,
  );
  return current[0]?.id ? { syncId: current[0].id, fresh: false } : null;
}
```

- [ ] **Step 6: Implement** `sync.ts`

```ts
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { INTAKE_LIMITS, can, fold, nameHeaders, type DateOrder, type Keyring, type Mapping, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import { loadActor, type ActorRecord } from "../../rbac/actor";
import { createTag } from "../catalog/service";
import { loadMapContext, type FullMapContext } from "../imports/context";
import { jobServer, withJobRequest } from "../imports/job-request";
import { writeRow } from "../imports/row";
import { givesAway, isDataError, refusalReason } from "../imports/runner";
import { tagParts } from "../imports/start";
import { openConfig } from "./config";
import { GoogleError, isTransient, rowsRange, type GoogleSheets } from "./google";
import { anchorHash, headerDrift, sheetFingerprint, toRows, type SheetRow } from "./grid";

const S = schema.leadSources;
const SY = schema.sourceSyncs;
const SR = schema.sourceRows;
const CHUNK = 5000;
const HOUR = 3_600_000;
const RETRY_LIMIT = 200;

export type SyncDeps = {
  app: FastifyInstance;
  pool: pg.Pool;
  keyring: Keyring;
  google: GoogleSheets;
  maxRows: number;
  now?: () => Date;
};
type Source = typeof S.$inferSelect;
type Db = NodePgDatabase<typeof schema>;
type ColumnSettings = { dateOrders: Record<number, DateOrder>; decimalMarks: Record<number, "." | ","> };
type Todo = { row: SheetRow; fp: string };

export type AttentionCode =
  | "ACCESS_LOST"
  | "SHEET_GONE"
  | "TAB_GONE"
  | "COLUMNS_CHANGED"
  | "TOO_MANY_ROWS"
  | "RUN_AS_ACCESS";
/** Something only a person can fix: the sheet waits (needs attention) until they do. */
export class Attention extends Error {
  constructor(
    readonly code: AttentionCode,
    message: string,
  ) {
    super(message);
  }
}

/** Google's refusals, in LUME's words: no access and gone need a person; the rest pass through. */
async function ask<T>(google: GoogleSheets, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof GoogleError && e.kind === "access")
      throw new Attention(
        "ACCESS_LOST",
        `LUME can't open this sheet any more. Share it with ${google.email} as a Viewer, then press Test again.`,
      );
    if (e instanceof GoogleError && e.kind === "not_found")
      throw new Attention("SHEET_GONE", "This spreadsheet was deleted, or moved where LUME can't reach it.");
    throw e;
  }
}

/**
 * Rows `from`..`lastRow` of a tab, in chunks. Google leaves out trailing empty rows of each range, so every
 * chunk but the last is padded back to its full length: a row keeps its position across chunks. Trailing
 * blank rows are then dropped. More than `limit` rows is a problem only a person can fix.
 */
export async function readSheetRows(o: {
  google: GoogleSheets;
  spreadsheetId: string;
  tab: string;
  from: number;
  lastRow: number;
  limit: number;
}): Promise<string[][]> {
  const out: string[][] = [];
  for (let at = o.from; at <= o.lastRow; at += CHUNK) {
    const to = Math.min(at + CHUNK - 1, o.lastRow);
    const [chunk = []] = await ask(o.google, () => o.google.values(o.spreadsheetId, [rowsRange(o.tab, at, to)]));
    out.push(...chunk);
    if (to < o.lastRow) while (out.length < to - o.from + 1) out.push([]);
    if (out.filter((r) => r.length).length > o.limit) break;
  }
  while (out.length && !out.at(-1)!.length) out.pop();
  if (out.length > o.limit)
    throw new Attention(
      "TOO_MANY_ROWS",
      `This sheet has more than ${o.limit.toLocaleString("en")} rows. LUME reads up to ${o.limit.toLocaleString("en")}.`,
    );
  return out;
}

/** The person the sheet runs as (amendment A2), if they may still do what its rules do. */
async function runAsActor(o: SyncDeps, src: Source, rules: Rules, mapping: Mapping): Promise<ActorRecord> {
  const actor = src.runAs ? await loadActor(o.pool, src.runAs) : null;
  if (actor && can(actor, "leads.import") && (!givesAway(rules, mapping, actor) || can(actor, "leads.assign")))
    return actor;
  const { rows } = src.runAs
    ? await o.pool.query<{ name: string }>("SELECT name FROM users WHERE id = $1", [src.runAs])
    : { rows: [] };
  throw new Attention(
    "RUN_AS_ACCESS",
    `${rows[0]?.name ?? "The person who connected this sheet"} connected this sheet and can no longer add leads. Open the sheet's settings and save them to run it as you.`,
  );
}

/**
 * Spec §5.2: one sync, end to end. Safe to call twice: only the sync the source points at runs, and
 * every row is claimed once (source_rows_once), so a repeat after a crash carries on without doubles.
 */
export async function runSync(o: SyncDeps, syncId: string): Promise<void> {
  o = { ...o, app: jobServer(o.app) };
  const now = o.now ?? (() => new Date());
  const db = drizzle(o.pool, { schema });
  const [sync] = await db
    .update(SY)
    .set({ status: "running", startedAt: now() })
    .where(and(eq(SY.id, syncId), eq(SY.status, "queued")))
    .returning();
  if (!sync) return;
  const [src] = await db.select().from(S).where(eq(S.id, sync.sourceId));
  if (!src || src.currentSyncId !== syncId || src.status !== "active") {
    await db.update(SY).set({ status: "failed", error: "stopped", finishedAt: now() }).where(eq(SY.id, syncId));
    return;
  }
  // Close the sync and free the source, but only while the source still points at this sync.
  const settle = (syncPatch: Partial<typeof SY.$inferInsert>, sourcePatch: Partial<typeof S.$inferInsert>) =>
    db.transaction(async (tx) => {
      await tx.update(SY).set({ ...syncPatch, finishedAt: now() }).where(eq(SY.id, syncId));
      await tx
        .update(S)
        .set({ ...sourcePatch, currentSyncId: null, syncLockUntil: null })
        .where(and(eq(S.id, src.id), eq(S.currentSyncId, syncId)));
    });
  try {
    const patch = await syncSource(o, db, src, syncId, now);
    await settle(
      { status: "done" },
      {
        ...patch,
        lastSyncedAt: now(),
        nextSyncAt: new Date(now().getTime() + src.pollSeconds * 1000),
        failures: 0,
        lastError: null,
      },
    );
  } catch (e) {
    if (e instanceof Attention) {
      await settle(
        { status: "failed", error: e.code },
        { status: "needs_attention", attentionCode: e.code, lastError: e.message },
      );
      await db.insert(schema.auditLog).values({
        actorUserId: null,
        action: "sheet.needs_attention",
        entityType: "lead_source",
        entityId: src.id,
        diff: { code: e.code, name: src.name },
        requestId: `sheet:${syncId}`,
      });
      return;
    }
    // Anything else passes on its own or is a bug: the sheet stays active and tries again later, backing off.
    if (!isTransient(e)) o.app.log.error({ err: e, sourceId: src.id }, "sheet sync failed");
    const failures = src.failures + 1;
    const message = isTransient(e) ? "Couldn't reach Google." : "Something went wrong reading this sheet.";
    await settle(
      { status: "failed", error: message },
      {
        failures,
        lastError: message,
        nextSyncAt: new Date(now().getTime() + Math.min(src.pollSeconds * 1000 * 2 ** failures, HOUR)),
      },
    );
  }
}

async function syncSource(
  o: SyncDeps,
  db: Db,
  src: Source,
  syncId: string,
  now: () => Date,
): Promise<Partial<typeof S.$inferInsert>> {
  const cfg = openConfig(o.keyring, src.id, src.configEnc!);
  const mapping = src.mapping as Mapping;
  const rules = src.rules as Rules;
  const saved = src.headers;
  const width = saved.length;
  await runAsActor(o, src, rules, mapping);

  // 1. Changed? Drive's modifiedTime is cheap; the Sheets quota is kept for sheets that changed.
  const modified = await ask(o.google, () => o.google.modifiedTime(cfg.spreadsheetId));
  const configChanged = src.syncedConfigVersion !== src.configVersion;
  if (modified === src.lastModified && !configChanged && !src.baseline) return {};

  // 2. The tab, by id (a renamed tab is followed), and its header, first row and last row read.
  const meta = await ask(o.google, () => o.google.spreadsheet(cfg.spreadsheetId));
  const tab = meta.tabs.find((t) => t.sheetId === cfg.sheetId);
  if (!tab) throw new Attention("TAB_GONE", `The tab “${cfg.tabTitle}” is gone from the spreadsheet.`);
  const h = cfg.headerRow;
  const tailRow = h + src.rowsRead;
  const [headRaw = [], firstRaw = [], tailRaw = []] = await ask(o.google, () =>
    o.google.values(cfg.spreadsheetId, [
      rowsRange(tab.title, h, h),
      rowsRange(tab.title, h + 1, h + 1),
      rowsRange(tab.title, tailRow, tailRow),
    ]),
  );
  // Padded to the saved width first, so a blank header cell is named "Column E" here just as the draft named it.
  const headCells = [...(headRaw[0] ?? [])];
  while (headCells.length < width) headCells.push("");
  const header = nameHeaders(headCells);
  const drift = headerDrift(saved, header, mapping);
  const broken = drift.broken[0];
  if (broken)
    throw new Attention(
      "COLUMNS_CHANGED",
      broken.now
        ? `The column “${broken.was}” is now called “${broken.now}”. Open the sheet's columns to check them — LUME won't guess.`
        : `The column “${broken.was}” is gone from the sheet. Open the sheet's columns to check them — LUME won't guess.`,
    );
  const first = firstRaw[0] ?? [];
  const anchorNow = anchorHash(header.slice(0, width), first, src.rowsRead ? (tailRaw[0] ?? []) : undefined);
  const full =
    src.baseline ||
    !src.headHash ||
    anchorNow !== src.headHash ||
    !src.fullReadAt ||
    now().getTime() - src.fullReadAt.getTime() > HOUR;

  // 3. Read everything under the header, or only what's past the last row read.
  const from = full ? h + 1 : tailRow + 1;
  const raw = await readSheetRows({
    google: o.google,
    spreadsheetId: cfg.spreadsheetId,
    tab: tab.title,
    from,
    lastRow: Math.max(tab.rowCount, from),
    limit: full ? o.maxRows : o.maxRows - src.rowsRead,
  });
  const rowsRead = (full ? 0 : src.rowsRead) + raw.length;
  const lastRaw = raw.length ? raw.at(-1)! : tailRaw[0];
  const patch = {
    lastModified: modified,
    rowsRead,
    headHash: anchorHash(header.slice(0, width), first, rowsRead ? (lastRaw ?? []) : undefined),
    fullReadAt: full ? now() : src.fullReadAt,
    syncedConfigVersion: src.configVersion,
    newColumns: drift.added,
    baseline: false,
  };
  const rows = toRows(raw, from, width);

  // 4. What's known, and the problem rows to look at again (a full read sees them anyway).
  const known = new Map(
    (await db.select({ fp: SR.fingerprint, result: SR.result }).from(SR).where(eq(SR.sourceId, src.id))).map((r) => [
      r.fp,
      r.result,
    ]),
  );
  const openErrors = await db
    .select({ id: SR.id, fp: SR.fingerprint, rowNumber: SR.rowNumber })
    .from(SR)
    .where(and(eq(SR.sourceId, src.id), eq(SR.result, "error")))
    .orderBy(SR.rowNumber)
    .limit(RETRY_LIMIT);
  let candidates = rows;
  const superseded: number[] = [];
  if (!full && openErrors.length) {
    const again = await ask(o.google, () =>
      o.google.values(
        cfg.spreadsheetId,
        openErrors.map((e) => rowsRange(tab.title, e.rowNumber, e.rowNumber)),
      ),
    );
    const reread = again.flatMap((g, i) => toRows(g, openErrors[i]!.rowNumber, width));
    openErrors.forEach((e) => {
      const now = reread.find((r) => r.number === e.rowNumber);
      if (!now || sheetFingerprint(now.cells, mapping) !== e.fp) superseded.push(e.id);
    });
    candidates = [...reread, ...rows];
  }

  // 5. Baseline ("only rows from now on", amendment A3): record what's there, create nothing.
  if (src.baseline) {
    for (const r of rows) {
      const fp = sheetFingerprint(r.cells, mapping);
      await db
        .insert(SR)
        .values({
          sourceId: src.id,
          fingerprint: fp,
          result: "skipped",
          syncId,
          rowNumber: r.number,
          problems: [{ column: null, code: "BEFORE_START", message: "Was in the sheet before it was connected." }],
        })
        .onConflictDoNothing();
    }
    return patch;
  }

  // 6. What to write: new rows, and problem rows (fixed or under new rules). Same fingerprint twice in one
  // read is one enquiry.
  const seen = new Set<string>();
  const todo: Todo[] = [];
  for (const r of candidates) {
    const fp = sheetFingerprint(r.cells, mapping);
    if (seen.has(fp)) continue;
    seen.add(fp);
    const was = known.get(fp);
    if (was === undefined || was === "error") todo.push({ row: r, fp });
  }
  await db.update(SY).set({ rowsTotal: todo.length }).where(eq(SY.id, syncId));

  const columnSettings = src.columnSettings as ColumnSettings;
  for (let i = 0; i < todo.length; i += INTAKE_LIMITS.batch) {
    const slice = todo.slice(i, i + INTAKE_LIMITS.batch);
    // Permissions, people and fields are read afresh before every batch, as an import does.
    const actor = await runAsActor(o, src, rules, mapping);
    const job = (suffix: string) => ({
      app: o.app,
      pool: o.pool,
      actor,
      requestId: `sheet:${syncId}:${suffix}`,
      allLeads: true,
    });
    await db.execute(
      sql`UPDATE lead_sources SET sync_lock_until = now() + interval '15 minutes' WHERE id = ${src.id} AND current_sync_id = ${syncId}`,
    );
    if (mapping.createMissingTags)
      await withJobRequest(job("tags"), (req) => createMissingTags(req, mapping, slice.map((t) => t.row.cells)));
    const ctx = await withJobRequest(job("context"), (req) =>
      loadMapContext(req, { pipelineId: rules.pipelineId, headerCount: width, columnSettings }),
    );
    for (const t of slice) {
      try {
        await withJobRequest(job(String(t.row.number)), (req) =>
          oneRow(req, o.keyring, { src, rules, mapping, ctx, syncId }, t),
        );
      } catch (e) {
        // A row the database refuses is that row's problem; the rest of the sheet carries on.
        if (!isDataError(e)) throw e;
        await withJobRequest(job(`${t.row.number}:refused`), (req) =>
          refuseRow(req, o.keyring, src.id, syncId, t, refusalReason(e)),
        );
      }
    }
  }

  // 7. Problems no longer in the sheet are closed.
  if (full)
    await db.execute(
      sql`UPDATE source_rows SET result = 'superseded', raw_enc = NULL WHERE source_id = ${src.id} AND result = 'error' AND NOT (fingerprint = ANY(${[...seen]}::text[]))`,
    );
  else if (superseded.length)
    await db.execute(
      sql`UPDATE source_rows SET result = 'superseded', raw_enc = NULL WHERE id = ANY(${superseded}::bigint[]) AND result = 'error'`,
    );
  return patch;
}

type Run = { src: Source; rules: Rules; mapping: Mapping; ctx: FullMapContext; syncId: string };

/** Claim the row (new, or a problem being retried), write it with the shared engine, and count it. */
async function oneRow(req: FastifyRequest, keyring: Keyring, run: Run, t: Todo) {
  const { src, rules, mapping, ctx, syncId } = run;
  const claim = await req.db.execute<{ id: string }>(sql`
    INSERT INTO source_rows (source_id, fingerprint, result, sync_id, row_number)
    VALUES (${src.id}, ${t.fp}, 'pending', ${syncId}, ${t.row.number})
    ON CONFLICT ON CONSTRAINT source_rows_once DO UPDATE
      SET result = 'pending', sync_id = EXCLUDED.sync_id, row_number = EXCLUDED.row_number, last_tried_at = now()
      WHERE source_rows.result = 'error'
    RETURNING id`);
  const id = claim.rows[0]?.id;
  if (!id) return; // dealt with already (by an earlier attempt of this sync, or another)
  const r = await writeRow(req, {
    sourceId: src.id,
    rules,
    mapping,
    ctx,
    cells: t.row.cells,
    origin: { sourceId: src.id, sheet: src.name, row: t.row.number },
    nextTurn: async () => {
      const { rows } = await req.db.execute<{ n: number }>(
        sql`UPDATE lead_sources SET rr_cursor = rr_cursor + 1 WHERE id = ${src.id} RETURNING rr_cursor - 1 AS n`,
      );
      return Number(rows[0]!.n);
    },
  });
  await req.db
    .update(SR)
    .set({
      result: r.result,
      leadId: r.leadId,
      problems: r.problems,
      warnings: r.warnings,
      // Only a problem row keeps its cells (for the download and the retry), sealed to this source.
      rawEnc: r.result === "error" ? keyring.encrypt(JSON.stringify(t.row.cells), `sheet-row:${src.id}:${t.fp}`) : null,
    })
    .where(eq(SR.id, Number(id)));
  const column = r.result === "error" ? "errors" : r.result;
  await req.db.execute(
    sql`UPDATE source_syncs SET rows_read = rows_read + 1, ${sql.identifier(column)} = ${sql.identifier(column)} + 1 WHERE id = ${syncId}`,
  );
}

async function refuseRow(req: FastifyRequest, keyring: Keyring, sourceId: string, syncId: string, t: Todo, reason: string) {
  await req.db.execute(sql`
    INSERT INTO source_rows (source_id, fingerprint, result, sync_id, row_number, problems, raw_enc)
    VALUES (${sourceId}, ${t.fp}, 'error', ${syncId}, ${t.row.number},
      ${JSON.stringify([{ column: null, code: "ROW_NOT_SAVED", message: `LUME couldn't save this row (${reason}).` }])}::jsonb,
      ${keyring.encrypt(JSON.stringify(t.row.cells), `sheet-row:${sourceId}:${t.fp}`)})
    ON CONFLICT ON CONSTRAINT source_rows_once DO UPDATE
      SET result = 'error', problems = EXCLUDED.problems, raw_enc = EXCLUDED.raw_enc, last_tried_at = now()`);
  await req.db.execute(
    sql`UPDATE source_syncs SET rows_read = rows_read + 1, errors = errors + 1 WHERE id = ${syncId}`,
  );
}

/** A sheet chosen to create missing tags keeps doing so for new rows (spec §5.2, as 2A's Start does). */
async function createMissingTags(req: FastifyRequest, mapping: Mapping, rows: string[][]) {
  const have = new Set(
    (await req.db.select({ label: schema.tags.label }).from(schema.tags)).map((t) => fold(t.label)),
  );
  for (const c of mapping.columns.filter((x) => x.to === "field" && x.field === "tags"))
    for (const cells of rows)
      for (const part of tagParts(c, cells[c.column] ?? "")) {
        if (have.has(fold(part)) || part.length > 60) continue; // too long: that row is a problem row
        have.add(fold(part));
        await createTag(req, { label: part });
      }
}
```

- [ ] **Step 7: Run the tests**

Run: the Step 3 command.
Expected: PASS (15 tests). If a test fails, find the cause with superpowers:systematic-debugging. Never loosen an assertion to make it pass.

- [ ] **Step 8: Gate and commit**

Message: `feat(api): the sheet sync — new rows become leads, re-sorts are safe, problems retry, and a changed sheet pauses instead of guessing`, with the trailer.

---

### Task 7: The queue, the ticker, and the running server

**Files:**
- Create: `apps/api/src/modules/sheets/queue.ts`
- Modify: `apps/api/src/main.ts`
- Test: `apps/api/src/modules/sheets/queue.test.ts`

**Interfaces:**
- Consumes: `runSync`, `SyncDeps` and `requestSync`.
- Produces:
  - `startSheetsQueue(o: { connectionString: string; app: FastifyInstance; pool: pg.Pool; keyring: Keyring; google: GoogleSheets; maxRows: number; tickMs?: number }): Promise<{ enqueue(syncId: string): Promise<void>; tick(): Promise<number>; stop(): Promise<void> }>`
  - `dueSources(db: TxLike): Promise<string[]>`: the ids of active sheet sources that are due, while Sheets is switched on.

- [ ] **Step 1: Write the failing test** `apps/api/src/modules/sheets/queue.test.ts`

This tests `dueSources` against the database; the pg-boss wiring is exercised live and in e2e.

```ts
import { newId } from "@lume/core";
import { schema } from "@lume/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { dueSources } from "./queue";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ preset: "general" });
});
afterAll(async () => h.close());

const add = async (status: string, nextSyncAt: string | null) => {
  const id = newId();
  await h.pool.query(
    "INSERT INTO lead_sources (id, type, name, status, next_sync_at) VALUES ($1, 'google_sheet', 'S', $2, $3)",
    [id, status, nextSyncAt],
  );
  return id;
};

describe("dueSources", () => {
  it("lists active sheets that are due, only while Sheets is switched on", async () => {
    const due = await add("active", "2000-01-01T00:00:00Z");
    const never = await add("active", null);
    await add("active", "2999-01-01T00:00:00Z");
    await add("paused", "2000-01-01T00:00:00Z");
    await add("needs_attention", "2000-01-01T00:00:00Z");
    const db = drizzle(h.pool, { schema });
    expect(await dueSources(db)).toEqual([]);
    await h.pool.query(`UPDATE settings SET integrations = '{"googleSheets":{"enabled":true}}' WHERE id = 1`);
    expect((await dueSources(db)).sort()).toEqual([due, never].sort());
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/sheets/queue.test.ts'`
Expected: FAIL, `Cannot find module './queue'`.

- [ ] **Step 3: Implement** `queue.ts`

```ts
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import PgBoss from "pg-boss";
import type pg from "pg";
import type { Keyring } from "@lume/core";
import { schema } from "@lume/db";
import type { GoogleSheets } from "./google";
import { requestSync, type TxLike } from "./requests";
import { runSync } from "./sync";

/** Active sheets whose next sync is due, while the Sheets module is switched on (spec §3, §5.1). */
export async function dueSources(db: TxLike): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT l.id FROM lead_sources l, settings s
    WHERE s.id = 1 AND COALESCE((s.integrations -> 'googleSheets' ->> 'enabled')::boolean, false)
      AND l.type = 'google_sheet' AND l.status = 'active'
      AND (l.next_sync_at IS NULL OR l.next_sync_at <= now())
    ORDER BY l.next_sync_at NULLS FIRST
    LIMIT 50`);
  return rows.map((r) => r.id);
}

/**
 * Sheet syncs run in the API process, as lume_app (like imports, 2A amendment 1), one at a time. Once a
 * minute, due sources are asked to sync. A sync that died with its process is picked up again when its
 * lock runs out: the next request replaces it.
 */
export async function startSheetsQueue(o: {
  connectionString: string;
  app: FastifyInstance;
  pool: pg.Pool;
  keyring: Keyring;
  google: GoogleSheets;
  maxRows: number;
  tickMs?: number;
}) {
  const boss = new PgBoss({
    connectionString: o.connectionString,
    schema: "pgboss",
    migrate: false,
    supervise: false,
    schedule: false,
    max: 2,
  });
  boss.on("error", (err) => o.app.log.error({ err }, "sheets queue error"));
  await boss.start();
  await boss.work<{ id: string }>(
    "sheets.sync",
    { batchSize: 1, pollingIntervalSeconds: 0.5 },
    async ([job]) => {
      if (job)
        await runSync({ app: o.app, pool: o.pool, keyring: o.keyring, google: o.google, maxRows: o.maxRows }, job.data.id);
    },
  );
  // A failed sync is not retried by the queue: the sync itself records the failure and when to try again.
  const enqueue = async (id: string) => {
    await boss.send("sheets.sync", { id }, { retryLimit: 0 });
  };
  const db = drizzle(o.pool, { schema });
  let ticking = false;
  const tick = async () => {
    if (ticking) return 0;
    ticking = true;
    let started = 0;
    try {
      for (const sourceId of await dueSources(db)) {
        const r = await db.transaction((tx) => requestSync(tx, { sourceId, trigger: "schedule", requestedBy: null }));
        if (r?.fresh) {
          await enqueue(r.syncId);
          started++;
        }
      }
    } catch (err) {
      o.app.log.error({ err }, "sheets tick failed");
    } finally {
      ticking = false;
    }
    return started;
  };
  const timer = setInterval(() => void tick(), o.tickMs ?? 60_000);
  timer.unref();
  void tick();
  return {
    enqueue,
    tick,
    stop: async () => {
      clearInterval(timer);
      await boss.stop({ graceful: true, wait: true, timeout: 20_000 });
    },
  };
}
```

- [ ] **Step 4: Wire `main.ts`**

After `keyring` is loaded:

```ts
const account = parseServiceAccount(cfg.GOOGLE_SERVICE_ACCOUNT_JSON);
const google = account ? createGoogleSheets({ account, endpoint: cfg.LUME_GOOGLE_ENDPOINT }) : null;
// Filled in once the sheets queue is up, like `imports`.
const sheets = { enqueue: async (_id: string) => undefined, maxRows: cfg.LUME_SHEETS_MAX_ROWS };
```

Pass `google, sheets,` into `buildApp({...})`. After `imports.enqueue = queue.enqueue;`:

```ts
// Sheets run only on a server that has a Google key; without one the module can't be switched on.
const sheetQueue = google
  ? await startSheetsQueue({
      connectionString: cfg.DATABASE_URL_APP,
      app,
      pool: jobPool,
      keyring,
      google,
      maxRows: cfg.LUME_SHEETS_MAX_ROWS,
    })
  : null;
if (sheetQueue) sheets.enqueue = sheetQueue.enqueue;
```

In the signal handler, add `await sheetQueue?.stop();` before `await queue.stop();`.

Imports: `createGoogleSheets, parseServiceAccount` from `./modules/sheets/google`; `startSheetsQueue` from `./modules/sheets/queue`.

The job pool is `max: 4`: the import job, preview lookups and now the sheet sync. Raise it to `max: 5` with the comment `// Imports, a preview's lookup, and the sheet sync each get their own connections.`

- [ ] **Step 5: Run the tests and a build**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/sheets && pnpm --filter @lume/api build'`
Expected: PASS, and the build succeeds.

- [ ] **Step 6: Gate and commit**

Message: `feat(api): sheets sync on their own every few minutes, in the API process, only while switched on`, with the trailer.

---
### Task 8: The sheets API — switch, connect, edit, look after

**Files:**
- Create: `apps/api/src/modules/sheets/service.ts`, `apps/api/src/modules/sheets/routes.ts`
- Modify:
  - `apps/api/src/modules/imports/start.ts`: extract `prepareStart`.
  - `apps/api/src/modules/imports/service.ts`: extract `createDraftFrom`, export `defaultRules`, and keep sheet drafts out of `listImports`.
  - `apps/api/src/modules/imports/report.ts`: export `safeCell`.
  - `apps/api/src/modules/catalog/service.ts`: `listSources` hides drafts.
  - `apps/api/src/app.ts`: register the routes.
  - `apps/api/test/probes.ts`.
  - `apps/web/src/lib/settings/audit.ts`: wording.
- Test: `apps/api/src/modules/sheets/sheets.test.ts`

**Interfaces:**
- Consumes: `requestSync`, `sealConfig`/`openConfig`, `readSheetRows`, `gridToCsv`, the Google client, `draftView`/`mine`/`DraftView` (2A) and `givesAway`.
- Produces, from `service.ts` (the web's `lib/sheets/types.ts` mirrors these in Task 10):
  - `type SheetSourceView = { id: string; name: string; status: "active" | "paused" | "needs_attention"; attention: { code: string; message: string } | null; tabTitle: string; link: string; pollSeconds: number; lastSyncedAt: string | null; nextSyncAt: string | null; syncing: boolean; failing: boolean; lastError: string | null; newColumns: string[]; newToday: number; newAllTime: number; problems: number; runAs: { id: string; name: string } | null }`
  - `type SheetSourceDetail = SheetSourceView & { syncs: SyncView[]; problemRows: ProblemRowView[] }`
  - `type SyncView = { id: string; trigger: string; status: string; startedAt: string | null; finishedAt: string | null; created: number; merged: number; errors: number; error: string | null }`
  - `type ProblemRowView = { id: number; rowNumber: number; problems: { code: string; message: string }[]; lastTriedAt: string }`
  - `type SheetDraft = { draft: DraftView; sheet: { title: string; name: string; tabTitle: string; email: string; moreRows: boolean; editing: string | null } }`
  - The service functions: `integrationsView`, `setSheetsEnabled`, `inspectSheet`, `createSheetDraft`, `saveSheet`, `listSheets`, `getSheet`, `patchSheet`, `removeSheet`, `syncNow`, `dismissRow` and `problemsCsv`.
  - `sheetsOn(req): Promise<boolean>`, used by Task 9.
- Produces, from `imports/start.ts`: `prepareStart(req, d, imp, o?: { keepCreatingTags?: boolean }): Promise<{ file: ReadCsv; mapping: Mapping; rules: Rules; columnSettings: ColumnSettings }>`.
- Produces, from `imports/service.ts`: `createDraftFrom(req, d, o: { bytes: Buffer; fileName: string; kind: "csv" | "sheet"; sourceId: string; headerRow?: number; mapping?: Mapping; rules?: Rules; targetSourceId?: string }): Promise<DraftView>`.

- [ ] **Step 1: Write the failing tests** `apps/api/src/modules/sheets/sheets.test.ts`

```ts
import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let bare: Harness; // a server with no Google key
let admin: AuthedClient;
let otherAdmin: AuthedClient;
let otherAdminId: string;
const HEAD = ["Timestamp", "Name", "Phone"];
const r = (i: number) => [`2026-09-${String(i).padStart(2, "0")} 09:30`, `Sheets Api ${i}`, `05088${String(i).padStart(5, "0")}`];
const link = (id: string, gid = 5) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}`;

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true });
  bare = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  otherAdminId = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  otherAdmin = await h.signIn(otherAdminId);
});
afterAll(async () => {
  await h.close();
  await bare.close();
});

const call = (c: AuthedClient, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  c.inject({ method, url, ...(payload !== undefined ? { payload } : {}) });
/** A fresh spreadsheet in the fake, shared with LUME, and its id. */
function sheet(rows: string[][], shared = true) {
  const id = `1Sheet${newId().replace(/-/g, "")}`;
  h.fake!.put(id, { title: "Website enquiries", sharedWith: shared ? [h.fake!.email] : [], tabs: [{ sheetId: 5, title: "Form responses", rows: [HEAD, ...rows] }] });
  return id;
}
/** Draft → save, as the wizard does; returns the saved source. */
async function connect(c: AuthedClient, id: string, startFrom: "all" | "new" = "all") {
  const d = await call(c, "POST", "/api/v1/sheets/drafts", { link: link(id), sheetId: 5 });
  expect(d.statusCode).toBe(201);
  const saved = await call(c, "POST", "/api/v1/sheets/sources", { importId: d.json().draft.id, name: "Website enquiries", pollSeconds: 120, startFrom });
  expect(saved.statusCode).toBe(201);
  return saved.json();
}

describe("the Sheets module", () => {
  it("is off by default, and can't be switched on without a Google key", async () => {
    const b = await bare.signIn(await bare.seedUser({ grants: ALL_GRANTS, totp: true }));
    expect((await call(b, "GET", "/api/v1/integrations")).json()).toEqual({
      googleSheets: { enabled: false, available: false, email: null },
    });
    const off = await call(b, "PUT", "/api/v1/integrations/google-sheets", { enabled: true });
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe("NOT_CONFIGURED");
    expect((await call(admin, "POST", "/api/v1/sheets/inspect", { link: link("x".repeat(30)) })).json().code).toBe("SHEETS_OFF");
  });

  it("switches on, audited, and shows the email to share sheets with", async () => {
    expect((await call(admin, "PUT", "/api/v1/integrations/google-sheets", { enabled: true })).statusCode).toBe(200);
    expect((await call(admin, "GET", "/api/v1/integrations")).json()).toEqual({
      googleSheets: { enabled: true, available: true, email: h.fake!.email },
    });
    const [a] = await h.queryAll<{ action: string }>("SELECT action FROM audit_log WHERE action = 'integration.enabled'");
    expect(a).toBeDefined();
  });
});

describe("connecting a sheet", () => {
  it("inspect: a bad link, an unshared sheet (naming the email), and a readable one", async () => {
    expect((await call(admin, "POST", "/api/v1/sheets/inspect", { link: "https://example.com" })).json().code).toBe("LINK_INVALID");
    const locked = await call(admin, "POST", "/api/v1/sheets/inspect", { link: link(sheet([r(1)], false)) });
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toMatchObject({ code: "SHEET_NO_ACCESS" });
    expect(locked.json().message).toContain(h.fake!.email);
    const ok = (await call(admin, "POST", "/api/v1/sheets/inspect", { link: link(sheet([r(1)])) })).json();
    expect(ok).toMatchObject({ title: "Website enquiries", gid: 5, tabs: [{ sheetId: 5, title: "Form responses" }] });
  });

  it("a draft reads the tab through the 2A steps; saving with every row imports them all", async () => {
    const id = sheet([r(1), r(2)]);
    const d = (await call(admin, "POST", "/api/v1/sheets/drafts", { link: link(id), sheetId: 5 })).json();
    expect(d.sheet).toMatchObject({ title: "Website enquiries", tabTitle: "Form responses", moreRows: false, editing: null });
    expect(d.draft).toMatchObject({ headers: HEAD, rowCount: 2, headerRow: 1 });
    expect(d.draft.mapping.columns.find((c: { column: number }) => c.column === 1)).toMatchObject({ to: "field", field: "name" });
    // The 2A endpoints work on it unchanged.
    expect((await call(admin, "POST", `/api/v1/imports/${d.draft.id}/preview`, {})).statusCode).toBe(200);
    const saved = (await call(admin, "POST", "/api/v1/sheets/sources", { importId: d.draft.id, name: "Site form", pollSeconds: 300, startFrom: "all" })).json();
    expect(saved).toMatchObject({ name: "Site form", status: "active", pollSeconds: 300, syncing: true });
    expect(await h.queryAll("SELECT 1 FROM imports WHERE id = $1", [d.draft.id])).toHaveLength(0);
    await h.runSyncs();
    const list = (await call(admin, "GET", "/api/v1/sheets/sources")).json().sources;
    expect(list.find((s: { id: string }) => s.id === saved.id)).toMatchObject({ newToday: 2, newAllTime: 2, problems: 0, syncing: false });
    // Sheet drafts never show up among imports.
    expect((await call(admin, "GET", "/api/v1/imports")).json().imports.some((i: { id: string }) => i.id === d.draft.id)).toBe(false);
  });

  it("“only rows from now on” imports nothing that was already there", async () => {
    const id = sheet([r(3), r(4)]);
    const s = await connect(admin, id, "new");
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({ newAllTime: 0 });
    h.fake!.append(id, "Form responses", [r(5)]);
    await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`);
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({ newAllTime: 1 });
  });

  it("the same tab can't be connected twice", async () => {
    const id = sheet([r(6)]);
    await connect(admin, id);
    const d = (await call(admin, "POST", "/api/v1/sheets/drafts", { link: link(id), sheetId: 5 })).json();
    const again = await call(admin, "POST", "/api/v1/sheets/sources", { importId: d.draft.id, name: "Twice", pollSeconds: 120, startFrom: "all" });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("SHEET_ALREADY_CONNECTED");
  });

  it("someone who can manage integrations but not import leads can't connect a sheet", async () => {
    const setter = await h.signIn(await h.seedUser({ grants: [{ key: "integrations.manage", scope: "all" }], totp: true }));
    const d = await call(setter, "POST", "/api/v1/sheets/drafts", { link: link(sheet([r(7)])), sheetId: 5 });
    expect(d.statusCode).toBe(403);
    expect(d.json().code).toBe("CANNOT_IMPORT");
  });
});

describe("looking after a sheet", () => {
  it("Review Focus 5: a renamed column is fixed by editing the columns; whoever saves takes it over", async () => {
    const id = sheet([r(8)]);
    const s = await connect(admin, id);
    await h.runSyncs();
    h.fake!.setRows(id, "Form responses", [["Timestamp", "Full name", "Phone"], r(8), r(9)]);
    await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`);
    await h.runSyncs();
    const paused = (await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json();
    expect(paused).toMatchObject({ status: "needs_attention", attention: { code: "COLUMNS_CHANGED" } });
    expect((await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`)).json().code).toBe("NEEDS_EDIT");
    const edit = (await call(otherAdmin, "POST", "/api/v1/sheets/drafts", { sourceId: s.id })).json();
    expect(edit.sheet.editing).toBe(s.id);
    expect(edit.draft.headers).toEqual(["Timestamp", "Full name", "Phone"]);
    const saved = await call(otherAdmin, "POST", "/api/v1/sheets/sources", { importId: edit.draft.id, name: s.name, pollSeconds: 120, startFrom: "all" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ id: s.id, status: "active", attention: null, runAs: { id: otherAdminId } });
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({ newAllTime: 2 });
    expect((await h.queryAll("SELECT config_version FROM lead_sources WHERE id = $1", [s.id]))[0]).toEqual({ config_version: 2 });
  });

  it("pause, resume, remove (leads keep their source), and Test again after access comes back", async () => {
    const id = sheet([r(10)]);
    const s = await connect(admin, id);
    await h.runSyncs();
    expect((await call(admin, "PATCH", `/api/v1/sheets/sources/${s.id}`, { paused: true })).json().status).toBe("paused");
    expect((await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`)).json().code).toBe("NOT_ACTIVE");
    expect((await call(admin, "PATCH", `/api/v1/sheets/sources/${s.id}`, { paused: false, pollSeconds: 600 })).json()).toMatchObject({ status: "active", pollSeconds: 600 });
    h.fake!.unshare(id);
    h.fake!.append(id, "Form responses", [r(11)]);
    await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`);
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json().attention.code).toBe("ACCESS_LOST");
    h.fake!.share(id);
    expect((await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`)).statusCode).toBe(200); // Test again
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({ status: "active", newAllTime: 2 });
    expect((await call(admin, "DELETE", `/api/v1/sheets/sources/${s.id}`)).statusCode).toBe(204);
    expect((await call(admin, "GET", "/api/v1/sheets/sources")).json().sources.some((x: { id: string }) => x.id === s.id)).toBe(false);
    expect(await h.queryAll("SELECT 1 FROM leads WHERE source_id = $1 AND deleted_at IS NULL", [s.id])).toHaveLength(2);
  });

  it("problem rows are listed, downloadable, and can be dismissed", async () => {
    const id = sheet([r(12), ["not a date", "Broken Row", "0508800013"]]);
    const s = await connect(admin, id);
    await h.runSyncs();
    const detail = (await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json();
    expect(detail.problems).toBe(1);
    expect(detail.problemRows).toMatchObject([{ rowNumber: 3, problems: [{ code: expect.stringMatching(/DATE/) }] }]);
    expect(detail.syncs[0]).toMatchObject({ status: "done", created: 1, errors: 1 });
    const csv = await call(admin, "GET", `/api/v1/sheets/sources/${s.id}/problems.csv`);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body).toContain("Broken Row");
    const gone = await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/rows/${detail.problemRows[0].id}/dismiss`);
    expect(gone.statusCode).toBe(204);
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json().problems).toBe(0);
  });
});
```

`h.signIn`, `h.seedUser` and `AuthedClient.inject` are the 2A harness helpers. Status codes follow the house style: a create is 201, and the edit-save returns 200 because it changes an existing source.

- [ ] **Step 2: Run it and watch it fail**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/sheets/sheets.test.ts'`
Expected: FAIL, with 404s (the routes don't exist yet).

- [ ] **Step 3: Extract `prepareStart` and `createDraftFrom`** (the 2A behaviour is unchanged)

In `imports/start.ts`, move everything in `startImport` from `const file = readImportFile(...)` down to `const columnSettings = ...` into:

```ts
export type ColumnSettings = { dateOrders: Record<number, DateOrder>; decimalMarks: Record<number, "." | ","> };

/**
 * 2A spec §7.1's checks and creations, shared by Start and by saving a sheet (2B): re-check the mapping
 * against today's fields and stages, then create the chosen new fields, options and tags and point the
 * mapping at them. A sheet keeps creating missing tags for rows still to come (keepCreatingTags).
 */
export async function prepareStart(
  req: FastifyRequest,
  d: AppDeps,
  imp: typeof I.$inferSelect,
  o: { keepCreatingTags?: boolean } = {},
): Promise<{ file: ReadCsv; mapping: Mapping; rules: Rules; columnSettings: ColumnSettings }> {
  // …the moved lines, unchanged, except the last mapping line:
  const mapping: Mapping = { columns, createMissingTags: o.keepCreatingTags ? draftMapping.createMissingTags : false };
  const columnSettings = { dateOrders: settings.dateOrders, decimalMarks: settings.decimalMarks };
  return { file, mapping, rules, columnSettings };
}
```

`startImport` then reads, after its lock, `mine` and draft check:

```ts
  const { file, mapping, rules, columnSettings } = await prepareStart(req, d, imp);
```

It keeps its memory upsert, update, audit and enqueue exactly as before. Add the `DateOrder` and `ReadCsv` type imports.

In `imports/service.ts`:
- Export `defaultRules`.
- Split `uploadImport` so that the part after the size check becomes `createDraftFrom`.

```ts
/** A draft from bytes the 2A reader understands: a CSV upload, or a sheet's snapshot (2B, amendment A1). */
export async function createDraftFrom(
  req: FastifyRequest,
  d: AppDeps,
  o: {
    bytes: Buffer;
    fileName: string;
    kind: "csv" | "sheet";
    sourceId: string;
    headerRow?: number;
    mapping?: Mapping;
    rules?: Rules;
    targetSourceId?: string;
  },
): Promise<DraftView> {
  const file = readCsv(new Uint8Array(o.bytes), { fileName: o.fileName, ...(o.headerRow ? { headerRow: o.headerRow } : {}) });
  if (!file.ok) throw badRequest(file.code, file.message);
  const [settings] = await req.db.select().from(schema.settings).where(eq(schema.settings.id, 1));
  let rules = o.rules ?? (await defaultRules(req, settings!.defaultCountryIso));
  const [memory] = o.mapping
    ? []
    : await req.db
        .select()
        .from(schema.importMappingMemory)
        .where(eq(schema.importMappingMemory.headerSignature, signature(file.headers)));
  // Remembered rules apply only while their pipeline and stage still exist.
  const remembered = memory?.rules as Rules | undefined;
  if (remembered && !o.rules) {
    const ctx = await loadMapContext(req, { pipelineId: remembered.pipelineId, headerCount: file.headers.length });
    if (ctx.stages.some((s) => s.id === remembered.stageId)) rules = { ...rules, ...remembered };
  }
  const ctx = await loadMapContext(req, { pipelineId: rules.pipelineId, headerCount: file.headers.length });
  // A given mapping (an edit of a live sheet) keeps only columns the sheet still has.
  const mapping = o.mapping
    ? { ...o.mapping, columns: o.mapping.columns.filter((c) => c.column < file.headers.length) }
    : suggestMapping(file.headers, ctx.fields, (memory?.mapping as Mapping | undefined) ?? null);
  const id = newId();
  const [imp] = await req.db
    .insert(I)
    .values({
      id,
      sourceId: o.sourceId,
      kind: o.kind,
      status: "draft",
      fileEnc: sealFile(d.keyring, id, o.bytes),
      fileSha256: sha(o.bytes),
      fileName: o.fileName,
      fileBytes: o.bytes.length,
      encoding: file.encoding,
      delimiter: file.delimiter,
      headerRow: file.headerRow,
      headers: file.headers,
      rowCount: file.rows.length,
      mapping,
      rules,
      createdBy: req.actor!.userId,
      targetSourceId: o.targetSourceId ?? null,
    })
    .returning();
  return draftView(req, d, imp!);
}

export async function uploadImport(req: FastifyRequest, d: AppDeps, bytes: Buffer, rawName: string) {
  const fileName = safeName(rawName);
  if (bytes.length > INTAKE_LIMITS.bytes)
    throw badRequest("FILE_TOO_BIG", "This file is over 10 MB. Split it into smaller files.");
  const sourceId = newId();
  await req.db.insert(schema.leadSources).values({ id: sourceId, type: "csv", name: fileName, createdBy: req.actor!.userId });
  // A file LUME can't read throws inside this request's transaction, so the source above is never kept.
  return createDraftFrom(req, d, { bytes, fileName, kind: "csv", sourceId });
}
```

Also in `imports/service.ts`:
- In `listImports`, change `visible` to `and(ne(I.kind, "sheet"), or(ne(I.status, "draft"), eq(I.createdBy, req.actor!.userId)))`.
- In `mine()`, a sheet draft is only reachable by its creator, which is the same rule as today; no change is needed.

In `imports/report.ts`, change `const safeCell` to `export const safeCell`.

In `catalog/service.ts` `listSources`, change the where clause to `and(isNull(schema.leadSources.archivedAt), ne(schema.leadSources.status, "draft"))`.

Run `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/imports'`. Expected: PASS, so the 2A behaviour is unchanged.

- [ ] **Step 4: Implement** `apps/api/src/modules/sheets/service.ts`

```ts
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import Papa from "papaparse";
import { can, newId, type Rules, type Mapping } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden, notFound } from "../../http/errors";
import { safeCell } from "../imports/report";
import { givesAway } from "../imports/runner";
import { createDraftFrom, mine, type DraftView } from "../imports/service";
import { prepareStart } from "../imports/start";
import { openConfig, sealConfig, type SheetConfig } from "./config";
import { GoogleError, isTransient, parseSheetLink, rowsRange, type GoogleSheets } from "./google";
import { gridToCsv } from "./grid";
import { requestSync } from "./requests";

const S = schema.leadSources;
const SY = schema.sourceSyncs;
const SR = schema.sourceRows;
const I = schema.imports;
type Source = typeof S.$inferSelect;
/** The draft's snapshot: the 2A reader's own row limit (it refuses more), from row 1 so row numbers match. */
const SNAPSHOT_ROWS = 20_000;
const MAX_SHEETS = 20;
/** Attention a press of "Test again" can clear; the others need the columns opened and saved. */
const RETRYABLE = new Set(["ACCESS_LOST", "SHEET_GONE", "TAB_GONE", "TOO_MANY_ROWS"]);

export type SyncView = {
  id: string;
  trigger: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  created: number;
  merged: number;
  errors: number;
  error: string | null;
};
export type ProblemRowView = {
  id: number;
  rowNumber: number;
  problems: { code: string; message: string }[];
  lastTriedAt: string;
};

// ——— The module switch (spec §3) ———

export async function sheetsOn(req: FastifyRequest): Promise<boolean> {
  const [s] = await req.db.select({ i: schema.settings.integrations }).from(schema.settings).where(eq(schema.settings.id, 1));
  return !!s?.i.googleSheets?.enabled;
}

export async function integrationsView(req: FastifyRequest, d: AppDeps) {
  return {
    googleSheets: { enabled: await sheetsOn(req), available: !!d.google, email: d.google?.email ?? null },
  };
}

export async function setSheetsEnabled(req: FastifyRequest, d: AppDeps, enabled: boolean) {
  if (enabled && !d.google)
    throw new HttpError(
      409,
      "NOT_CONFIGURED",
      "Google Sheets isn't set up on this server yet. The person who installed LUME can add its Google key.",
    );
  await req.db.execute(
    sql`UPDATE settings SET integrations = jsonb_set(integrations, '{googleSheets}', ${JSON.stringify({ enabled })}::jsonb) WHERE id = 1`,
  );
  await audit(req, {
    action: enabled ? "integration.enabled" : "integration.disabled",
    entityType: "integration",
    diff: { module: "google_sheets" },
  });
  return integrationsView(req, d);
}

async function requireOn(req: FastifyRequest, d: AppDeps): Promise<GoogleSheets> {
  if (!d.google)
    throw new HttpError(409, "NOT_CONFIGURED", "Google Sheets isn't set up on this server yet.");
  if (!(await sheetsOn(req)))
    throw new HttpError(409, "SHEETS_OFF", "Google Sheets is switched off. Switch it on in Settings → Integrations.");
  return d.google;
}

/** A Google call from a screen: its refusals as the messages the screen shows. */
async function fromGoogle<T>(google: GoogleSheets, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof GoogleError && e.kind === "access")
      throw new HttpError(
        409,
        "SHEET_NO_ACCESS",
        `LUME can't open this sheet yet. Share it with ${google.email} as a Viewer, then try again.`,
      );
    if (e instanceof GoogleError && e.kind === "not_found")
      throw new HttpError(404, "SHEET_NOT_FOUND", "LUME couldn't find this sheet. Check the link.");
    if (isTransient(e)) throw new HttpError(503, "GOOGLE_UNAVAILABLE", "LUME couldn't reach Google. Try again in a minute.");
    throw e;
  }
}

// ——— Connecting (spec §7.2) ———

export async function inspectSheet(req: FastifyRequest, d: AppDeps, link: string) {
  const google = await requireOn(req, d);
  const parsed = parseSheetLink(link);
  if (!parsed)
    throw badRequest("LINK_INVALID", "That doesn't look like a Google Sheets link. Copy it from the sheet's address bar.");
  const meta = await fromGoogle(google, () => google.spreadsheet(parsed.spreadsheetId));
  return {
    spreadsheetId: parsed.spreadsheetId,
    title: meta.title,
    gid: parsed.gid,
    tabs: meta.tabs.map(({ sheetId, title }) => ({ sheetId, title })),
    email: google.email,
  };
}

/** The first rows of a tab as a CSV the 2A reader understands, padded to one width (no "ragged rows"). */
async function snapshot(google: GoogleSheets, cfg: Pick<SheetConfig, "spreadsheetId" | "sheetId">) {
  const meta = await fromGoogle(google, () => google.spreadsheet(cfg.spreadsheetId));
  const tab = meta.tabs.find((t) => t.sheetId === cfg.sheetId);
  if (!tab) throw new HttpError(409, "TAB_NOT_FOUND", "That tab isn't in the spreadsheet any more.");
  const [rows = []] = await fromGoogle(google, () =>
    google.values(cfg.spreadsheetId, [rowsRange(tab.title, 1, SNAPSHOT_ROWS)]),
  );
  if (!rows.some((r) => r.some((c) => c.trim()))) throw badRequest("SHEET_EMPTY", "This tab is empty.");
  const width = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => [...r, ...Array<string>(width - r.length).fill("")]);
  return { meta, tab, bytes: Buffer.from(gridToCsv(grid), "utf8"), moreRows: rows.length >= SNAPSHOT_ROWS };
}

export type SheetDraft = {
  draft: DraftView;
  sheet: { title: string; name: string; tabTitle: string; email: string; moreRows: boolean; editing: string | null };
};

/**
 * Amendment A1: a sheet is set up with the 2A draft (Columns, Rules, Preview). A new sheet's draft source
 * becomes the sheet on save; an edit's draft sits on a throwaway source and names the live one.
 */
export async function createSheetDraft(
  req: FastifyRequest,
  d: AppDeps,
  body: { link: string; sheetId: number; headerRow?: number } | { sourceId: string },
): Promise<SheetDraft> {
  const google = await requireOn(req, d);
  if (!can(req.actor!, "leads.import"))
    throw forbidden("CANNOT_IMPORT", "Connecting a sheet adds leads, which your role can't do.");
  let cfg: SheetConfig;
  let target: Source | null = null;
  if ("sourceId" in body) {
    target = await liveSource(req, body.sourceId);
    cfg = openConfig(d.keyring, target.id, target.configEnc!);
  } else {
    const parsed = parseSheetLink(body.link);
    if (!parsed) throw badRequest("LINK_INVALID", "That doesn't look like a Google Sheets link. Copy it from the sheet's address bar.");
    cfg = { spreadsheetId: parsed.spreadsheetId, sheetId: body.sheetId, tabTitle: "", headerRow: body.headerRow ?? 0, auth: "service_account" };
  }
  const snap = await snapshot(google, cfg);
  const sourceId = newId();
  await req.db.insert(S).values({
    id: sourceId,
    type: "google_sheet",
    name: target?.name ?? snap.meta.title,
    status: "draft",
    createdBy: req.actor!.userId,
  });
  const draft = await createDraftFrom(req, d, {
    bytes: snap.bytes,
    fileName: `${snap.meta.title} — ${snap.tab.title}`,
    kind: "sheet",
    sourceId,
    ...(cfg.headerRow ? { headerRow: cfg.headerRow } : {}),
    ...(target ? { mapping: target.mapping as Mapping, rules: target.rules as Rules, targetSourceId: target.id } : {}),
  });
  await req.db
    .update(S)
    .set({ configEnc: sealConfig(d.keyring, sourceId, { ...cfg, tabTitle: snap.tab.title, headerRow: draft.headerRow }) })
    .where(eq(S.id, sourceId));
  return {
    draft,
    sheet: { title: snap.meta.title, name: target?.name ?? snap.meta.title, tabTitle: snap.tab.title, email: google.email, moreRows: snap.moreRows, editing: target?.id ?? null },
  };
}

/** A sheet source that isn't a draft or removed; others are 404. */
async function liveSource(req: FastifyRequest, id: string): Promise<Source> {
  const [s] = await req.db.select().from(S).where(and(eq(S.id, id), eq(S.type, "google_sheet")));
  if (!s || s.status === "draft" || s.status === "archived") throw notFound("SHEET_NOT_FOUND", "Sheet not found");
  return s;
}

export async function saveSheet(
  req: FastifyRequest,
  d: AppDeps,
  body: { importId: string; name: string; pollSeconds: number; startFrom: "all" | "new" },
): Promise<{ view: SheetSourceView; created: boolean }> {
  await requireOn(req, d);
  const actor = req.actor!;
  await req.db.execute(sql`SELECT 1 FROM imports WHERE id = ${body.importId} FOR UPDATE`);
  const imp = await mine(req, body.importId);
  if (imp.kind !== "sheet" || imp.status !== "draft") throw new HttpError(409, "NOT_DRAFT", "This sheet was already saved.");
  if (!can(actor, "leads.import")) throw forbidden("CANNOT_IMPORT", "Connecting a sheet adds leads, which your role can't do.");
  const { file, mapping, rules, columnSettings } = await prepareStart(req, d, imp, { keepCreatingTags: true });
  if (givesAway(rules, mapping, actor) && !can(actor, "leads.assign"))
    throw forbidden("CANNOT_ASSIGN", "This sheet gives leads to other people, which your role can't do.");
  const [draftSrc] = await req.db.select().from(S).where(eq(S.id, imp.sourceId));
  const cfg = { ...openConfig(d.keyring, draftSrc!.id, draftSrc!.configEnc!), headerRow: imp.headerRow ?? 1 };
  const shared = {
    name: body.name.trim(),
    pollSeconds: body.pollSeconds,
    mapping,
    rules,
    columnSettings,
    headers: file.headers,
    runAs: actor.userId,
    nextSyncAt: new Date(),
    newColumns: [] as string[],
  };

  let sourceId: string;
  if (imp.targetSourceId) {
    // Editing a live sheet: it takes the new columns and rules, runs as whoever saved, and reads afresh.
    const target = await liveSource(req, imp.targetSourceId);
    await req.db
      .update(S)
      .set({
        ...shared,
        configEnc: sealConfig(d.keyring, target.id, cfg),
        configVersion: target.configVersion + 1,
        status: target.status === "needs_attention" ? "active" : target.status,
        attentionCode: null,
        lastError: null,
        headHash: null,
      })
      .where(eq(S.id, target.id));
    await req.db.delete(S).where(eq(S.id, draftSrc!.id)); // the throwaway source, and its draft with it
    await audit(req, { action: "sheet.mapping_changed", entityType: "lead_source", entityId: target.id, diff: { name: shared.name } });
    sourceId = target.id;
  } else {
    await assertNotConnected(req, d, cfg);
    await req.db
      .update(S)
      .set({ ...shared, status: "active", configEnc: sealConfig(d.keyring, draftSrc!.id, cfg), baseline: body.startFrom === "new" })
      .where(eq(S.id, draftSrc!.id));
    await req.db.delete(I).where(eq(I.id, imp.id));
    await audit(req, {
      action: "sheet.connected",
      entityType: "lead_source",
      entityId: draftSrc!.id,
      diff: { name: shared.name, startFrom: body.startFrom },
    });
    sourceId = draftSrc!.id;
  }
  const r = await requestSync(req.db, { sourceId, trigger: "connect", requestedBy: actor.userId });
  if (r?.fresh) req.afterCommit(() => void d.sheets?.enqueue(r.syncId));
  return { view: await sourceView(req, d, await liveSource(req, sourceId)), created: !imp.targetSourceId };
}

async function assertNotConnected(req: FastifyRequest, d: AppDeps, cfg: SheetConfig) {
  const others = await req.db
    .select({ id: S.id, name: S.name, configEnc: S.configEnc })
    .from(S)
    .where(and(eq(S.type, "google_sheet"), inArray(S.status, ["active", "paused", "needs_attention"])));
  if (others.length >= MAX_SHEETS)
    throw new HttpError(409, "TOO_MANY_SHEETS", `LUME reads up to ${MAX_SHEETS} sheets. Remove one to add another.`);
  const same = others.find((o) => {
    const c = openConfig(d.keyring, o.id, o.configEnc!);
    return c.spreadsheetId === cfg.spreadsheetId && c.sheetId === cfg.sheetId;
  });
  if (same)
    throw new HttpError(409, "SHEET_ALREADY_CONNECTED", `This tab is already connected as “${same.name}”.`);
}

// ——— Looking after a sheet (spec §7.1, §7.3) ———

export type SheetSourceView = Awaited<ReturnType<typeof sourceView>>;

async function sourceView(req: FastifyRequest, d: AppDeps, s: Source) {
  const cfg = openConfig(d.keyring, s.id, s.configEnc!);
  const { rows } = await req.db.execute<{ today: number; all: number; problems: number; run_as: string | null }>(sql`
    SELECT
      count(*) FILTER (WHERE result = 'created' AND first_seen_at >= (date_trunc('day', now() AT TIME ZONE st.timezone) AT TIME ZONE st.timezone))::int AS today,
      count(*) FILTER (WHERE result = 'created')::int AS all,
      count(*) FILTER (WHERE result = 'error')::int AS problems,
      (SELECT name FROM users WHERE id = ${s.runAs}) AS run_as
    FROM settings st LEFT JOIN source_rows sr ON sr.source_id = ${s.id}
    WHERE st.id = 1`);
  const c = rows[0]!;
  return {
    id: s.id,
    name: s.name,
    status: s.status as "active" | "paused" | "needs_attention",
    attention: s.status === "needs_attention" ? { code: s.attentionCode ?? "", message: s.lastError ?? "" } : null,
    tabTitle: cfg.tabTitle,
    link: `https://docs.google.com/spreadsheets/d/${cfg.spreadsheetId}/edit#gid=${cfg.sheetId}`,
    pollSeconds: s.pollSeconds,
    lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
    nextSyncAt: s.status === "active" ? (s.nextSyncAt?.toISOString() ?? null) : null,
    syncing: s.currentSyncId !== null,
    // Three failed syncs in a row: the page warns (spec §5.4); one or two pass quietly.
    failing: s.status === "active" && s.failures >= 3,
    lastError: s.status === "active" ? s.lastError : null,
    newColumns: s.newColumns,
    newToday: c.today,
    newAllTime: c.all,
    problems: c.problems,
    runAs: s.runAs && c.run_as ? { id: s.runAs, name: c.run_as } : null,
  };
}

export async function listSheets(req: FastifyRequest, d: AppDeps) {
  const rows = await req.db
    .select()
    .from(S)
    .where(and(eq(S.type, "google_sheet"), inArray(S.status, ["active", "paused", "needs_attention"])))
    .orderBy(asc(S.createdAt));
  return { sources: await Promise.all(rows.map((s) => sourceView(req, d, s))) };
}

export async function getSheet(req: FastifyRequest, d: AppDeps, id: string) {
  const s = await liveSource(req, id);
  const syncs = await req.db.select().from(SY).where(eq(SY.sourceId, id)).orderBy(desc(SY.requestedAt)).limit(10);
  const problemRows = await req.db
    .select({ id: SR.id, rowNumber: SR.rowNumber, problems: SR.problems, lastTriedAt: SR.lastTriedAt })
    .from(SR)
    .where(and(eq(SR.sourceId, id), eq(SR.result, "error")))
    .orderBy(asc(SR.rowNumber))
    .limit(100);
  return {
    ...(await sourceView(req, d, s)),
    syncs: syncs.map(
      (x): SyncView => ({
        id: x.id,
        trigger: x.trigger,
        status: x.status,
        startedAt: x.startedAt?.toISOString() ?? null,
        finishedAt: x.finishedAt?.toISOString() ?? null,
        created: x.created,
        merged: x.merged,
        errors: x.errors,
        error: x.error,
      }),
    ),
    problemRows: problemRows.map(
      (p): ProblemRowView => ({
        id: p.id,
        rowNumber: p.rowNumber,
        problems: (p.problems as { code: string; message: string }[]).map(({ code, message }) => ({ code, message })),
        lastTriedAt: p.lastTriedAt.toISOString(),
      }),
    ),
  };
}

export async function patchSheet(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  p: { name?: string; pollSeconds?: number; paused?: boolean },
) {
  const s = await liveSource(req, id);
  const set: Partial<typeof S.$inferInsert> = {};
  if (p.name !== undefined) set.name = p.name.trim();
  if (p.pollSeconds !== undefined) set.pollSeconds = p.pollSeconds;
  if (p.paused === true && s.status === "active") set.status = "paused";
  if (p.paused === false && s.status === "paused") Object.assign(set, { status: "active", nextSyncAt: new Date() });
  if (Object.keys(set).length) await req.db.update(S).set(set).where(eq(S.id, id));
  if (set.status)
    await audit(req, { action: set.status === "paused" ? "sheet.paused" : "sheet.resumed", entityType: "lead_source", entityId: id, diff: { name: s.name } });
  return sourceView(req, d, await liveSource(req, id));
}

/** Amendment A12: removed is archived; its leads keep it, so "From …" still reads right. */
export async function removeSheet(req: FastifyRequest, id: string) {
  const s = await liveSource(req, id);
  await req.db
    .update(S)
    .set({ status: "archived", archivedAt: new Date(), currentSyncId: null, syncLockUntil: null })
    .where(eq(S.id, id));
  await audit(req, { action: "sheet.removed", entityType: "lead_source", entityId: id, diff: { name: s.name } });
}

/** Sync now, or, for a sheet that lost access or its tab, "Test again" (it's active again if it works). */
export async function syncNow(req: FastifyRequest, d: AppDeps, id: string) {
  await requireOn(req, d);
  const s = await liveSource(req, id);
  if (s.status === "paused") throw new HttpError(409, "NOT_ACTIVE", "This sheet is paused. Resume it first.");
  if (s.status === "needs_attention") {
    if (!RETRYABLE.has(s.attentionCode ?? ""))
      throw new HttpError(409, "NEEDS_EDIT", "Open this sheet's columns and save them first.");
    await req.db.update(S).set({ status: "active", attentionCode: null, lastError: null }).where(eq(S.id, id));
  }
  const r = await requestSync(req.db, { sourceId: id, trigger: "manual", requestedBy: req.actor!.userId });
  if (r?.fresh) req.afterCommit(() => void d.sheets?.enqueue(r.syncId));
  return { syncId: r?.syncId ?? null };
}

export async function dismissRow(req: FastifyRequest, id: string, rowId: number) {
  const s = await liveSource(req, id);
  const gone = await req.db
    .update(SR)
    .set({ result: "dismissed", rawEnc: null })
    .where(and(eq(SR.id, rowId), eq(SR.sourceId, id), eq(SR.result, "error")))
    .returning({ id: SR.id });
  if (!gone.length) throw notFound("ROW_NOT_FOUND", "That problem row isn't there any more.");
  await audit(req, { action: "sheet.row_dismissed", entityType: "lead_source", entityId: id, diff: { name: s.name } });
}

/** Problem rows as a CSV that opens cleanly in Excel (BOM, CRLF, no live formulas), as 2A's report. */
export async function problemsCsv(req: FastifyRequest, d: AppDeps, id: string) {
  const s = await liveSource(req, id);
  const rows = await req.db
    .select()
    .from(SR)
    .where(and(eq(SR.sourceId, id), eq(SR.result, "error")))
    .orderBy(asc(SR.rowNumber));
  const data = rows.map((r) => {
    const cells = r.rawEnc
      ? (JSON.parse(d.keyring.decrypt(r.rawEnc, `sheet-row:${id}:${r.fingerprint}`)) as string[])
      : [];
    const why = (r.problems as { message: string }[]).map((p) => p.message).join(" ");
    return [String(r.rowNumber), why, ...cells].map((c) => safeCell(c));
  });
  const table = Papa.unparse([["Row", "Problem", ...s.headers], ...data], { newline: "\r\n" });
  return { fileName: `${s.name} — problem rows.csv`, body: `${String.fromCharCode(0xfeff)}${table}\r\n` };
}
```

- [ ] **Step 5: Implement** `apps/api/src/modules/sheets/routes.ts`

```ts
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import {
  createSheetDraft,
  dismissRow,
  getSheet,
  inspectSheet,
  integrationsView,
  listSheets,
  patchSheet,
  problemsCsv,
  removeSheet,
  saveSheet,
  setSheetsEnabled,
  syncNow,
} from "./service";

const manage = { permission: "integrations.manage" as const };
const params = z.object({ id: z.uuid() });
const name = z.string().trim().min(1).max(120);
const poll = z.number().int().min(60).max(3600);

export async function sheetRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/integrations", { config: manage }, (req) => integrationsView(req, d));
  r.put(
    "/api/v1/integrations/google-sheets",
    { config: manage, schema: { body: z.object({ enabled: z.boolean() }).strict() } },
    (req) => setSheetsEnabled(req, d, req.body.enabled),
  );
  r.post(
    "/api/v1/sheets/inspect",
    { config: manage, schema: { body: z.object({ link: z.string().max(2000) }).strict() } },
    (req) => inspectSheet(req, d, req.body.link),
  );
  r.post(
    "/api/v1/sheets/drafts",
    {
      config: { ...manage, idempotent: false },
      schema: {
        body: z.union([
          z.object({ link: z.string().max(2000), sheetId: z.number().int().min(0), headerRow: z.number().int().min(1).max(10).optional() }).strict(),
          z.object({ sourceId: z.uuid() }).strict(),
        ]),
      },
    },
    async (req, reply) => reply.code(201).send(await createSheetDraft(req, d, req.body)),
  );
  r.post(
    "/api/v1/sheets/sources",
    {
      config: manage,
      schema: {
        body: z.object({ importId: z.uuid(), name, pollSeconds: poll, startFrom: z.enum(["all", "new"]) }).strict(),
      },
    },
    async (req, reply) => {
      const { view, created } = await saveSheet(req, d, req.body);
      return reply.code(created ? 201 : 200).send(view);
    },
  );
  r.get("/api/v1/sheets/sources", { config: manage }, (req) => listSheets(req, d));
  r.get("/api/v1/sheets/sources/:id", { config: manage, schema: { params } }, (req) => getSheet(req, d, req.params.id));
  r.patch(
    "/api/v1/sheets/sources/:id",
    {
      config: manage,
      schema: { params, body: z.object({ name: name.optional(), pollSeconds: poll.optional(), paused: z.boolean().optional() }).strict() },
    },
    (req) => patchSheet(req, d, req.params.id, req.body),
  );
  r.delete("/api/v1/sheets/sources/:id", { config: manage, schema: { params } }, async (req, reply) => {
    await removeSheet(req, req.params.id);
    return reply.code(204).send();
  });
  r.post("/api/v1/sheets/sources/:id/sync", { config: manage, schema: { params } }, (req) =>
    syncNow(req, d, req.params.id),
  );
  r.post(
    "/api/v1/sheets/sources/:id/rows/:rowId/dismiss",
    { config: manage, schema: { params: z.object({ id: z.uuid(), rowId: z.coerce.number().int().min(1) }) } },
    async (req, reply) => {
      await dismissRow(req, req.params.id, req.params.rowId);
      return reply.code(204).send();
    },
  );
  r.get("/api/v1/sheets/sources/:id/problems.csv", { config: manage, schema: { params } }, async (req, reply) => {
    const { fileName, body } = await problemsCsv(req, d, req.params.id);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .send(body);
  });
}
```

In `app.ts`, after `await scope.register(importRoutes, deps);`, add `await scope.register(sheetRoutes, deps);` and its import.

The `idempotent: false` on drafts mirrors the 2A upload route: a draft is a new object on every press. Check what `idempotent` means in `apps/api/src/http/` before copying it; if the 2A upload uses it for a different reason, leave it off here.

- [ ] **Step 6: Add the probes and the audit wording**

Append to `PROBES` in `apps/api/test/probes.ts`:

```ts
  "GET /api/v1/integrations": { access: "integrations.manage" },
  "PUT /api/v1/integrations/google-sheets": { access: "integrations.manage", body: () => ({ enabled: false }) },
  "POST /api/v1/sheets/inspect": { access: "integrations.manage", body: () => ({ link: "not a link" }) },
  "POST /api/v1/sheets/drafts": { access: "integrations.manage", body: () => ({ sourceId: uuid }) },
  "POST /api/v1/sheets/sources": {
    access: "integrations.manage",
    body: () => ({ importId: uuid, name: "S", pollSeconds: 120, startFrom: "all" }),
  },
  "GET /api/v1/sheets/sources": { access: "integrations.manage" },
  "GET /api/v1/sheets/sources/:id": { access: "integrations.manage", path: () => `/api/v1/sheets/sources/${uuid}` },
  "PATCH /api/v1/sheets/sources/:id": {
    access: "integrations.manage",
    path: () => `/api/v1/sheets/sources/${uuid}`,
    body: () => ({ paused: true }),
  },
  "DELETE /api/v1/sheets/sources/:id": { access: "integrations.manage", path: () => `/api/v1/sheets/sources/${uuid}` },
  "POST /api/v1/sheets/sources/:id/sync": { access: "integrations.manage", path: () => `/api/v1/sheets/sources/${uuid}/sync` },
  "POST /api/v1/sheets/sources/:id/rows/:rowId/dismiss": {
    access: "integrations.manage",
    path: () => `/api/v1/sheets/sources/${uuid}/rows/1/dismiss`,
  },
  "GET /api/v1/sheets/sources/:id/problems.csv": {
    access: "integrations.manage",
    path: () => `/api/v1/sheets/sources/${uuid}/problems.csv`,
  },
```

Add to `AUDIT_ACTIONS` in `apps/web/src/lib/settings/audit.ts`:

```ts
  "integration.enabled": { area: "Settings", phrase: "switched on Google Sheets" },
  "integration.disabled": { area: "Settings", phrase: "switched off Google Sheets" },
  "sheet.connected": { area: "Leads", phrase: (d) => `connected the Google Sheet “${String(d.name ?? "")}”` },
  "sheet.mapping_changed": { area: "Leads", phrase: (d) => `changed the columns or rules of “${String(d.name ?? "")}”` },
  "sheet.paused": { area: "Leads", phrase: (d) => `paused the Google Sheet “${String(d.name ?? "")}”` },
  "sheet.resumed": { area: "Leads", phrase: (d) => `resumed the Google Sheet “${String(d.name ?? "")}”` },
  "sheet.removed": { area: "Leads", phrase: (d) => `removed the Google Sheet “${String(d.name ?? "")}”` },
  "sheet.needs_attention": { area: "Leads", phrase: (d) => `paused “${String(d.name ?? "")}” until someone looks at it` },
  "sheet.row_dismissed": { area: "Leads", phrase: (d) => `dismissed a problem row in “${String(d.name ?? "")}”` },
```

`integration.*` phrases name Google Sheets because it is the only module today. When a second module arrives, the phrase becomes `(d) => …d.module`.

- [ ] **Step 7: Run the tests** (this task's own, the imports tests, and the permission matrix)

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/sheets src/modules/imports test/'`
Expected: PASS, including the permission matrix, which now finds a probe for every new route.

- [ ] **Step 8: Gate and commit**

Message: `feat(api): switch Sheets on, connect a sheet through the 2A steps, and look after it — pause, test again, edit, problems, remove`, with the trailer.

---

### Task 9: Refresh and arrivals — the API behind the moment

**Files:**
- Create: `apps/api/src/modules/sheets/refresh.ts`
- Modify: `apps/api/src/modules/sheets/routes.ts`, `apps/api/src/modules/leads/routes.ts`, `apps/api/src/modules/leads/query.ts`, `apps/api/test/probes.ts`
- Test: `apps/api/src/modules/sheets/refresh.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/sheets/status` (`leads.view`) → `{ refresh: boolean; attention: { id: string; name: string }[] }`. The attention list is filled only for `integrations.manage`.
  - `POST /api/v1/sheets/refresh` (`leads.view`) → `{ id: string }`
  - `GET /api/v1/sheets/refresh/:id` (`leads.view`, only the person who pressed it) → `RefreshProgress`:

    ```ts
    { status: "running" | "done"; rowsRead: number; rowsTotal: number; created: number; merged: number; leadIds: string[]; unreachable: boolean; attention: { id: string; name: string }[] }
    ```

  - `GET /api/v1/leads/arrivals` (`leads.view`) → `{ since: string | null; count: number; ids: string[] }`
  - `POST /api/v1/leads/arrivals/seen` (`leads.view`) → 204
  - The list query gains `arrivedAfter` (an ISO datetime).
  - `arrivalsWhere(since: Date, me: string): SQL`, from `leads/query.ts`.

- [ ] **Step 1: Write the failing tests** `apps/api/src/modules/sheets/refresh.test.ts`

```ts
import { ALL_GRANTS, DEFAULT_RULES, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { sealConfig } from "./config";

let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;
let repEmail: string;
let spreadsheetId: string;
const HEAD = ["Timestamp", "Name", "Phone", "Owner"];

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true });
  const adminId = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  admin = await h.signIn(adminId);
  const repId = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true });
  rep = await h.signIn(repId);
  repEmail = (await h.queryAll<{ email: string }>("SELECT email FROM users WHERE id = $1", [repId]))[0]!.email;
  await admin.inject({ method: "PUT", url: "/api/v1/integrations/google-sheets", payload: { enabled: true } });
  spreadsheetId = `ss-${newId()}`;
  h.fake!.put(spreadsheetId, { title: "Enquiries", sharedWith: [h.fake!.email], tabs: [{ sheetId: 0, title: "Leads", rows: [HEAD] }] });
  const [{ id: pipelineId }] = await h.queryAll<{ id: string }>("SELECT id FROM pipelines WHERE is_default");
  const [{ id: stageId }] = await h.queryAll<{ id: string }>(
    "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position LIMIT 1",
    [pipelineId],
  );
  const id = newId();
  await h.pool.query(
    `INSERT INTO lead_sources (id, type, name, status, config_enc, mapping, rules, headers, column_settings, run_as)
     VALUES ($1, 'google_sheet', 'Enquiries', 'active', $2, $3, $4, $5, '{"dateOrders":{"0":"YMD"},"decimalMarks":{}}', $6)`,
    [
      id,
      sealConfig(h.keyring, id, { spreadsheetId, sheetId: 0, tabTitle: "Leads", headerRow: 1, auth: "service_account" }),
      {
        columns: [
          { column: 0, to: "field", field: "lead_created_at" },
          { column: 1, to: "field", field: "name" },
          { column: 2, to: "field", field: "phone" },
          { column: 3, to: "field", field: "owner" },
        ],
        createMissingTags: false,
      },
      DEFAULT_RULES({ pipelineId, stageId, country: "AE" }),
      JSON.stringify(HEAD),
      adminId,
    ],
  );
});
afterAll(async () => h.close());

const get = (c: AuthedClient, url: string) => c.inject({ method: "GET", url });
const post = (c: AuthedClient, url: string) => c.inject({ method: "POST", url });
const add = (rows: string[][]) => h.fake!.append(spreadsheetId, "Leads", rows);
const n = (i: number) => `0509${String(i).padStart(6, "0")}`;

describe("status", () => {
  it("shows Refresh to anyone who sees leads, and what needs attention only to admins", async () => {
    expect((await get(rep, "/api/v1/sheets/status")).json()).toEqual({ refresh: true, attention: [] });
    expect((await get(admin, "/api/v1/sheets/status")).json()).toEqual({ refresh: true, attention: [] });
  });
});

describe("a Refresh", () => {
  it("counts what each person can see: the admin all three, the rep the one given to them", async () => {
    await post(admin, "/api/v1/leads/arrivals/seen");
    add([
      ["2026-09-27 08:00", "Refresh One", n(1), ""],
      ["2026-09-27 08:05", "Refresh Two", n(2), repEmail],
      ["2026-09-27 08:10", "Refresh Three", n(3), ""],
    ]);
    const a = (await post(admin, "/api/v1/sheets/refresh")).json();
    const b = (await post(rep, "/api/v1/sheets/refresh")).json();
    expect(a.id).not.toBe(b.id);
    expect((await get(admin, `/api/v1/sheets/refresh/${a.id}`)).json()).toMatchObject({ status: "running", created: 0 });
    await h.runSyncs();
    const forAdmin = (await get(admin, `/api/v1/sheets/refresh/${a.id}`)).json();
    expect(forAdmin).toMatchObject({ status: "done", rowsRead: 3, rowsTotal: 3, created: 3, merged: 0, unreachable: false });
    expect(forAdmin.leadIds).toHaveLength(3);
    const forRep = (await get(rep, `/api/v1/sheets/refresh/${b.id}`)).json();
    expect(forRep).toMatchObject({ status: "done", created: 1 });
    // Only the person who pressed it can read it.
    expect((await get(rep, `/api/v1/sheets/refresh/${a.id}`)).statusCode).toBe(404);
  });

  it("Review Focus 2: a second press within 3 s is the same refresh; presses join one sync", async () => {
    add([["2026-09-27 09:00", "Refresh Four", n(4), ""]]);
    const a = (await post(admin, "/api/v1/sheets/refresh")).json();
    const again = (await post(admin, "/api/v1/sheets/refresh")).json();
    expect(again.id).toBe(a.id);
    const other = (await post(rep, "/api/v1/sheets/refresh")).json();
    const ids = await h.queryAll<{ sync_ids: string[] }>("SELECT sync_ids FROM source_refreshes WHERE id = ANY($1)", [[a.id, other.id]]);
    expect(ids[0]!.sync_ids).toEqual(ids[1]!.sync_ids);
    await h.runSyncs();
  });

  it("merges count separately; nothing new is simply done with zeros", async () => {
    add([["2026-09-27 10:00", "Refresh One (again)", n(1), ""]]);
    await new Promise((r) => setTimeout(r, 3100)); // past the 3 s window, so this is a new refresh
    const a = (await post(admin, "/api/v1/sheets/refresh")).json();
    await h.runSyncs();
    expect((await get(admin, `/api/v1/sheets/refresh/${a.id}`)).json()).toMatchObject({ created: 0, merged: 1 });
  });

  it("Google unreachable is said plainly, once the sync gives up", async () => {
    await h.pool.query("UPDATE lead_sources SET last_modified = NULL"); // make it read again
    h.fake!.fail(503, 20);
    await new Promise((r) => setTimeout(r, 3100));
    const a = (await post(admin, "/api/v1/sheets/refresh")).json();
    await h.runSyncs();
    expect((await get(admin, `/api/v1/sheets/refresh/${a.id}`)).json()).toMatchObject({ status: "done", unreachable: true });
    h.fake!.fail(503, 0);
  });
});

describe("arrivals", () => {
  it("counts leads that arrived since your last visit, not the ones you made yourself", async () => {
    await post(admin, "/api/v1/leads/arrivals/seen");
    expect((await get(admin, "/api/v1/leads/arrivals")).json()).toMatchObject({ count: 0, ids: [] });
    await h.pool.query("UPDATE lead_sources SET next_sync_at = now(), last_modified = NULL, failures = 0");
    add([["2026-09-27 11:00", "Arrival One", n(5), ""]]);
    await new Promise((r) => setTimeout(r, 3100));
    await post(admin, "/api/v1/sheets/refresh");
    await h.runSyncs();
    const mine = await admin.inject({ method: "POST", url: "/api/v1/leads", payload: { name: "Typed By Me" } });
    expect(mine.statusCode).toBe(201);
    const a = (await get(admin, "/api/v1/leads/arrivals")).json();
    expect(a.count).toBe(1);
    expect(typeof a.since).toBe("string");
    const list = (await get(admin, `/api/v1/leads?arrivedAfter=${encodeURIComponent(a.since)}`)).json();
    expect(list.items.map((l: { name: string }) => l.name)).toEqual(["Arrival One"]);
  });
});
```

The 3.1 s waits are deliberate: they step past the 3-second "same refresh" window of amendment A9. In total they add about 10 s to this file, which is acceptable.

If `POST /api/v1/leads` requires more than `name` (pipeline or stage), send what `leads.test.ts` sends for a minimal lead.

- [ ] **Step 2: Run it and watch it fail**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/sheets/refresh.test.ts'`
Expected: FAIL, with 404s.

- [ ] **Step 3: Implement** `apps/api/src/modules/sheets/refresh.ts`

```ts
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, newId } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { HttpError, notFound } from "../../http/errors";
import { requestSync } from "./requests";
import { sheetsOn } from "./service";

const S = schema.leadSources;
const SY = schema.sourceSyncs;
const RF = schema.sourceRefreshes;
/** Amendment A9: the same press twice, and a sync this fresh, aren't worth doing again. */
const SAME_PRESS_MS = 3000;
const FRESH_SYNC_MS = 10_000;
const GLOW_MAX = 20;
const ATTENTION_CODES = new Set(["ACCESS_LOST", "SHEET_GONE", "TAB_GONE", "COLUMNS_CHANGED", "TOO_MANY_ROWS", "RUN_AS_ACCESS"]);

export type RefreshProgress = {
  status: "running" | "done";
  rowsRead: number;
  rowsTotal: number;
  created: number;
  merged: number;
  leadIds: string[];
  unreachable: boolean;
  attention: { id: string; name: string }[];
};

/** Spec §8.1: Refresh shows with Sheets on and one sheet active; admins also hear what needs attention. */
export async function sheetsStatus(req: FastifyRequest, d: AppDeps) {
  if (!d.google || !(await sheetsOn(req))) return { refresh: false, attention: [] };
  const rows = await req.db
    .select({ id: S.id, name: S.name, status: S.status })
    .from(S)
    .where(and(eq(S.type, "google_sheet"), inArray(S.status, ["active", "needs_attention"])));
  return {
    refresh: rows.some((r) => r.status === "active"),
    attention: can(req.actor!, "integrations.manage")
      ? rows.filter((r) => r.status === "needs_attention").map(({ id, name }) => ({ id, name }))
      : [],
  };
}

export async function startRefresh(req: FastifyRequest, d: AppDeps): Promise<{ id: string }> {
  if (!d.google || !(await sheetsOn(req)))
    throw new HttpError(409, "SHEETS_OFF", "Google Sheets is switched off.");
  const me = req.actor!.userId;
  const [recent] = await req.db
    .select({ id: RF.id })
    .from(RF)
    .where(and(eq(RF.requestedBy, me), gt(RF.createdAt, new Date(Date.now() - SAME_PRESS_MS))))
    .orderBy(desc(RF.createdAt))
    .limit(1);
  if (recent) return { id: recent.id };
  const sources = await req.db
    .select({ id: S.id })
    .from(S)
    .where(and(eq(S.type, "google_sheet"), eq(S.status, "active")));
  if (!sources.length) throw new HttpError(409, "NO_SHEETS", "No Google Sheet is connected.");
  const syncIds: string[] = [];
  const fresh: string[] = [];
  for (const s of sources) {
    const r = await requestSync(req.db, { sourceId: s.id, trigger: "refresh", requestedBy: me, reuseWithinMs: FRESH_SYNC_MS });
    if (!r) continue;
    syncIds.push(r.syncId);
    if (r.fresh) fresh.push(r.syncId);
  }
  const id = newId();
  await req.db.insert(RF).values({ id, requestedBy: me, syncIds });
  req.afterCommit(() => fresh.forEach((s) => void d.sheets?.enqueue(s)));
  return { id };
}

/**
 * Spec §8.2: progress summed over the syncs this refresh started or joined. The counts are of leads the
 * viewer can see — the query runs under their own row-level security — so a rep hears "for you".
 */
export async function refreshProgress(req: FastifyRequest, id: string): Promise<RefreshProgress> {
  const [r] = await req.db
    .select()
    .from(RF)
    .where(and(eq(RF.id, id), eq(RF.requestedBy, req.actor!.userId)));
  if (!r) throw notFound("REFRESH_NOT_FOUND", "Refresh not found");
  const syncs = r.syncIds.length
    ? await req.db
        .select({ s: SY, name: S.name, sourceStatus: S.status })
        .from(SY)
        .innerJoin(S, eq(S.id, SY.sourceId))
        .where(inArray(SY.id, r.syncIds))
    : [];
  const running = syncs.some((x) => x.s.status === "queued" || x.s.status === "running");
  const { rows } = r.syncIds.length
    ? await req.db.execute<{ result: "created" | "merged"; lead_id: string }>(sql`
        SELECT sr.result, sr.lead_id FROM source_rows sr
        JOIN leads l ON l.id = sr.lead_id AND l.deleted_at IS NULL
        WHERE sr.sync_id = ANY(${r.syncIds}::uuid[]) AND sr.result IN ('created', 'merged')
        ORDER BY sr.result, sr.id DESC`)
    : { rows: [] };
  const created = rows.filter((x) => x.result === "created");
  const merged = rows.filter((x) => x.result === "merged");
  const failedAll = syncs.length > 0 && syncs.every((x) => x.s.status === "failed");
  return {
    status: running ? "running" : "done",
    rowsRead: syncs.reduce((n, x) => n + x.s.rowsRead, 0),
    rowsTotal: syncs.reduce((n, x) => n + x.s.rowsTotal, 0),
    created: created.length,
    merged: merged.length,
    leadIds: [...new Set([...created, ...merged].map((x) => x.lead_id))].slice(0, GLOW_MAX),
    // Unreachable: every sync failed for a passing reason (not something a person must fix).
    unreachable: !running && failedAll && syncs.every((x) => !ATTENTION_CODES.has(x.s.error ?? "")),
    attention: can(req.actor!, "integrations.manage")
      ? syncs.filter((x) => x.sourceStatus === "needs_attention").map((x) => ({ id: x.s.sourceId, name: x.name }))
      : [],
  };
}
```

Add to `sheets/routes.ts`:

```ts
  const view = { permission: "leads.view" as const };
  r.get("/api/v1/sheets/status", { config: view }, (req) => sheetsStatus(req, d));
  r.post("/api/v1/sheets/refresh", { config: { ...view, idempotent: false } }, (req) => startRefresh(req, d));
  r.get("/api/v1/sheets/refresh/:id", { config: view, schema: { params } }, (req) => refreshProgress(req, req.params.id));
```

- [ ] **Step 4: Arrivals** (`leads/query.ts` and `leads/routes.ts`)

In `query.ts` (where `L = schema.leads`), export:

```ts
/**
 * Spec §8.3: a lead "arrived" after `since` unless the viewer made it themselves — a sheet's leads always
 * arrive, even for the admin the sheet runs as. Row-level security still decides which leads are seen.
 */
export const arrivalsWhere = (since: Date, me: string) =>
  sql`(${L.createdAt} > ${since} AND (${L.createdBy} IS DISTINCT FROM ${me} OR EXISTS (SELECT 1 FROM lead_sources s WHERE s.id = ${L.sourceId} AND s.type = 'google_sheet')))`;
```

Add `arrivedAfter?: string` to the query type. Next to the `source` filter (`if (q.source) where.push(...)`), add:
`if (q.arrivedAfter) where.push(arrivalsWhere(new Date(q.arrivedAfter), req.actor!.userId));`

In `routes.ts`, add `arrivedAfter: z.iso.datetime({ offset: true }).optional(),` to `listQuery`, and add the routes below. Register them **before** `/api/v1/leads/:id`, so "arrivals" is never read as an id.

```ts
  r.get("/api/v1/leads/arrivals", { config: { permission: "leads.view" } }, async (req) => {
    const [u] = await req.db
      .select({ at: schema.users.leadsSeenAt })
      .from(schema.users)
      .where(eq(schema.users.id, req.actor!.userId));
    if (!u?.at) return { since: null, count: 0, ids: [] };
    const where = and(isNull(schema.leads.deletedAt), arrivalsWhere(u.at, req.actor!.userId));
    const [c] = await req.db.select({ n: count() }).from(schema.leads).where(where);
    const ids = await req.db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(where)
      .orderBy(desc(schema.leads.createdAt))
      .limit(20);
    return { since: u.at.toISOString(), count: Number(c?.n ?? 0), ids: ids.map((x) => x.id) };
  });
  // The marker moves with the server's clock (amendment A8): leaving Leads, or hiding its tab.
  r.post("/api/v1/leads/arrivals/seen", { config: { permission: "leads.view" } }, async (req, reply) => {
    await req.db.update(schema.users).set({ leadsSeenAt: new Date() }).where(eq(schema.users.id, req.actor!.userId));
    return reply.code(204).send();
  });
```

Import `and`, `count`, `desc`, `eq`, `isNull` from drizzle-orm, `schema` from `@lume/db`, and `arrivalsWhere`.

If row-level security on `users` stops a person updating their own row outside `me/service.ts`, move the update into a `markLeadsSeen(req)` in `me/service.ts`. It already updates the caller's own row, so its access pattern is known to work.

- [ ] **Step 5: Add the probes**

```ts
  "GET /api/v1/sheets/status": { access: "leads.view" },
  "POST /api/v1/sheets/refresh": { access: "leads.view" },
  "GET /api/v1/sheets/refresh/:id": { access: "leads.view", path: () => `/api/v1/sheets/refresh/${uuid}` },
  "GET /api/v1/leads/arrivals": { access: "leads.view" },
  "POST /api/v1/leads/arrivals/seen": { access: "leads.view" },
```

- [ ] **Step 6: Run the tests**

Run: `bash scripts/dev.sh run bash -c 'pnpm --filter @lume/api exec vitest run src/modules/sheets src/modules/leads test/'`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

Message: `feat(api): Refresh brings sheets in now and reports what each person can see; leads that arrived since your last visit`, with the trailer.

---
### Task 10: Web — the Sheets client, and Settings → Integrations

The screens follow `apple-design` throughout:
- one card per module;
- the official mark on a white tile;
- the switch on the right;
- the thing to copy is one tap away;
- every sheet row shows at a glance whether it's working.

**Files:**
- Create: `apps/web/src/lib/sheets/types.ts`, `apps/web/src/lib/sheets/client.ts`, `apps/web/src/lib/sheets/format.ts`, `apps/web/src/components/integrations/Integrations.tsx`, `apps/web/src/components/integrations/SheetSourceList.tsx`, `apps/web/src/components/integrations/AttentionBanner.tsx`, `apps/web/src/components/integrations/integrations.module.css`, `apps/web/src/app/(app)/settings/integrations/page.tsx`
- Modify: `apps/web/src/lib/settings/areas.ts`, `apps/web/src/lib/leads/history.ts`
- Test: `apps/web/src/lib/sheets/format.test.ts`, `apps/web/src/components/integrations/Integrations.test.tsx`, `apps/web/src/lib/leads/history.test.ts` (append; create the file if it doesn't exist)

**Interfaces:**
- Consumes: the Task 8 and 9 endpoints.
- Produces:
  - `sheetsClient`, with `integrations`, `setEnabled`, `inspect`, `draft`, `save`, `list`, `get`, `patch`, `remove`, `sync`, `dismiss`, `status`, `refresh`, `progress`, `arrivals` and `seen`.
  - The types `IntegrationsView`, `InspectView`, `SheetDraft`, `SheetSourceView`, `SheetSourceDetail`, `SyncView`, `ProblemRowView`, `SheetsStatus`, `RefreshProgress` and `Arrivals`.
  - `ago(iso: string, now?: number): string` and `inFuture(iso: string, now?: number): string`.
  - `AttentionBanner({ items }: { items: { id: string; name: string }[] })`.
  - `Integrations()`.
  - `SheetSourceList({ sources })`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/sheets/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ago, inFuture } from "./format";

const now = Date.parse("2026-09-27T10:00:00Z");
describe("relative times", () => {
  it("says how long ago, in words people use", () => {
    expect(ago("2026-09-27T09:59:40Z", now)).toBe("just now");
    expect(ago("2026-09-27T09:58:00Z", now)).toBe("2 min ago");
    expect(ago("2026-09-27T07:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-09-25T10:00:00Z", now)).toBe("2 days ago");
  });
  it("says how soon", () => {
    expect(inFuture("2026-09-27T10:00:20Z", now)).toBe("in a moment");
    expect(inFuture("2026-09-27T10:02:00Z", now)).toBe("in 2 min");
    expect(inFuture("2026-09-27T09:00:00Z", now)).toBe("in a moment"); // overdue: it's about to happen
  });
});
```

`apps/web/src/components/integrations/Integrations.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsClient } from "@/lib/sheets/client";
import type { SheetSourceView } from "@/lib/sheets/types";
import { Integrations } from "./Integrations";

vi.mock("@/lib/sheets/client", () => ({
  sheetsClient: { integrations: vi.fn(), setEnabled: vi.fn(), list: vi.fn() },
}));
vi.mock("@/components/sheets/AddSheetSheet", () => ({
  AddSheetSheet: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Add a sheet" /> : null),
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const on = { googleSheets: { enabled: true, available: true, email: "lume@p.iam.gserviceaccount.com" } };
const src = (over: Partial<SheetSourceView>): SheetSourceView => ({
  id: "s1",
  name: "Website enquiries",
  status: "active",
  attention: null,
  tabTitle: "Form responses",
  link: "https://docs.google.com/spreadsheets/d/x/edit#gid=0",
  pollSeconds: 120,
  lastSyncedAt: new Date(Date.now() - 120_000).toISOString(),
  nextSyncAt: null,
  syncing: false,
  failing: false,
  lastError: null,
  newColumns: [],
  newToday: 12,
  newAllTime: 340,
  problems: 0,
  runAs: { id: "u1", name: "Riya Sharma" },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("Settings → Integrations", () => {
  it("is off by default: one switch, and nothing else to do", async () => {
    vi.mocked(sheetsClient.integrations).mockResolvedValue(ok({ googleSheets: { ...on.googleSheets, enabled: false } }));
    render(<Integrations />);
    const sw = await screen.findByRole("switch", { name: "Google Sheets" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Add a sheet" })).toBeNull();
    expect(screen.getByRole("img", { name: "" })).toHaveAttribute("src", "/brand/google-sheets.png");
  });

  it("without a Google key on the server, says who can set it up instead of a switch", async () => {
    vi.mocked(sheetsClient.integrations).mockResolvedValue(ok({ googleSheets: { enabled: false, available: false, email: null } }));
    render(<Integrations />);
    expect(await screen.findByText(/isn't set up on this server yet/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("switched on: the email to share with (copyable), every sheet's health, and Add a sheet", async () => {
    vi.mocked(sheetsClient.integrations).mockResolvedValue(ok(on));
    vi.mocked(sheetsClient.list).mockResolvedValue(
      ok({
        sources: [
          src({}),
          src({ id: "s2", name: "Ads leads", status: "needs_attention", attention: { code: "ACCESS_LOST", message: "LUME can't open this sheet any more." }, newToday: 0 }),
        ],
      }),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Integrations />);
    expect(await screen.findByText("lume@p.iam.gserviceaccount.com")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Copy email" }));
    expect(writeText).toHaveBeenCalledWith("lume@p.iam.gserviceaccount.com");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    const first = screen.getByRole("link", { name: /Website enquiries/ });
    expect(first).toHaveAttribute("href", "/settings/integrations/s1");
    expect(within(first).getByText(/Checked 2 min ago · 12 new today/)).toBeInTheDocument();
    expect(within(screen.getByRole("link", { name: /Ads leads/ })).getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("“Ads leads” needs attention");
    await userEvent.click(screen.getByRole("button", { name: "Add a sheet" }));
    expect(screen.getByRole("dialog", { name: "Add a sheet" })).toBeInTheDocument();
  });

  it("switching on asks the server, then shows what's there", async () => {
    vi.mocked(sheetsClient.integrations).mockResolvedValue(ok({ googleSheets: { ...on.googleSheets, enabled: false } }));
    vi.mocked(sheetsClient.setEnabled).mockResolvedValue(ok(on));
    vi.mocked(sheetsClient.list).mockResolvedValue(ok({ sources: [] }));
    render(<Integrations />);
    await userEvent.click(await screen.findByRole("switch", { name: "Google Sheets" }));
    expect(sheetsClient.setEnabled).toHaveBeenCalledWith(true);
    expect(await screen.findByText(/No sheets yet/)).toBeInTheDocument();
  });
});
```

`apps/web/src/lib/leads/history.test.ts`: find the existing describe for `describeActivity` (or whatever `history.ts` exports; read its top) and add:

```ts
  it("a lead from a Google Sheet says which sheet and row", () => {
    const d = describeActivity({ type: "imported", payload: { sourceId: "s1", sheet: "Website enquiries", row: 14 }, actorName: null } as never);
    expect(d.title).toBe("Imported");
    expect(d.detail).toContain("from Website enquiries, row 14");
  });
```

Use the real export name and argument shape from `history.ts`, which you have open; the assertion is what matters.

- [ ] **Step 2: Run them and watch them fail**

Run: `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec vitest run src/lib/sheets src/components/integrations src/lib/leads/history.test.ts'`
Expected: FAIL (the modules don't exist yet; the history detail lacks the sheet).

- [ ] **Step 3: Implement the types, client and format**

`apps/web/src/lib/sheets/types.ts` mirrors the API types (Tasks 8 and 9):

```ts
import type { DraftView } from "@/lib/imports/types";

export type IntegrationsView = { googleSheets: { enabled: boolean; available: boolean; email: string | null } };
export type InspectView = {
  spreadsheetId: string;
  title: string;
  gid: number | null;
  tabs: { sheetId: number; title: string }[];
  email: string;
};
export type SheetDraft = {
  draft: DraftView;
  sheet: { title: string; name: string; tabTitle: string; email: string; moreRows: boolean; editing: string | null };
};
export type SheetStatus = "active" | "paused" | "needs_attention";
export type SheetSourceView = {
  id: string;
  name: string;
  status: SheetStatus;
  attention: { code: string; message: string } | null;
  tabTitle: string;
  link: string;
  pollSeconds: number;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  syncing: boolean;
  failing: boolean;
  lastError: string | null;
  newColumns: string[];
  newToday: number;
  newAllTime: number;
  problems: number;
  runAs: { id: string; name: string } | null;
};
export type SyncView = {
  id: string;
  trigger: "schedule" | "refresh" | "connect" | "manual";
  status: "queued" | "running" | "done" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  created: number;
  merged: number;
  errors: number;
  error: string | null;
};
export type ProblemRowView = { id: number; rowNumber: number; problems: { code: string; message: string }[]; lastTriedAt: string };
export type SheetSourceDetail = SheetSourceView & { syncs: SyncView[]; problemRows: ProblemRowView[] };
export type SheetsStatus = { refresh: boolean; attention: { id: string; name: string }[] };
export type RefreshProgress = {
  status: "running" | "done";
  rowsRead: number;
  rowsTotal: number;
  created: number;
  merged: number;
  leadIds: string[];
  unreachable: boolean;
  attention: { id: string; name: string }[];
};
export type Arrivals = { since: string | null; count: number; ids: string[] };
/** Attention that "Test again" can clear; the rest need the columns opened and saved. */
export const RETRYABLE = new Set(["ACCESS_LOST", "SHEET_GONE", "TAB_GONE", "TOO_MANY_ROWS"]);
```

`apps/web/src/lib/sheets/client.ts`:

```ts
"use client";
import { api } from "@/lib/api";
import type {
  Arrivals,
  InspectView,
  IntegrationsView,
  RefreshProgress,
  SheetDraft,
  SheetSourceDetail,
  SheetSourceView,
  SheetsStatus,
} from "./types";

const src = (id: string) => `/api/v1/sheets/sources/${encodeURIComponent(id)}`;

export const sheetsClient = {
  integrations: () => api.get<IntegrationsView>("/api/v1/integrations"),
  setEnabled: (enabled: boolean) => api.put<IntegrationsView>("/api/v1/integrations/google-sheets", { enabled }),
  inspect: (link: string) => api.post<InspectView>("/api/v1/sheets/inspect", { link }),
  draft: (b: { link: string; sheetId: number; headerRow?: number } | { sourceId: string }) =>
    api.post<SheetDraft>("/api/v1/sheets/drafts", b),
  save: (b: { importId: string; name: string; pollSeconds: number; startFrom: "all" | "new" }) =>
    api.post<SheetSourceView>("/api/v1/sheets/sources", b),
  list: () => api.get<{ sources: SheetSourceView[] }>("/api/v1/sheets/sources"),
  get: (id: string) => api.get<SheetSourceDetail>(src(id)),
  patch: (id: string, p: { name?: string; pollSeconds?: number; paused?: boolean }) => api.patch<SheetSourceView>(src(id), p),
  remove: (id: string) => api.del<null>(src(id)),
  sync: (id: string) => api.post<{ syncId: string | null }>(`${src(id)}/sync`),
  dismiss: (id: string, rowId: number) => api.post<null>(`${src(id)}/rows/${rowId}/dismiss`),
  problemsUrl: (id: string) => `${src(id)}/problems.csv`,
  status: () => api.get<SheetsStatus>("/api/v1/sheets/status"),
  refresh: () => api.post<{ id: string }>("/api/v1/sheets/refresh"),
  progress: (id: string) => api.get<RefreshProgress>(`/api/v1/sheets/refresh/${encodeURIComponent(id)}`),
  arrivals: () => api.get<Arrivals>("/api/v1/leads/arrivals"),
  seen: () => api.post<null>("/api/v1/leads/arrivals/seen"),
};
```

`apps/web/src/lib/sheets/format.ts`:

```ts
/** "just now", "2 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
/** "in a moment", "in 2 min", "in 1 h". Overdue reads as "in a moment": it's about to happen. */
export function inFuture(iso: string, now = Date.now()): string {
  const s = (Date.parse(iso) - now) / 1000;
  if (s < 60) return "in a moment";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  return `in ${Math.round(s / 3600)} h`;
}
```

- [ ] **Step 4: Implement the Integrations screens**

`apps/web/src/components/integrations/AttentionBanner.tsx`:

```tsx
import Link from "next/link";
import s from "./integrations.module.css";

/** Spec §5.4: admins hear which sheet needs them, where they already are (Leads, Settings). No bell yet. */
export function AttentionBanner({ items }: { items: { id: string; name: string }[] }) {
  if (!items.length) return null;
  const one = items.length === 1 ? items[0]! : null;
  return (
    <div role="status" className={s.banner}>
      <span className={s.bannerDot} aria-hidden />
      <span>{one ? `“${one.name}” needs attention` : `${items.length} sheets need attention`}</span>
      <Link href={one ? `/settings/integrations/${one.id}` : "/settings/integrations"} className={s.bannerLink}>
        Take a look
      </Link>
    </div>
  );
}
```

`apps/web/src/components/integrations/SheetSourceList.tsx`:

```tsx
import Link from "next/link";
import { ago } from "@/lib/sheets/format";
import type { SheetSourceView, SheetStatus } from "@/lib/sheets/types";
import s from "./integrations.module.css";

const STATUS: Record<SheetStatus, string> = { active: "Active", paused: "Paused", needs_attention: "Needs attention" };
const n = (v: number) => v.toLocaleString("en");

/** "Checked 2 min ago · 12 new today · 1 problem": is it working, and is it bringing leads? */
function health(v: SheetSourceView): string {
  const parts = [
    v.syncing ? "Checking now" : v.lastSyncedAt ? `Checked ${ago(v.lastSyncedAt)}` : "Not checked yet",
    `${n(v.newToday)} new today`,
    v.problems ? `${n(v.problems)} ${v.problems === 1 ? "problem" : "problems"}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function SheetSourceList({ sources }: { sources: SheetSourceView[] }) {
  if (!sources.length)
    return <p className={s.empty}>No sheets yet. Add one, and its new rows become leads on their own.</p>;
  return (
    <ul className={s.sources}>
      {sources.map((v) => (
        <li key={v.id}>
          <Link href={`/settings/integrations/${v.id}`} className={s.source}>
            <span className={s.sourceName}>{v.name}</span>
            <span className={s.sourceMeta}>{v.failing ? "LUME hasn't reached Google for a while" : health(v)}</span>
            <span className={s.pill} data-status={v.failing ? "failing" : v.status}>
              {STATUS[v.status]}
            </span>
            <svg className={s.chev} viewBox="0 0 12 12" width="12" height="12" aria-hidden>
              <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </li>
      ))}
    </ul>
  );
}
```

`apps/web/src/components/integrations/Integrations.tsx`:

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { AddSheetSheet } from "@/components/sheets/AddSheetSheet";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { sheetsClient } from "@/lib/sheets/client";
import type { IntegrationsView, SheetSourceView } from "@/lib/sheets/types";
import { AttentionBanner } from "./AttentionBanner";
import { SheetSourceList } from "./SheetSourceList";
import s from "./integrations.module.css";

/** Spec §7.1: each optional module is one card — what it does, a switch, and what it needs from you. */
export function Integrations() {
  const [view, setView] = useState<IntegrationsView | null>(null);
  const [sources, setSources] = useState<SheetSourceView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSources = useCallback(async () => {
    const r = await sheetsClient.list();
    if (r.ok) setSources(r.data.sources);
  }, []);
  useEffect(() => {
    void sheetsClient.integrations().then((r) => {
      if (!r.ok) return setError(r.message);
      setView(r.data);
      if (r.data.googleSheets.enabled) void loadSources();
    });
  }, [loadSources]);

  if (error) return <p role="alert" className={s.error}>{error}</p>;
  if (!view) return null;
  const g = view.googleSheets;

  const toggle = async (enabled: boolean) => {
    setError(null);
    const r = await sheetsClient.setEnabled(enabled);
    if (!r.ok) return setError(r.message);
    setView(r.data);
    if (enabled) void loadSources();
  };
  const copy = async () => {
    if (!g.email) return;
    await navigator.clipboard.writeText(g.email);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <>
      <AttentionBanner items={(sources ?? []).filter((x) => x.status === "needs_attention")} />
      <article className={s.card} aria-labelledby="gs-title">
        <header className={s.cardHead}>
          <span className={s.brandTile}>
            <img src="/brand/google-sheets.png" alt="" width={28} height={28} />
          </span>
          <div className={s.cardText}>
            <h2 id="gs-title" className={s.cardTitle}>
              Google Sheets
            </h2>
            <p className={s.cardLede}>New rows in your sheets become leads — every few minutes, or at once with Refresh.</p>
          </div>
          {g.available && <Switch checked={g.enabled} onChange={(v) => void toggle(v)} label="Google Sheets" />}
        </header>
        {!g.available && (
          <p className={s.note}>
            Google Sheets isn't set up on this server yet. The person who installed LUME can add its Google key.
          </p>
        )}
        {g.enabled && g.email && (
          <>
            <div className={s.share}>
              <span className={s.shareLabel}>Share each sheet with LUME as a Viewer:</span>
              <code className={s.email}>{g.email}</code>
              <Button size="sm" aria-label={copied ? "Copied" : "Copy email"} onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {sources && <SheetSourceList sources={sources} />}
            <div className={s.cardFoot}>
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add a sheet
              </Button>
            </div>
          </>
        )}
      </article>
      <AddSheetSheet
        open={adding}
        onClose={() => {
          setAdding(false);
          void loadSources();
        }}
      />
    </>
  );
}
```

`apps/web/src/components/integrations/integrations.module.css`:

```css
.card {
  background: var(--raised);
  border-radius: var(--r-card);
  box-shadow: 0 0 0 0.5px var(--line-2);
  padding: 20px;
  display: grid;
  gap: 16px;
}
.cardHead {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 14px;
}
/* The official mark on a white tile in both themes, never recoloured. */
.brandTile {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: #fff;
  display: grid;
  place-items: center;
  box-shadow: 0 0 0 0.5px rgba(12, 18, 32, 0.12), 0 2px 8px rgba(12, 18, 32, 0.08);
}
.cardTitle {
  font-size: var(--fs-lg);
  letter-spacing: var(--ls-lg);
  font-weight: var(--fw-semibold);
  margin: 0;
}
.cardLede,
.note,
.empty {
  color: var(--text-2);
  font-size: var(--fs-sm);
  margin: 2px 0 0;
}
.share {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  padding: 12px 14px;
  border-radius: var(--r-ctl);
  background: var(--sunk);
}
.shareLabel {
  color: var(--text-2);
  font-size: var(--fs-sm);
}
.email {
  font: var(--fw-medium) var(--fs-sm) / 1.4 var(--font);
  user-select: all;
  word-break: break-all;
}
.sources {
  list-style: none;
  margin: 0;
  padding: 0;
  border-radius: var(--r-ctl);
  box-shadow: 0 0 0 0.5px var(--line);
  overflow: hidden;
}
.sources li + li {
  border-top: 0.5px solid var(--line);
}
.source {
  display: grid;
  grid-template-columns: 1fr auto auto;
  grid-template-areas: "name pill chev" "meta pill chev";
  align-items: center;
  column-gap: 12px;
  padding: 12px 14px;
  color: inherit;
  text-decoration: none;
  transition: background 120ms ease-out;
}
.source:hover {
  background: var(--hover);
}
.source:active {
  background: var(--press);
}
.sourceName {
  grid-area: name;
  font-weight: var(--fw-semibold);
}
.sourceMeta {
  grid-area: meta;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
}
.pill {
  grid-area: pill;
  font-size: var(--fs-xs);
  font-weight: var(--fw-semibold);
  padding: 3px 9px;
  border-radius: 99px;
  background: var(--ok-soft);
  color: var(--ok-ink);
}
.pill[data-status="paused"] {
  background: var(--sunk);
  color: var(--text-2);
}
.pill[data-status="needs_attention"],
.pill[data-status="failing"] {
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.chev {
  grid-area: chev;
  color: var(--text-3);
}
.cardFoot {
  display: flex;
  justify-content: flex-end;
}
.banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  margin-bottom: 14px;
  border-radius: var(--r-ctl);
  background: var(--warn-soft);
  color: var(--warn-ink);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
}
.bannerDot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warn);
}
.bannerLink {
  margin-left: auto;
  color: inherit;
  font-weight: var(--fw-semibold);
}
.error {
  color: var(--danger-ink);
}
@media (max-width: 640px) {
  .cardHead {
    grid-template-columns: auto 1fr;
  }
  .cardHead > :last-child {
    grid-column: 1 / -1;
  }
}
```

The `AddSheetSheet` import resolves once Task 11 creates it. Until then, create `apps/web/src/components/sheets/AddSheetSheet.tsx` with a stand-in, `export function AddSheetSheet(_: { open: boolean; sourceId?: string; onClose(): void }) { return null; }`, which Task 11 replaces. This task's test mocks it anyway.

- [ ] **Step 5: The page, the area, and the history line**

`apps/web/src/app/(app)/settings/integrations/page.tsx`:

```tsx
import { Integrations } from "@/components/integrations/Integrations";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Integrations · Settings · LUME" };

export default async function Page() {
  await requirePermission("integrations.manage");
  return (
    <SettingsPage title="Integrations" description="Optional connections. Each one is off until you switch it on.">
      <Integrations />
    </SettingsPage>
  );
}
```

In `lib/settings/areas.ts`, after the `imports` area:

```ts
  {
    id: "integrations",
    title: "Integrations",
    blurb: "Google Sheets and other optional connections",
    href: "/settings/integrations",
    anyOf: ["integrations.manage"],
    group: "workspace",
  },
```

If `areas.test.ts` pins the list of area ids, add `"integrations"` there.

In `lib/leads/history.ts`, the `imported`/`imported_again` case's `from`:

```ts
      const origin = p.file ?? p.sheet;
      const from = origin ? `from ${String(origin)}${p.row ? `, row ${String(p.row)}` : ""}` : undefined;
```

- [ ] **Step 6: Run the tests**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 7: Gate and commit**

Message: `feat(web): Settings → Integrations — Google Sheets on one card, off by default, with every sheet's health at a glance`, with the trailer.

---

### Task 11: Web — Add a sheet (the wizard)

This reuses the Import sheet's frame, rail and steps. The first step is the sheet (link, tab, header row), and the last is **Start from**.

**Files:**
- Create (replacing the Task 10 stand-in): `apps/web/src/components/sheets/AddSheetSheet.tsx`
- Create: `apps/web/src/components/sheets/SheetStep.tsx`, `apps/web/src/components/sheets/StartFromStep.tsx`
- Modify:
  - `apps/web/src/components/imports/PreviewStep.tsx`: an optional `onContinue`.
  - `apps/web/src/components/imports/ColumnsStep.tsx`: an optional `notice`.
- Test: `apps/web/src/components/sheets/AddSheetSheet.test.tsx`

**Interfaces:**
- Consumes: `sheetsClient` (Task 10), `importsClient.patch`/`discard` (2A), `ColumnsStep`, `RulesStep`, `PreviewStep`, `COLUMN_CODES` and `imports.module.css` (2A).
- Produces: `AddSheetSheet({ open, sourceId, onClose }: { open: boolean; sourceId?: string; onClose(savedId?: string): void })`. With `sourceId` it edits that sheet's columns and rules, starting at Columns.

- [ ] **Step 1: Write the failing test** `apps/web/src/components/sheets/AddSheetSheet.test.tsx`

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importsClient } from "@/lib/imports/client";
import type { DraftView } from "@/lib/imports/types";
import { sheetsClient } from "@/lib/sheets/client";
import { AddSheetSheet } from "./AddSheetSheet";

vi.mock("@/lib/sheets/client", () => ({ sheetsClient: { inspect: vi.fn(), draft: vi.fn(), save: vi.fn() } }));
vi.mock("@/lib/imports/client", () => ({ importsClient: { patch: vi.fn(), discard: vi.fn() } }));
// The 2A steps are tested on their own; here they only need to move the wizard along.
vi.mock("@/components/imports/ColumnsStep", () => ({
  ColumnsStep: ({ onContinue, notice }: { onContinue(): void; notice?: React.ReactNode }) => (
    <div>
      <h3>Columns</h3>
      {notice}
      <button onClick={onContinue}>Continue</button>
    </div>
  ),
}));
vi.mock("@/components/imports/RulesStep", () => ({
  RulesStep: ({ onContinue }: { onContinue(): void }) => <button onClick={onContinue}>Continue</button>,
}));
vi.mock("@/components/imports/PreviewStep", () => ({
  PreviewStep: ({ onContinue }: { onContinue?(): void }) => <button onClick={onContinue}>Continue</button>,
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const draft = { id: "d1", headers: ["Timestamp", "Name"], headerRow: 1, rowCount: 42, problems: [], mapping: { columns: [{ column: 1, to: "field", field: "name" }], createMissingTags: false } } as unknown as DraftView;
const sheetDraft = { draft, sheet: { title: "Website enquiries", name: "Website enquiries", tabTitle: "Form responses", email: "lume@x.iam.gserviceaccount.com", moreRows: false, editing: null } };

beforeEach(() => vi.clearAllMocks());

describe("Add a sheet", () => {
  it("link → tab → the 2A steps → start from → saved", async () => {
    vi.mocked(sheetsClient.inspect).mockResolvedValue(
      ok({ spreadsheetId: "abc", title: "Website enquiries", gid: 9, tabs: [{ sheetId: 0, title: "Old" }, { sheetId: 9, title: "Form responses" }], email: "lume@x.iam.gserviceaccount.com" }),
    );
    vi.mocked(sheetsClient.draft).mockResolvedValue({ ...ok(sheetDraft), status: 201 });
    vi.mocked(sheetsClient.save).mockResolvedValue({ ...ok({ id: "s1" } as never), status: 201 });
    const onClose = vi.fn();
    render(<AddSheetSheet open onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Add a sheet" });
    expect(dialog).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Sheet link"), "https://docs.google.com/spreadsheets/d/abc/edit#gid=9");
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByLabelText("Tab")).toHaveValue("9"); // the tab the link pointed at
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(sheetsClient.draft).toHaveBeenCalledWith({ link: "https://docs.google.com/spreadsheets/d/abc/edit#gid=9", sheetId: 9 });
    // No date column mapped: LUME says why it matters.
    expect(await screen.findByText(/can't tell a repeat enquiry/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" })); // Columns
    await userEvent.click(screen.getByRole("button", { name: "Continue" })); // Rules
    await userEvent.click(screen.getByRole("button", { name: "Continue" })); // Preview
    expect(screen.getByLabelText("Name")).toHaveValue("Website enquiries");
    await userEvent.click(screen.getByRole("radio", { name: /Only rows added from now on/ }));
    await userEvent.selectOptions(screen.getByLabelText("Check for new rows"), "300");
    await userEvent.click(screen.getByRole("button", { name: "Connect sheet" }));
    expect(sheetsClient.save).toHaveBeenCalledWith({ importId: "d1", name: "Website enquiries", pollSeconds: 300, startFrom: "new" });
    expect(onClose).toHaveBeenCalledWith("s1");
  });

  it("an unshared sheet says exactly what to do, with the email", async () => {
    vi.mocked(sheetsClient.inspect).mockResolvedValue({
      ok: false,
      status: 409,
      code: "SHEET_NO_ACCESS",
      message: "LUME can't open this sheet yet. Share it with lume@x.iam.gserviceaccount.com as a Viewer, then try again.",
    } as never);
    render(<AddSheetSheet open onClose={() => undefined} />);
    await userEvent.type(screen.getByLabelText("Sheet link"), "https://docs.google.com/spreadsheets/d/abc/edit");
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Share it with lume@x.iam.gserviceaccount.com");
  });

  it("editing a sheet starts at Columns, has no Start from choice, and saves", async () => {
    vi.mocked(sheetsClient.draft).mockResolvedValue({ ...ok({ ...sheetDraft, sheet: { ...sheetDraft.sheet, editing: "s1" } }), status: 201 });
    vi.mocked(sheetsClient.save).mockResolvedValue(ok({ id: "s1" } as never));
    const onClose = vi.fn();
    render(<AddSheetSheet open sourceId="s1" onClose={onClose} />);
    expect(await screen.findByRole("heading", { name: "Columns" })).toBeInTheDocument();
    for (let i = 0; i < 3; i++) await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByRole("radio")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(sheetsClient.save).toHaveBeenCalledWith(expect.objectContaining({ importId: "d1", startFrom: "all" }));
    expect(onClose).toHaveBeenCalledWith("s1");
  });

  it("closing part-way throws the draft away (nothing half-made is kept)", async () => {
    vi.mocked(sheetsClient.draft).mockResolvedValue({ ...ok({ ...sheetDraft, sheet: { ...sheetDraft.sheet, editing: "s1" } }), status: 201 });
    const onClose = vi.fn();
    render(<AddSheetSheet open sourceId="s1" onClose={onClose} />);
    await screen.findByRole("heading", { name: "Columns" });
    await userEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
    expect(importsClient.discard).toHaveBeenCalledWith("d1");
    expect(onClose).toHaveBeenCalledWith(undefined);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec vitest run src/components/sheets'`
Expected: FAIL. The stand-in renders nothing.

- [ ] **Step 3: Give the 2A steps their two small options**

`PreviewStep.tsx`:
- Change the props to `onStarted?(v: ImportView): void; onContinue?(): void;`.
- Inside `start`, change `return onStarted(r.data);` to `return onStarted?.(r.data);`.
- Replace the footer with:

```tsx
      <footer className={s.foot}>
        <p className={s.footNote}>
          {onContinue
            ? "Rows with problems are listed on the sheet's page, and tried again when the sheet changes."
            : "Rows with problems are left out and listed in the report."}
        </p>
        {onContinue ? (
          <Button variant="primary" disabled={!rows && !loadFailed} onClick={onContinue}>
            Continue
          </Button>
        ) : (
          <Button variant="primary" loading={starting} disabled={!rows && !loadFailed} onClick={() => void start()}>
            Import {rowsLabel}
          </Button>
        )}
      </footer>
```

`ColumnsStep.tsx`:
- Add `notice?: ReactNode` to the props (import `type ReactNode` from react).
- Render `{notice}` as the first element inside the step's main `<section>`, directly under its heading. Read the file's JSX to place it; the `notice` renders nothing when absent.

Run the 2A web tests to prove nothing changed: `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec vitest run src/components/imports'`. Expected: PASS.

- [ ] **Step 4: Implement the steps and the wizard**

`apps/web/src/components/sheets/SheetStep.tsx`:

```tsx
"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import s from "@/components/imports/imports.module.css";
import { sheetsClient } from "@/lib/sheets/client";
import type { InspectView } from "@/lib/sheets/types";

/**
 * Step 1: which sheet and tab. LUME checks it can open the sheet before anything else, and says exactly
 * what to do when it can't (share it with this email, as a Viewer).
 */
export function SheetStep({
  busy,
  onChoose,
}: {
  busy: boolean;
  onChoose(o: { link: string; sheetId: number }): void;
}) {
  const [link, setLink] = useState("");
  const [found, setFound] = useState<InspectView | null>(null);
  const [tab, setTab] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setError(null);
    setFound(null);
    const r = await sheetsClient.inspect(link);
    setChecking(false);
    if (!r.ok) return setError(r.message);
    setFound(r.data);
    setTab(r.data.tabs.some((t) => t.sheetId === r.data.gid) ? r.data.gid : (r.data.tabs[0]?.sheetId ?? null));
  };

  return (
    <>
      <section className={s.body}>
        <h3 className={s.stepTitle}>Choose a sheet</h3>
        <p className={s.stepLede}>Paste the link from the sheet's address bar. LUME only ever reads it.</p>
        <div className={s.linkRow}>
          <label className={s.field}>
            <span>Sheet link</span>
            <input
              type="url"
              value={link}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              onChange={(e) => {
                setLink(e.target.value);
                setFound(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && link.trim()) void check();
              }}
            />
          </label>
          <Button loading={checking} disabled={!link.trim()} onClick={() => void check()}>
            Check
          </Button>
        </div>
        {error && (
          <p role="alert" className={s.alert}>
            {error}
          </p>
        )}
        {found && (
          <div className={s.found}>
            <p className={s.foundTitle}>
              <img src="/brand/google-sheets.png" alt="" width={18} height={18} className={s.inlineMark} />
              {found.title}
            </p>
            <label className={s.field}>
              <span>Tab</span>
              <select value={tab ?? ""} onChange={(e) => setTab(Number(e.target.value))}>
                {found.tabs.map((t) => (
                  <option key={t.sheetId} value={t.sheetId}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </section>
      <footer className={s.foot}>
        <p className={s.footNote}>LUME finds the header row itself; you can change it on the next step.</p>
        <Button
          variant="primary"
          loading={busy}
          disabled={!found || tab === null}
          onClick={() => onChoose({ link, sheetId: tab! })}
        >
          Continue
        </Button>
      </footer>
    </>
  );
}
```

`apps/web/src/components/sheets/StartFromStep.tsx`:

```tsx
"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import s from "@/components/imports/imports.module.css";

const EVERY = [
  { v: 60, label: "Every minute" },
  { v: 120, label: "Every 2 minutes" },
  { v: 300, label: "Every 5 minutes" },
  { v: 900, label: "Every 15 minutes" },
  { v: 1800, label: "Every 30 minutes" },
  { v: 3600, label: "Every hour" },
];

/** Step 5 (spec §7.2): name it, say how often to look, and whether the rows already there come in too. */
export function StartFromStep({
  defaultName,
  rowCount,
  moreRows,
  editing,
  saving,
  error,
  onSave,
}: {
  defaultName: string;
  rowCount: number;
  moreRows: boolean;
  editing: boolean;
  saving: boolean;
  error: string | null;
  onSave(o: { name: string; pollSeconds: number; startFrom: "all" | "new" }): void;
}) {
  const [name, setName] = useState(defaultName);
  const [pollSeconds, setPoll] = useState(120);
  const [startFrom, setStartFrom] = useState<"all" | "new">("all");
  const count = `${rowCount.toLocaleString("en")}${moreRows ? "+" : ""}`;
  return (
    <>
      <section className={s.body}>
        <h3 className={s.stepTitle}>{editing ? "Save changes" : "Start"}</h3>
        <label className={s.field}>
          <span>Name</span>
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={s.field}>
          <span>Check for new rows</span>
          <select value={pollSeconds} onChange={(e) => setPoll(Number(e.target.value))}>
            {EVERY.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {!editing && (
          <fieldset className={s.choices}>
            <legend>Which rows come in</legend>
            <label className={s.choice}>
              <input type="radio" name="from" checked={startFrom === "all"} onChange={() => setStartFrom("all")} />
              <span>
                Every row already in the sheet ({count})<small>Then every new one.</small>
              </span>
            </label>
            <label className={s.choice}>
              <input type="radio" name="from" checked={startFrom === "new"} onChange={() => setStartFrom("new")} />
              <span>
                Only rows added from now on<small>The {count} already there stay in the sheet.</small>
              </span>
            </label>
          </fieldset>
        )}
        {error && (
          <p role="alert" className={s.alert}>
            {error}
          </p>
        )}
      </section>
      <footer className={s.foot}>
        <p className={s.footNote}>LUME never writes to your sheet.</p>
        <Button
          variant="primary"
          loading={saving}
          disabled={!name.trim()}
          onClick={() => onSave({ name: name.trim(), pollSeconds, startFrom: editing ? "all" : startFrom })}
        >
          {editing ? "Save changes" : "Connect sheet"}
        </Button>
      </footer>
    </>
  );
}
```

`apps/web/src/components/sheets/AddSheetSheet.tsx`:

```tsx
"use client";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ColumnsStep } from "@/components/imports/ColumnsStep";
import { COLUMN_CODES } from "@/components/imports/ImportSheet";
import { PreviewStep } from "@/components/imports/PreviewStep";
import { RulesStep } from "@/components/imports/RulesStep";
import s from "@/components/imports/imports.module.css";
import { IconButton } from "@/components/ui/IconButton";
import { importsClient } from "@/lib/imports/client";
import type { DraftView } from "@/lib/imports/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import { sheetsClient } from "@/lib/sheets/client";
import type { SheetDraft } from "@/lib/sheets/types";
import { SheetStep } from "./SheetStep";
import { StartFromStep } from "./StartFromStep";

type Step = "sheet" | "columns" | "rules" | "preview" | "start";
const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Spec §7.2: connecting a sheet, in the Import sheet's own frame. Sheet → Columns → Rules → Preview → Start.
 * Columns, Rules and Preview are the 2A steps on a draft of the sheet (amendment A1). With `sourceId` it
 * edits that sheet's columns and rules. A sheet draft isn't kept: closing throws it away.
 */
export function AddSheetSheet({
  open,
  sourceId,
  onClose,
}: {
  open: boolean;
  sourceId?: string;
  onClose(savedId?: string): void;
}) {
  const reduce = useReducedMotion();
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>("sheet");
  const [made, setMade] = useState<SheetDraft | null>(null);
  const [draft, setDraft] = useState<DraftView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = !!sourceId;
  const steps: { id: Step; label: string }[] = [
    ...(editing ? [] : [{ id: "sheet" as const, label: "Sheet" }]),
    { id: "columns", label: "Columns" },
    { id: "rules", label: "Rules" },
    { id: "preview", label: "Preview" },
    { id: "start", label: editing ? "Save" : "Start" },
  ];

  useEffect(() => {
    if (!open) {
      setStep("sheet");
      setMade(null);
      setDraft(null);
      setError(null);
      return;
    }
    if (!sourceId) return;
    let live = true;
    setBusy(true);
    void sheetsClient.draft({ sourceId }).then((r) => {
      if (!live) return;
      setBusy(false);
      if (!r.ok) return setError(r.message);
      setMade(r.data);
      setDraft(r.data.draft);
      setStep("columns");
    });
    return () => {
      live = false;
    };
  }, [open, sourceId]);

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    sheet.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => before?.focus?.();
  }, [open]);

  const close = (savedId?: string) => {
    if (draft && !savedId) void importsClient.discard(draft.id);
    onClose(savedId);
  };
  const onEscape = useRef<() => void>(() => undefined);
  onEscape.current = () => close();
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onEscape.current();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const choose = async (o: { link: string; sheetId: number }) => {
    setBusy(true);
    setError(null);
    if (draft) void importsClient.discard(draft.id); // a different tab: the old draft goes
    const r = await sheetsClient.draft(o);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setMade(r.data);
    setDraft(r.data.draft);
    setStep("columns");
  };
  const save = async (o: { name: string; pollSeconds: number; startFrom: "all" | "new" }) => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const r = await sheetsClient.save({ importId: draft.id, ...o });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    onClose(r.data.id);
  };

  const columnsBlocked = !!draft?.problems.some((p) => COLUMN_CODES.has(p.code));
  const rulesBlocked = !!draft?.problems.some((p) => !COLUMN_CODES.has(p.code));
  const reachable = (id: Step) =>
    id === "sheet" ||
    (!!draft &&
      (id === "columns" ||
        (id === "rules" && !columnsBlocked) ||
        ((id === "preview" || id === "start") && !columnsBlocked && !rulesBlocked)));
  const order = steps.findIndex((x) => x.id === step);
  const hasDate = !!draft?.mapping.columns.some((c) => c.to === "field" && c.field === "lead_created_at");

  return createPortal(
    <div className={s.layer}>
      <motion.div className={s.scrim} aria-hidden onClick={() => close()} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={toMotion(SPRINGS.soft)} />
      <motion.div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={s.sheet}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={toMotion(SPRINGS.default)}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          const items = [...(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
          if (e.shiftKey && document.activeElement === items[0]) {
            e.preventDefault();
            items.at(-1)?.focus();
          } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
            e.preventDefault();
            items[0]?.focus();
          }
        }}
      >
        <aside className={s.rail}>
          <h2 id={titleId} className={s.title}>
            {editing ? "Sheet columns" : "Add a sheet"}
          </h2>
          <nav aria-label="Steps" className={s.steps}>
            <ol>
              {steps.map((x, i) => (
                <li key={x.id}>
                  <button
                    type="button"
                    className={s.step}
                    aria-current={step === x.id ? "step" : undefined}
                    data-done={i < order || undefined}
                    disabled={!reachable(x.id)}
                    onClick={() => setStep(x.id)}
                  >
                    <span className={s.srOnly}>{i + 1} </span>
                    <span className={s.circle} aria-hidden>
                      {i + 1}
                    </span>
                    {x.label}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <p className={s.railFoot}>Nothing comes in until you connect the sheet. LUME checks every row first.</p>
        </aside>
        <div className={s.pane}>
          <div className={s.close}>
            <IconButton label="Close (Esc)" onClick={() => close()}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </IconButton>
          </div>
          {error && step !== "start" && (
            <p role="alert" className={s.alert}>
              {error}
            </p>
          )}
          {step === "sheet" && <SheetStep busy={busy} onChoose={(o) => void choose(o)} />}
          {step === "columns" && draft && (
            <ColumnsStep
              draft={draft}
              onDraft={setDraft}
              blocked={columnsBlocked}
              onContinue={() => setStep("rules")}
              notice={
                hasDate ? undefined : (
                  <p className={s.hint} role="note">
                    Map the column with each enquiry's date and time. Without it, LUME can't tell a repeat enquiry from the same row.
                  </p>
                )
              }
            />
          )}
          {step === "rules" && draft && (
            <RulesStep draft={draft} onDraft={setDraft} blocked={rulesBlocked} onContinue={() => setStep("preview")} />
          )}
          {step === "preview" && draft && (
            <PreviewStep draft={draft} onFix={(to) => setStep(to as Step)} onContinue={() => setStep("start")} />
          )}
          {step === "start" && draft && made && (
            <StartFromStep
              defaultName={made.sheet.name}
              rowCount={draft.rowCount}
              moreRows={made.sheet.moreRows}
              editing={editing}
              saving={busy}
              error={error}
              onSave={(o) => void save(o)}
            />
          )}
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
```

For an edit, `made.sheet.name` is the live sheet's saved name (Task 8 returns it), so Save keeps the name the admin chose.

Add to `imports.module.css` (after the existing `.alert` rules; if `.alert` doesn't exist, add it too):

```css
.linkRow {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: end;
}
.found {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  padding: 14px;
  border-radius: var(--r-ctl);
  background: var(--sunk);
}
.foundTitle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-weight: var(--fw-semibold);
}
.inlineMark {
  border-radius: 4px;
  background: #fff;
  padding: 1px;
}
.hint {
  margin: 0 0 12px;
  padding: 10px 12px;
  border-radius: var(--r-ctl);
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: var(--fs-sm);
}
.choices {
  border: 0;
  padding: 0;
  margin: 16px 0 0;
  display: grid;
  gap: 8px;
}
.choice {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  border-radius: var(--r-ctl);
  box-shadow: 0 0 0 0.5px var(--line-2);
  cursor: pointer;
}
.choice:has(input:checked) {
  box-shadow: 0 0 0 1.5px var(--accent);
}
.choice small {
  display: block;
  color: var(--text-2);
  font-size: var(--fs-xs);
  margin-top: 2px;
}
```

For names the Import sheet already defines (`body`, `stepTitle`, `stepLede`, `field`, `foot`, `footNote`, `alert`), check `imports.module.css` and reuse its actual names. If one is missing, add it next to the others in the same style.

- [ ] **Step 5: Run the tests**

Run: `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec vitest run src/components/sheets src/components/imports src/components/integrations'`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

Message: `feat(web): Add a sheet — check the link, pick the tab, then the same Columns, Rules and Preview as an import`, with the trailer.

---

### Task 12: Web — a sheet's own page

This shows the sheet's health, its last syncs and its problem rows, plus every action: Sync now or Test again, Pause or Resume, How often, Edit columns and rules, and Remove. There is a clear back link, from the owner's note about Settings navigation.

**Files:**
- Create: `apps/web/src/components/integrations/SourceDetail.tsx`, `apps/web/src/app/(app)/settings/integrations/[id]/page.tsx`
- Modify: `apps/web/src/components/integrations/integrations.module.css`
- Test: `apps/web/src/components/integrations/SourceDetail.test.tsx`

**Interfaces:**
- Consumes: `sheetsClient.get`/`sync`/`patch`/`remove`/`dismiss`/`problemsUrl`, `AddSheetSheet`, `Dialog`, `ago` and `inFuture`.
- Produces: `SourceDetail({ id }: { id: string })`.

- [ ] **Step 1: Write the failing test** `apps/web/src/components/integrations/SourceDetail.test.tsx`

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsClient } from "@/lib/sheets/client";
import type { SheetSourceDetail } from "@/lib/sheets/types";
import { SourceDetail } from "./SourceDetail";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/sheets/client", () => ({
  sheetsClient: { get: vi.fn(), sync: vi.fn(), patch: vi.fn(), remove: vi.fn(), dismiss: vi.fn(), problemsUrl: (id: string) => `/api/v1/sheets/sources/${id}/problems.csv` },
}));
vi.mock("@/components/sheets/AddSheetSheet", () => ({
  AddSheetSheet: ({ open, sourceId }: { open: boolean; sourceId?: string }) =>
    open ? <div role="dialog" aria-label="Sheet columns" data-source={sourceId} /> : null,
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const detail = (over: Partial<SheetSourceDetail> = {}): SheetSourceDetail => ({
  id: "s1",
  name: "Website enquiries",
  status: "active",
  attention: null,
  tabTitle: "Form responses",
  link: "https://docs.google.com/spreadsheets/d/x/edit#gid=0",
  pollSeconds: 120,
  lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
  nextSyncAt: new Date(Date.now() + 60_000).toISOString(),
  syncing: false,
  failing: false,
  lastError: null,
  newColumns: [],
  newToday: 3,
  newAllTime: 120,
  problems: 1,
  runAs: { id: "u1", name: "Riya Sharma" },
  syncs: [
    { id: "y1", trigger: "refresh", status: "done", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), created: 3, merged: 1, errors: 1, error: null },
    { id: "y2", trigger: "schedule", status: "done", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), created: 0, merged: 0, errors: 0, error: null },
  ],
  problemRows: [{ id: 9, rowNumber: 14, problems: [{ code: "DATE_INVALID", message: "“someday” isn't a date LUME can read." }], lastTriedAt: new Date().toISOString() }],
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("a sheet's page", () => {
  it("shows its health, recent syncs in words, problem rows, and a way back", async () => {
    vi.mocked(sheetsClient.get).mockResolvedValue(ok(detail()));
    render(<SourceDetail id="s1" />);
    expect(await screen.findByRole("heading", { name: "Website enquiries" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute("href", "/settings/integrations");
    expect(screen.getByRole("link", { name: /Open in Google Sheets/ })).toHaveAttribute("target", "_blank");
    expect(screen.getByText("120")).toBeInTheDocument();
    const syncs = screen.getByRole("table", { name: "Recent syncs" });
    expect(within(syncs).getByText("3 new · 1 merged · 1 problem")).toBeInTheDocument();
    expect(within(syncs).getByText("Up to date")).toBeInTheDocument();
    expect(within(syncs).getByText("Refresh")).toBeInTheDocument();
    expect(screen.getByText(/Row 14/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download problem rows" })).toHaveAttribute("href", "/api/v1/sheets/sources/s1/problems.csv");
    expect(screen.getByText(/Runs as Riya Sharma/)).toBeInTheDocument();
  });

  it("a lost share offers Test again; a changed column offers the columns", async () => {
    vi.mocked(sheetsClient.get).mockResolvedValueOnce(
      ok(detail({ status: "needs_attention", attention: { code: "ACCESS_LOST", message: "LUME can't open this sheet any more." } })),
    );
    vi.mocked(sheetsClient.sync).mockResolvedValue(ok({ syncId: "y3" }));
    vi.mocked(sheetsClient.get).mockResolvedValue(ok(detail()));
    const { unmount } = render(<SourceDetail id="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Test again" }));
    expect(sheetsClient.sync).toHaveBeenCalledWith("s1");
    unmount();
    vi.mocked(sheetsClient.get).mockResolvedValue(
      ok(detail({ status: "needs_attention", attention: { code: "COLUMNS_CHANGED", message: "The column “Name” is now called “Full name”." } })),
    );
    render(<SourceDetail id="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Open columns" }));
    expect(screen.getByRole("dialog", { name: "Sheet columns" })).toHaveAttribute("data-source", "s1");
  });

  it("pause, dismiss a problem, and remove only after saying the leads stay", async () => {
    vi.mocked(sheetsClient.get).mockResolvedValue(ok(detail()));
    vi.mocked(sheetsClient.patch).mockResolvedValue(ok({ ...detail(), status: "paused" }));
    vi.mocked(sheetsClient.dismiss).mockResolvedValue(ok(null));
    vi.mocked(sheetsClient.remove).mockResolvedValue(ok(null));
    render(<SourceDetail id="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(sheetsClient.patch).toHaveBeenCalledWith("s1", { paused: true });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss row 14" }));
    expect(sheetsClient.dismiss).toHaveBeenCalledWith("s1", 9);
    await userEvent.click(screen.getByRole("button", { name: "Remove sheet" }));
    const ask = screen.getByRole("dialog", { name: "Remove this sheet?" });
    expect(ask).toHaveTextContent("Its leads stay in LUME");
    await userEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    expect(sheetsClient.remove).toHaveBeenCalledWith("s1");
    expect(push).toHaveBeenCalledWith("/settings/integrations");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec vitest run src/components/integrations/SourceDetail.test.tsx'`
Expected: FAIL, `Cannot find module './SourceDetail'`.

- [ ] **Step 3: Implement** `SourceDetail.tsx`

```tsx
"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AddSheetSheet } from "@/components/sheets/AddSheetSheet";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { shortDateTime } from "@/lib/settings/format";
import { sheetsClient } from "@/lib/sheets/client";
import { ago, inFuture } from "@/lib/sheets/format";
import { RETRYABLE, type SheetSourceDetail, type SyncView } from "@/lib/sheets/types";
import s from "./integrations.module.css";

const TRIGGER: Record<SyncView["trigger"], string> = {
  schedule: "On its own",
  refresh: "Refresh",
  connect: "When connected",
  manual: "Sync now",
};
const EVERY = [60, 120, 300, 900, 1800, 3600];
const every = (v: number) => (v < 3600 ? `Every ${v / 60 === 1 ? "minute" : `${v / 60} minutes`}` : "Every hour");
const n = (v: number) => v.toLocaleString("en");

/** "3 new · 1 merged · 1 problem", "Up to date", or why it didn't finish. */
function outcome(x: SyncView): string {
  if (x.status === "queued" || x.status === "running") return "Checking…";
  if (x.status === "failed") return x.error === "stopped" ? "Stopped" : x.error && /^[A-Z_]+$/.test(x.error) ? "Needed attention" : (x.error ?? "Didn't finish");
  const parts = [
    x.created && `${n(x.created)} new`,
    x.merged && `${n(x.merged)} merged`,
    x.errors && `${n(x.errors)} ${x.errors === 1 ? "problem" : "problems"}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Up to date";
}

/** Spec §7.3: is it working, what did it do, what needs you — and every action, one tap away. */
export function SourceDetail({ id }: { id: string }) {
  const router = useRouter();
  const [v, setV] = useState<SheetSourceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await sheetsClient.get(id);
    if (!r.ok) return setError(r.message);
    setV(r.data);
  }, [id]);
  useEffect(() => void load(), [load]);
  // While it's checking, look again every 2 seconds, so the page says when it's done.
  useEffect(() => {
    if (!v?.syncing) return;
    const t = setTimeout(() => void load(), 2000);
    return () => clearTimeout(t);
  }, [v, load]);

  if (error) return <p role="alert" className={s.error}>{error}</p>;
  if (!v) return null;

  const act = async (f: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    setError(null);
    const r = await f();
    setBusy(false);
    if (!r.ok) return setError(r.message ?? "Something went wrong.");
    await load();
  };
  const retryable = v.attention && RETRYABLE.has(v.attention.code);

  return (
    <div className={s.detail}>
      <Link href="/settings/integrations" className={s.back}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Integrations
      </Link>
      <header className={s.detailHead}>
        <span className={s.brandTile}>
          <img src="/brand/google-sheets.png" alt="" width={28} height={28} />
        </span>
        <div>
          <h2 className={s.cardTitle}>{v.name}</h2>
          <p className={s.cardLede}>
            Tab “{v.tabTitle}” ·{" "}
            <a href={v.link} target="_blank" rel="noopener noreferrer">
              Open in Google Sheets
            </a>
          </p>
        </div>
      </header>

      {v.attention && (
        <section className={s.attention} aria-label="Needs attention">
          <p>{v.attention.message}</p>
          {retryable ? (
            <Button variant="primary" loading={busy} onClick={() => void act(() => sheetsClient.sync(id))}>
              Test again
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setEditing(true)}>
              Open columns
            </Button>
          )}
        </section>
      )}
      {v.failing && <p className={s.warnLine}>LUME hasn't reached Google for the last few tries. It keeps trying on its own.</p>}
      {v.newColumns.length > 0 && (
        <p className={s.infoLine}>
          {v.newColumns.length === 1 ? `1 new column: ${v.newColumns[0]}.` : `${v.newColumns.length} new columns: ${v.newColumns.join(", ")}.`}{" "}
          <button type="button" className={s.inlineLink} onClick={() => setEditing(true)}>
            Map {v.newColumns.length === 1 ? "it" : "them"}
          </button>
        </p>
      )}

      <dl className={s.health}>
        <div>
          <dt>Last checked</dt>
          <dd>{v.syncing ? "Checking now" : v.lastSyncedAt ? ago(v.lastSyncedAt) : "Not yet"}</dd>
        </div>
        <div>
          <dt>Next check</dt>
          <dd>{v.status === "paused" ? "Paused" : v.nextSyncAt ? inFuture(v.nextSyncAt) : "—"}</dd>
        </div>
        <div>
          <dt>New today</dt>
          <dd>{n(v.newToday)}</dd>
        </div>
        <div>
          <dt>All time</dt>
          <dd>{n(v.newAllTime)}</dd>
        </div>
        <div>
          <dt>Problems</dt>
          <dd>{n(v.problems)}</dd>
        </div>
      </dl>

      <div className={s.actions}>
        {v.status === "active" && (
          <Button loading={busy || v.syncing} onClick={() => void act(() => sheetsClient.sync(id))}>
            Sync now
          </Button>
        )}
        {v.status !== "needs_attention" && (
          <Button onClick={() => void act(() => sheetsClient.patch(id, { paused: v.status === "active" }))}>
            {v.status === "paused" ? "Resume" : "Pause"}
          </Button>
        )}
        <Button onClick={() => setEditing(true)}>Edit columns and rules</Button>
        <label className={s.every}>
          <span className={s.srOnly}>How often</span>
          <select
            aria-label="How often"
            value={v.pollSeconds}
            onChange={(e) => void act(() => sheetsClient.patch(id, { pollSeconds: Number(e.target.value) }))}
          >
            {EVERY.map((x) => (
              <option key={x} value={x}>
                {every(x)}
              </option>
            ))}
          </select>
        </label>
        <Button variant="ghost" className={s.danger} aria-label="Remove sheet" onClick={() => setRemoving(true)}>
          Remove
        </Button>
      </div>
      {v.runAs && <p className={s.cardLede}>Runs as {v.runAs.name}, who last saved its columns.</p>}

      <section aria-labelledby="syncs-title">
        <h3 id="syncs-title" className={s.sectionTitle}>
          Recent syncs
        </h3>
        <table className={s.table} aria-label="Recent syncs">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">How</th>
              <th scope="col">What happened</th>
            </tr>
          </thead>
          <tbody>
            {v.syncs.map((x) => (
              <tr key={x.id}>
                <td>{x.startedAt ? shortDateTime(x.startedAt) : "Waiting"}</td>
                <td>{TRIGGER[x.trigger]}</td>
                <td>{outcome(x)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {v.problemRows.length > 0 && (
        <section aria-labelledby="problems-title">
          <div className={s.sectionHead}>
            <h3 id="problems-title" className={s.sectionTitle}>
              Problem rows
            </h3>
            <a href={sheetsClient.problemsUrl(id)} download>
              Download problem rows
            </a>
          </div>
          <p className={s.cardLede}>Fix a row in the sheet and LUME tries it again on its next check.</p>
          <ul className={s.problems}>
            {v.problemRows.map((p) => (
              <li key={p.id}>
                <span className={s.rowNo}>Row {p.rowNumber}</span>
                <span>{p.problems.map((x) => x.message).join(" ")}</span>
                <Button size="sm" variant="ghost" aria-label={`Dismiss row ${p.rowNumber}`} onClick={() => void act(() => sheetsClient.dismiss(id, p.id))}>
                  Dismiss
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <AddSheetSheet
        open={editing}
        sourceId={id}
        onClose={() => {
          setEditing(false);
          void load();
        }}
      />
      {removing && (
        <Dialog label="Remove this sheet?" onClose={() => setRemoving(false)}>
          <h3 className={s.sectionTitle}>Remove this sheet?</h3>
          <p className={s.cardLede}>Its leads stay in LUME. New rows in “{v.name}” won't come in any more.</p>
          <div className={s.actions}>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const r = await sheetsClient.remove(id);
                if (r.ok) router.push("/settings/integrations");
              }}
            >
              Remove
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
```

If `Button` has no `"danger"` variant, use the variant the People screen uses for "Disable" (`grep -n variant apps/web/src/components/settings/PeopleAdmin.tsx`).

`apps/web/src/app/(app)/settings/integrations/[id]/page.tsx`:

```tsx
import { SourceDetail } from "@/components/integrations/SourceDetail";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Google Sheet · Integrations · LUME" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("integrations.manage");
  const { id } = await params;
  return <SourceDetail id={id} />;
}
```

Append to `integrations.module.css`:

```css
.detail {
  display: grid;
  gap: 18px;
  max-width: 880px;
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  color: var(--accent-ink);
  font-size: var(--fs-sm);
  font-weight: var(--fw-medium);
  text-decoration: none;
}
.back:hover {
  text-decoration: underline;
}
.detailHead {
  display: flex;
  align-items: center;
  gap: 14px;
}
.attention {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--r-card);
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.attention p {
  margin: 0;
  flex: 1 1 280px;
}
.warnLine,
.infoLine {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.warnLine {
  color: var(--warn-ink);
}
.inlineLink {
  border: 0;
  background: none;
  padding: 0;
  color: var(--accent-ink);
  font: inherit;
  font-weight: var(--fw-semibold);
  cursor: pointer;
}
.health {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 1px;
  margin: 0;
  border-radius: var(--r-card);
  overflow: hidden;
  background: var(--line);
  box-shadow: 0 0 0 0.5px var(--line);
}
.health > div {
  background: var(--raised);
  padding: 12px 14px;
}
.health dt {
  color: var(--text-2);
  font-size: var(--fs-xs);
}
.health dd {
  margin: 2px 0 0;
  font-size: var(--fs-lg);
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.every select {
  height: 32px;
  border-radius: var(--r-ctl);
}
.danger {
  margin-left: auto;
  color: var(--danger-ink);
}
.sectionHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.sectionTitle {
  font-size: var(--fs-md);
  font-weight: var(--fw-semibold);
  margin: 0 0 8px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-sm);
}
.table th {
  text-align: left;
  color: var(--text-3);
  font-weight: var(--fw-semibold);
  padding: 6px 8px;
  border-bottom: 0.5px solid var(--line);
}
.table td {
  padding: 9px 8px;
  border-bottom: 0.5px solid var(--line);
  font-variant-numeric: tabular-nums;
}
.problems {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.problems li {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 8px 12px;
  border-radius: var(--r-ctl);
  background: var(--sunk);
  font-size: var(--fs-sm);
}
.rowNo {
  font-weight: var(--fw-semibold);
  font-variant-numeric: tabular-nums;
}
.srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
```

- [ ] **Step 4: Run the tests**

Run: the Step 2 command. Expected: PASS.

- [ ] **Step 5: Gate and commit**

Message: `feat(web): a sheet's own page — health, recent syncs in words, problem rows, and every action with a way back`, with the trailer.

---
### Task 13: Web — the Refresh moment

This task follows the approved v5 motion (`docs/design/refresh-sync-v5.html`) and the `apple-design` principles: springs throughout, an origin anchored to the button, the same path out and back, and a still equivalent under Reduce Motion.

**Files:**
- Create: `apps/web/src/components/sheets/useRefresh.ts`, `apps/web/src/components/sheets/RefreshButton.tsx`, `apps/web/src/components/sheets/refresh.module.css`
- Modify:
  - `apps/web/src/components/ui/Button.tsx`: accept `ref`.
  - `apps/web/src/components/leads/LeadsScreen.tsx`: Refresh, the banner, reload on arrival.
  - `apps/web/src/components/board/BoardScreen.tsx`: Refresh, reload on arrival.
- Test: `apps/web/src/components/sheets/RefreshButton.test.tsx`

**Interfaces:**
- Consumes: `sheetsClient.refresh`/`progress`/`status`, `RefreshProgress`, `Odometer`, `AttentionBanner` and `scopeOf` (`@lume/core/shared`).
- Produces:
  - `TIMING` (exported for tests): `{ lift: 540, minOpen: 900, poll: 300, result: 1300, land: 620, landed: 1600, giveUp: 90_000 }`
  - `type Phase = "idle" | "lifting" | "syncing" | "result" | "landing" | "landed"`
  - `useRefresh(o: { reduce: boolean; personal: boolean; onArrived(p: RefreshProgress): void }): { phase; progress: RefreshProgress | null; failure: string | null; announce: string; press(): Promise<void> }`
  - `RefreshButton({ personal, onArrived, shortcut? }: { personal: boolean; onArrived(p: RefreshProgress): void; shortcut?: boolean })`

- [ ] **Step 1: Write the failing test** `apps/web/src/components/sheets/RefreshButton.test.tsx`

```tsx
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsClient } from "@/lib/sheets/client";
import type { RefreshProgress } from "@/lib/sheets/types";
import { RefreshButton } from "./RefreshButton";

vi.mock("@/lib/sheets/client", () => ({ sheetsClient: { refresh: vi.fn(), progress: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const progress = (over: Partial<RefreshProgress>): RefreshProgress => ({
  status: "done",
  rowsRead: 3,
  rowsTotal: 3,
  created: 3,
  merged: 0,
  leadIds: ["a", "b", "c"],
  unreachable: false,
  attention: [],
  ...over,
});
const run = async (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(sheetsClient.refresh).mockResolvedValue(ok({ id: "r1" }));
});
afterEach(() => vi.useRealTimers());

describe("Refresh", () => {
  it("syncs, shows real progress, says the real count once, then settles back into the button", async () => {
    vi.mocked(sheetsClient.progress)
      .mockResolvedValueOnce(ok(progress({ status: "running", rowsRead: 1, rowsTotal: 3, created: 1 })))
      .mockResolvedValue(ok(progress({ merged: 2 })));
    const onArrived = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RefreshButton personal={false} onArrived={onArrived} />);
    const btn = screen.getByRole("button", { name: /Refresh/ });
    await user.click(btn);
    expect(screen.getByRole("status")).toHaveTextContent("Syncing new enquiries");
    expect(btn).toHaveAttribute("aria-disabled", "true");
    await run(900);
    expect(screen.getByText("Reading rows… 1 of 3")).toBeInTheDocument();
    await run(1500);
    expect(screen.getByRole("status")).toHaveTextContent("3 new leads · 2 merged into existing ones");
    expect(screen.getByText(/merged into existing ones/)).toBeInTheDocument();
    await run(3000);
    expect(onArrived).toHaveBeenCalledWith(expect.objectContaining({ created: 3, leadIds: ["a", "b", "c"] }));
    expect(screen.getByRole("button", { name: /3 new/ })).toBe(btn);
    expect(document.activeElement).toBe(btn); // focus never left it
    await run(2500);
    expect(screen.getByRole("button", { name: /^Refresh/ })).not.toHaveAttribute("aria-disabled");
  });

  it("a rep hears what's theirs: “1 new lead for you”", async () => {
    vi.mocked(sheetsClient.progress).mockResolvedValue(ok(progress({ created: 1, leadIds: ["a"] })));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<RefreshButton personal onArrived={() => undefined} />);
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await run(2500);
    expect(screen.getByRole("status")).toHaveTextContent("1 new lead for you");
  });

  it("nothing new is “Up to date”; Google unreachable is said calmly", async () => {
    vi.mocked(sheetsClient.progress).mockResolvedValue(ok(progress({ created: 0, leadIds: [], rowsTotal: 0, rowsRead: 0 })));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(<RefreshButton personal={false} onArrived={() => undefined} />);
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await run(2500);
    expect(screen.getByRole("status")).toHaveTextContent("Up to date");
    unmount();
    vi.mocked(sheetsClient.progress).mockResolvedValue(ok(progress({ created: 0, leadIds: [], unreachable: true })));
    render(<RefreshButton personal={false} onArrived={() => undefined} />);
    await user.click(screen.getByRole("button", { name: /Refresh/ }));
    await run(2500);
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't reach Google. LUME will try again in 2 minutes.");
  });

  it("R refreshes from anywhere on the page — but not while typing — and a press while busy is ignored", async () => {
    vi.mocked(sheetsClient.progress).mockResolvedValue(ok(progress({})));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <>
        <input aria-label="Search" />
        <RefreshButton personal={false} onArrived={() => undefined} />
      </>,
    );
    await user.type(screen.getByLabelText("Search"), "r");
    expect(sheetsClient.refresh).not.toHaveBeenCalled();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard("r");
    expect(sheetsClient.refresh).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /Refresh|Syncing/ }));
    expect(sheetsClient.refresh).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec vitest run src/components/sheets/RefreshButton.test.tsx'`
Expected: FAIL, `Cannot find module './RefreshButton'`.

- [ ] **Step 3: `Button` takes a ref.** In `Button.tsx`, add `ref?: Ref<HTMLButtonElement>;` to `Props` (import `type Ref`). React 19 passes `ref` as a prop, and `...rest` already spreads it onto the `<button>`.

- [ ] **Step 4: Implement** `useRefresh.ts`

```ts
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { sheetsClient } from "@/lib/sheets/client";
import type { RefreshProgress } from "@/lib/sheets/types";

/** The v5 motion's beats, in ms (docs/design/refresh-sync-v5.html). */
export const TIMING = { lift: 540, minOpen: 900, poll: 300, result: 1300, land: 620, landed: 1600, giveUp: 90_000 } as const;
export type Phase = "idle" | "lifting" | "syncing" | "result" | "landing" | "landed";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** The one sentence the moment ends with, spoken once (spec §8.2). */
export function resultLine(p: RefreshProgress | null, failure: string | null, personal: boolean): string {
  if (failure) return failure;
  if (!p) return "Up to date";
  if (p.unreachable) return "Couldn't reach Google. LUME will try again in 2 minutes.";
  if (p.status !== "done") return "Still bringing leads in — they'll appear as they arrive.";
  if (!p.created && !p.merged) return "Up to date";
  const parts = [
    p.created ? `${plural(p.created, "new lead", "new leads")}${personal ? " for you" : ""}` : null,
    p.merged ? `${p.merged.toLocaleString("en")} merged into existing ones` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * Spec §8: press → lift → sync (polling real progress, never less than a beat so it reads) → the result →
 * back into the button → "✓ N new" → Refresh. One press at a time; polling pauses while the tab is hidden.
 */
export function useRefresh(o: { reduce: boolean; personal: boolean; onArrived(p: RefreshProgress): void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<RefreshProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const alive = useRef(true);
  const busy = useRef(false);
  const arrived = useRef(o.onArrived);
  arrived.current = o.onArrived;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const press = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const opened = Date.now();
    setProgress(null);
    setFailure(null);
    setPhase("lifting");
    setAnnounce("Syncing new enquiries");
    const [r] = await Promise.all([sheetsClient.refresh(), wait(o.reduce ? 0 : TIMING.lift)]);
    if (!alive.current) return;
    setPhase("syncing");
    let last: RefreshProgress | null = null;
    let failed: string | null = null;
    if (!r.ok) failed = r.code === "OFFLINE" ? "You're offline. LUME will sync when you're back." : r.message;
    else {
      const until = Date.now() + TIMING.giveUp;
      while (Date.now() < until) {
        await wait(TIMING.poll);
        if (!alive.current) return;
        if (document.visibilityState === "hidden") continue;
        const p = await sheetsClient.progress(r.data.id);
        if (!alive.current) return;
        if (p.ok) {
          last = p.data;
          setProgress(p.data);
          if (p.data.status === "done") break;
        }
      }
    }
    const held = Date.now() - opened;
    const floor = (o.reduce ? 0 : TIMING.lift) + TIMING.minOpen;
    if (held < floor) await wait(floor - held);
    if (!alive.current) return;
    setFailure(failed);
    setPhase("result");
    setAnnounce(resultLine(last, failed, o.personal));
    await wait(TIMING.result);
    if (!alive.current) return;
    setPhase("landing");
    if (last) arrived.current(last);
    await wait(o.reduce ? 200 : TIMING.land);
    if (!alive.current) return;
    setPhase("landed");
    await wait(TIMING.landed);
    if (!alive.current) return;
    setPhase("idle");
    busy.current = false;
  }, [o.reduce, o.personal]);

  return { phase, progress, failure, announce, press };
}
```

- [ ] **Step 5: Implement** `RefreshButton.tsx`

```tsx
"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Odometer } from "@/components/ui/Odometer";
import type { RefreshProgress } from "@/lib/sheets/types";
import { resultLine, useRefresh, type Phase } from "./useRefresh";
import s from "./refresh.module.css";

const PILL = { w: 236, h: 40, r: 20 };
const CARD = { w: 330, h: 168, r: 22 };
// Apple's move/reposition spring: critically damped, no overshoot on a surface that simply grows.
const MORPH = { type: "spring", bounce: 0, duration: 0.6 } as const;
const FADE = { duration: 0.2 } as const;

const Arrow = ({ spin }: { spin?: boolean }) => (
  <svg className={spin ? s.spin : undefined} viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const Tick = ({ size }: { size: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
    <path d="M5.5 12.5 10 17l8.5-9.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Spec §8 and the approved v5 motion. The button lifts into a glass pill, the pill opens into the card
 * (Google Sheets → rows drifting → LUME, a blue bar filling with real progress), the real count arrives,
 * and the card settles back into the button, which says "✓ 3 new" before becoming Refresh again. Focus
 * stays on the button throughout; Reduce Motion gets a still card that fades. No sound.
 */
export function RefreshButton({
  personal,
  onArrived,
  shortcut = true,
}: {
  personal: boolean;
  onArrived(p: RefreshProgress): void;
  shortcut?: boolean;
}) {
  const reduce = !!useReducedMotion();
  const r = useRefresh({ reduce, personal, onArrived });
  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState({ w: 96, h: 32 });
  useLayoutEffect(() => {
    if (btn.current) setBox({ w: btn.current.offsetWidth, h: btn.current.offsetHeight });
  }, [r.phase]);

  // R, from anywhere on the page that isn't a field or an open panel (the same guard as N).
  const press = r.press;
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "r" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      e.preventDefault();
      btn.current?.focus();
      void press();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut, press]);

  const busy = r.phase !== "idle";
  const open = r.phase === "lifting" || r.phase === "syncing" || r.phase === "result" || r.phase === "landing";
  const at = (shape: "button" | "pill" | "card") =>
    shape === "button"
      ? { left: 0, top: 0, width: box.w, height: box.h, borderRadius: 9 }
      : shape === "pill"
        ? { left: box.w - PILL.w, top: box.h + 8, width: PILL.w, height: PILL.h, borderRadius: PILL.r }
        : { left: box.w - CARD.w, top: box.h + 8, width: CARD.w, height: CARD.h, borderRadius: CARD.r };
  const shape: Record<Phase, "button" | "pill" | "card"> = {
    idle: "button",
    lifting: "pill",
    syncing: "card",
    result: "card",
    landing: "button",
    landed: "button",
  };
  const p = r.progress;
  const created = p?.created ?? 0;
  const landedLabel = r.failure || p?.unreachable ? "Try later" : created ? `${created.toLocaleString("en")} new` : "Up to date";
  const nothing = !r.failure && !!p && !p.unreachable && p.status === "done" && !p.created && !p.merged;
  const warn = !!r.failure || !!p?.unreachable;

  return (
    <span className={s.anchor}>
      <Button
        ref={btn}
        aria-disabled={busy || undefined}
        aria-keyshortcuts="R"
        title="Refresh (R)"
        className={s.button}
        data-phase={r.phase}
        onClick={() => void r.press()}
      >
        {r.phase === "landed" ? (
          <span className={s.landed} data-warn={warn || undefined}>
            {!warn && <Tick size={13} />}
            {landedLabel}
          </span>
        ) : (
          <>
            <Arrow spin={busy} />
            Refresh
          </>
        )}
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            key="morph"
            className={s.morph}
            data-glass={shape[r.phase] !== "button" || undefined}
            aria-hidden
            initial={reduce ? { opacity: 0, ...at("card") } : { opacity: 1, ...at("button") }}
            animate={reduce ? { opacity: r.phase === "landing" ? 0 : 1, ...at("card") } : { opacity: 1, ...at(shape[r.phase]) }}
            exit={{ opacity: 0, transition: FADE }}
            transition={reduce ? FADE : MORPH}
          >
            <AnimatePresence initial={false}>
              {r.phase === "lifting" && !reduce && (
                <motion.div key="pill" className={`${s.layer} ${s.pill}`} {...layer(reduce)}>
                  <img src="/lume-mark.png" alt="" width={20} height={20} />
                  Syncing new enquiries…
                </motion.div>
              )}
              {(r.phase === "syncing" || (reduce && r.phase === "lifting")) && (
                <motion.div key="card" className={`${s.layer} ${s.card}`} {...layer(reduce)}>
                  <div className={s.route} data-flowing={!reduce || undefined}>
                    <span className={`${s.end} ${s.sheet}`}>
                      <img src="/brand/google-sheets.png" alt="" width={28} height={28} />
                    </span>
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <span key={i} className={s.glyph} style={{ ["--i" as string]: i }} />
                    ))}
                    <span className={`${s.end} ${s.lume}`}>
                      <img src="/lume-mark.png" alt="" width={28} height={28} />
                    </span>
                  </div>
                  <p className={s.title}>Syncing new enquiries</p>
                  <p className={s.sub}>
                    {p && p.rowsTotal > 0
                      ? `Reading rows… ${p.rowsRead.toLocaleString("en")} of ${p.rowsTotal.toLocaleString("en")}`
                      : "Checking for new enquiries…"}
                  </p>
                  <div className={s.bar} data-indeterminate={!p?.rowsTotal || undefined}>
                    <motion.i
                      animate={{ width: p?.rowsTotal ? `${Math.max(6, (100 * p.rowsRead) / p.rowsTotal)}%` : "18%" }}
                      transition={reduce ? FADE : MORPH}
                    />
                  </div>
                </motion.div>
              )}
              {r.phase === "result" && (
                <motion.div key="result" className={`${s.layer} ${s.result}`} data-warn={warn || undefined} {...layer(reduce)}>
                  <motion.span
                    className={s.check}
                    initial={reduce ? false : { scale: 0.4 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", bounce: 0.35, duration: 0.6 }}
                  >
                    {warn ? "!" : <Tick size={20} />}
                  </motion.span>
                  <div>
                    {warn ? (
                      <>
                        <p className={s.resultTitle}>Couldn't reach Google</p>
                        <p className={s.sub}>{r.failure ?? "LUME will try again in 2 minutes."}</p>
                      </>
                    ) : nothing ? (
                      <>
                        <p className={s.resultTitle}>Up to date</p>
                        <p className={s.sub}>No new enquiries since the last check.</p>
                      </>
                    ) : (
                      <>
                        <p className={s.count}>
                          <Odometer value={created} />
                        </p>
                        <p className={s.sub}>{resultLine(p, null, personal).replace(/^[\d,]+ /, "")}</p>
                      </>
                    )}
                    {(p?.attention ?? []).map((a) => (
                      <Link key={a.id} href={`/settings/integrations/${a.id}`} className={s.attention}>
                        “{a.name}” needs attention
                      </Link>
                    ))}
                  </div>
                </motion.div>
              )}
              {r.phase === "landing" && !reduce && (
                <motion.div key="face" className={`${s.layer} ${s.face}`} {...layer(reduce)}>
                  <Tick size={13} />
                  {landedLabel}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
      <p role="status" aria-live="polite" className={s.srOnly}>
        {r.announce}
      </p>
    </span>
  );
}

/** A layer materialises (opacity with a little blur) rather than simply fading; Reduce Motion: opacity only. */
function layer(reduce: boolean) {
  return reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: FADE }
    : {
        initial: { opacity: 0, filter: "blur(4px)" },
        animate: { opacity: 1, filter: "blur(0px)" },
        exit: { opacity: 0, filter: "blur(4px)" },
        transition: { duration: 0.28 },
      };
}
```

- [ ] **Step 6: Implement** `refresh.module.css`

```css
.anchor {
  position: relative;
  display: inline-flex;
}
.button[data-phase]:not([data-phase="idle"]) {
  cursor: default;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.landed {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--ok-ink);
  font-weight: var(--fw-bold);
}
.landed[data-warn] {
  color: var(--warn-ink);
}
/* The one shape: the button's own size at first, then the pill, then the card, then the button again. */
.morph {
  position: absolute;
  z-index: 30;
  overflow: hidden;
  background: var(--raised);
  box-shadow: inset 0 0 0 0.5px var(--line-2);
  color: var(--text);
  transition:
    background 0.35s ease,
    box-shadow 0.35s ease,
    backdrop-filter 0.35s ease;
}
.morph[data-glass] {
  background: var(--glass);
  backdrop-filter: blur(30px) saturate(180%);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  box-shadow: var(--shadow-pop);
}
.layer {
  position: absolute;
  inset: 0;
}
.pill {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  font-size: var(--fs-sm);
  font-weight: var(--fw-semibold);
  white-space: nowrap;
}
.card {
  padding: 16px 18px;
}
.route {
  position: relative;
  height: 58px;
}
.end {
  position: absolute;
  top: 6px;
  width: 44px;
  height: 44px;
  border-radius: 13px;
  display: grid;
  place-items: center;
  background: var(--raised);
  box-shadow: 0 0 0 0.5px var(--line-2), 0 4px 14px rgba(0, 0, 0, 0.08);
}
/* The official Sheets mark sits on white in both themes. */
.sheet {
  left: 0;
  background: #fff;
}
.lume {
  right: 0;
}
.glyph {
  position: absolute;
  left: 22px;
  top: 18px;
  width: 14px;
  height: 18px;
  border-radius: 3px;
  background: var(--raised);
  box-shadow: 0 0 0 0.5px rgba(var(--accent-rgb), 0.45), 0 3px 8px rgba(var(--accent-rgb), 0.3);
  opacity: 0;
  offset-path: path("M 0 10 C 70 -24, 180 -24, 250 10");
  offset-rotate: auto;
}
.glyph::before,
.glyph::after {
  content: "";
  position: absolute;
  left: 3px;
  right: 3px;
  height: 2px;
  border-radius: 2px;
  background: rgba(var(--accent-rgb), 0.55);
  top: 5px;
}
.glyph::after {
  top: 10px;
  right: 6px;
}
.route[data-flowing] .glyph {
  animation: fly 1.5s cubic-bezier(0.22, 1, 0.36, 1) infinite;
  animation-delay: calc(var(--i) * 0.25s);
}
@keyframes fly {
  0% {
    offset-distance: 0%;
    opacity: 0;
    transform: scale(0.7);
  }
  15%,
  80% {
    opacity: 1;
  }
  100% {
    offset-distance: 100%;
    opacity: 0;
    transform: scale(0.85);
  }
}
.title,
.resultTitle {
  margin: 8px 0 0;
  font-weight: var(--fw-bold);
  font-size: var(--fs-md);
}
.resultTitle {
  margin: 0;
}
.sub {
  margin: 2px 0 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
/* The one blue, and a cyan sheen through it. */
.bar {
  height: 6px;
  border-radius: 99px;
  background: rgba(var(--accent-rgb), 0.14);
  margin-top: 11px;
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), var(--cyan), var(--accent));
  background-size: 200% 100%;
  animation: sheen 1.6s linear infinite;
}
@keyframes sheen {
  to {
    background-position: -200% 0;
  }
}
.result {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 22px;
}
.check {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--ok);
  background: var(--ok-soft);
  font-weight: var(--fw-bold);
}
.result[data-warn] .check {
  color: var(--warn-ink);
  background: var(--warn-soft);
}
.count {
  margin: 0;
  font-size: 34px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.attention {
  display: block;
  margin-top: 6px;
  font-size: var(--fs-xs);
  color: var(--warn-ink);
  font-weight: var(--fw-semibold);
}
.face {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: var(--fs-sm);
  font-weight: var(--fw-bold);
  color: var(--ok-ink);
  white-space: nowrap;
}
.srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .spin,
  .bar i {
    animation: none;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .morph[data-glass] {
    background: var(--raised);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
@media (max-width: 480px) {
  .morph {
    max-width: calc(100vw - 32px);
  }
}
```

The result line under the count strips the leading number from `resultLine` (the Odometer shows it), so it reads "new leads · 2 merged into existing ones" or "new lead for you".

- [ ] **Step 7: Put Refresh on Leads and the Board**

`LeadsScreen.tsx`:
- Import `RefreshButton`, `AttentionBanner`, `sheetsClient`, `scopeOf` (from `@lume/core/shared`) and `type SheetsStatus`.
- Add, near the import state:

```tsx
  // Spec §8.1: Refresh shows once a sheet is connected; admins also hear which sheet needs them.
  const [sheets, setSheets] = useState<SheetsStatus | null>(null);
  useEffect(() => {
    let live = true;
    void sheetsClient.status().then((r) => live && r.ok && setSheets(r.data));
    return () => {
      live = false;
    };
  }, []);
  const personal = scopeOf(session.actor, "leads.view") !== "all";
```

- In the toolbar's right group, before the Import button:

```tsx
            {sheets?.refresh && (
              <RefreshButton
                personal={personal}
                onArrived={() => {
                  list.reload();
                  recount();
                }}
              />
            )}
```

- Directly inside `<section className={s.screen}>`, before the toolbar: `{sheets && <AttentionBanner items={sheets.attention} />}`.

`BoardScreen.tsx`:
- Add the same status fetch and `personal`.
- In the toolbar's right group, before New lead: `{sheets?.refresh && <RefreshButton personal={personal} onArrived={() => setReloadTick((n) => n + 1)} />}`.
- Amendment A10: the board reloads, and the glow is table-only.

`LeadsScreen.test.tsx` and `BoardScreen.test.tsx` mock the API clients they use. Add `vi.mock("@/lib/sheets/client", () => ({ sheetsClient: { status: vi.fn().mockResolvedValue({ ok: true, status: 200, data: { refresh: false, attention: [] } }) } }))` to both, so they keep passing unchanged.

- [ ] **Step 8: Run the tests**

Run: `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec vitest run src/components/sheets src/components/leads src/components/board'`
Expected: PASS.

- [ ] **Step 9: Gate and commit**

Message: `feat(web): Refresh — the approved moment, out of the button and back into it, with real counts, calm failures and a still Reduce Motion version`, with the trailer.

---

### Task 14: Web — the arrival glow

**Files:**
- Create: `apps/web/src/components/leads/useArrivals.ts`
- Modify:
  - `apps/web/src/components/leads/LeadsTable.tsx`: rows carry `data-arrived`.
  - `apps/web/src/components/leads/LeadsScreen.tsx`: the hook, the line, the flash after Refresh.
  - `apps/web/src/components/leads/leads.module.css`: the glow.
  - `apps/web/src/lib/leads/filters.ts`: `arrivedAfter`.
- Test: `apps/web/src/components/leads/useArrivals.test.tsx`, `apps/web/src/lib/leads/filters.test.ts` (append)

**Interfaces:**
- Consumes: `sheetsClient.arrivals`/`seen`.
- Produces:
  - `useArrivals(): { glowing: Map<string, number>; count: number; since: string | null; flash(ids: string[]): void }`. The map value is the row's stagger index.
  - `ListFilters.arrivedAfter?: string`, and `apiQuery` sends `arrivedAfter`.
  - `LeadsTable` accepts `glowing?: Map<string, number>`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/leads/useArrivals.test.tsx`:

```tsx
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsClient } from "@/lib/sheets/client";
import { GLOW_MS, useArrivals } from "./useArrivals";

vi.mock("@/lib/sheets/client", () => ({ sheetsClient: { arrivals: vi.fn(), seen: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.mocked(sheetsClient.seen).mockResolvedValue(ok(null));
});
afterEach(() => vi.useRealTimers());

describe("useArrivals", () => {
  it("on opening Leads, what arrived since the last visit glows, staggered, and then fades", async () => {
    vi.mocked(sheetsClient.arrivals).mockResolvedValue(ok({ since: "2026-09-26T18:00:00Z", count: 2, ids: ["a", "b"] }));
    const { result } = renderHook(() => useArrivals());
    await waitFor(() => expect(result.current.glowing.size).toBe(2));
    expect([...result.current.glowing.entries()]).toEqual([["a", 0], ["b", 1]]);
    expect(result.current.count).toBe(2);
    vi.useFakeTimers();
    act(() => void vi.advanceTimersByTime(GLOW_MS + 2 * 70 + 50));
    expect(result.current.glowing.size).toBe(0);
    expect(result.current.count).toBe(2); // the line stays until they leave
  });

  it("a first visit shows nothing; leaving (or hiding the tab) marks Leads seen", async () => {
    vi.mocked(sheetsClient.arrivals).mockResolvedValue(ok({ since: null, count: 0, ids: [] }));
    const { result, unmount } = renderHook(() => useArrivals());
    await waitFor(() => expect(sheetsClient.arrivals).toHaveBeenCalled());
    expect(result.current.glowing.size).toBe(0);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sheetsClient.seen).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    unmount();
    expect(sheetsClient.seen).toHaveBeenCalledTimes(2);
  });

  it("flash() glows the rows a Refresh brought in", async () => {
    vi.mocked(sheetsClient.arrivals).mockResolvedValue(ok({ since: null, count: 0, ids: [] }));
    const { result } = renderHook(() => useArrivals());
    await waitFor(() => expect(sheetsClient.arrivals).toHaveBeenCalled());
    act(() => result.current.flash(["x", "y", "z"]));
    expect([...result.current.glowing.keys()]).toEqual(["x", "y", "z"]);
  });
});
```

Append to `filters.test.ts`:

```ts
  it("arrivedAfter goes to the API, not into the address bar", () => {
    const f = { stageIds: [], sort: "newest" as const, arrivedAfter: "2026-09-26T18:00:00.000Z" };
    expect(apiQuery(f)).toContain("arrivedAfter=2026-09-26T18%3A00%3A00.000Z");
    expect(filtersToParams(f).has("arrivedAfter")).toBe(false);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec vitest run src/components/leads/useArrivals.test.tsx src/lib/leads/filters.test.ts'`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/components/leads/useArrivals.ts`:

```ts
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { sheetsClient } from "@/lib/sheets/client";

/** Spec §8.3: new rows glow for 5 s, 70 ms apart; at most 20 glow. */
export const GLOW_MS = 5000;
export const STAGGER_MS = 70;
const MAX = 20;

/**
 * What arrived since this person last looked at Leads (per viewer, per visit, never stored), and a flash
 * for what a Refresh just brought in. Leaving Leads or hiding the tab marks it seen, on the server's clock.
 */
export function useArrivals() {
  const [glowing, setGlowing] = useState<Map<string, number>>(new Map());
  const [count, setCount] = useState(0);
  const [since, setSince] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((ids: string[]) => {
    const list = ids.slice(0, MAX);
    setGlowing(new Map(list.map((id, i) => [id, i])));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setGlowing(new Map()), GLOW_MS + list.length * STAGGER_MS);
  }, []);

  useEffect(() => {
    let live = true;
    void sheetsClient.arrivals().then((r) => {
      if (!live || !r.ok) return;
      setSince(r.data.since);
      setCount(r.data.count);
      if (r.data.ids.length) flash(r.data.ids);
    });
    const seen = () => void sheetsClient.seen();
    const onHide = () => {
      if (document.visibilityState === "hidden") seen();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onHide);
      if (timer.current) clearTimeout(timer.current);
      seen();
    };
  }, [flash]);

  return { glowing, count, since, flash };
}
```

`filters.ts`:
- Add `arrivedAfter?: string;` to `ListFilters`, with the comment `/** Leads that arrived after this instant (the "N new since yesterday" line); never in the address bar. */`.
- In `apiQuery`, add `if (f.arrivedAfter) p.set("arrivedAfter", f.arrivedAfter);`.
- Add `f.arrivedAfter` to the `activeFilterCount` list.

`LeadsTable.tsx`:
- Add `glowing?: Map<string, number>` to `Props`.
- On each body `<tr>`, add:

```tsx
data-arrived={glowing?.has(lead.id) || undefined}
style={glowing?.has(lead.id) ? ({ ["--d" as string]: `${glowing.get(lead.id)! * 70}ms` } as React.CSSProperties) : undefined}
```

- In the name cell, after the name, add `{glowing?.has(lead.id) && <span className={s.newTag}>NEW</span>}`.
- Read the row-rendering JSX to place these on the existing `<tr>` and name cell.

`leads.module.css` holds the v5 glow, in the one blue:

```css
/* Spec §8.3: a new row slides in, carries a blue wash and a 3 px edge, and settles over 5 s — light
   passing, no bounce. The rows follow each other 70 ms apart (--d). */
tr[data-arrived] {
  animation: rowIn 0.6s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--d, 0ms);
}
tr[data-arrived] td {
  animation: wash 5s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--d, 0ms);
}
tr[data-arrived] td:first-child {
  animation:
    wash 5s cubic-bezier(0.22, 1, 0.36, 1) both,
    edge 5s ease-out both;
  animation-delay: var(--d, 0ms);
}
@keyframes rowIn {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
}
@keyframes wash {
  0% {
    background: rgba(var(--accent-rgb), 0);
  }
  8% {
    background: rgba(var(--accent-rgb), 0.12);
  }
  45% {
    background: rgba(var(--accent-rgb), 0.08);
  }
  100% {
    background: rgba(var(--accent-rgb), 0);
  }
}
@keyframes edge {
  0% {
    box-shadow: inset 3px 0 0 rgba(var(--accent-rgb), 0);
  }
  8% {
    box-shadow: inset 3px 0 0 rgba(var(--accent-rgb), 0.9);
  }
  60% {
    box-shadow: inset 3px 0 0 rgba(var(--accent-rgb), 0.35);
  }
  100% {
    box-shadow: inset 3px 0 0 rgba(var(--accent-rgb), 0);
  }
}
.newTag {
  margin-left: 6px;
  font-size: 10px;
  font-weight: var(--fw-bold);
  letter-spacing: 0.04em;
  color: var(--accent-ink);
  opacity: 0;
  animation: tag 5s ease both;
  animation-delay: var(--d, 0ms);
}
@keyframes tag {
  8%,
  60% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
.arrivals {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 8px;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.arrivals button {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-weight: var(--fw-semibold);
  color: var(--accent-ink);
  cursor: pointer;
}
/* Reduce Motion: no slide; the wash is a plain fade. */
@media (prefers-reduced-motion: reduce) {
  tr[data-arrived] {
    animation: none;
  }
  tr[data-arrived] td,
  tr[data-arrived] td:first-child {
    animation: wash 5s linear both;
  }
}
```

`LeadsScreen.tsx`:
- `const arrivals = useArrivals();`
- Pass `glowing={arrivals.glowing}` to `LeadsTable`.
- In the Refresh `onArrived`, call `arrivals.flash(p.leadIds)` after `list.reload()` (the handler takes `p`).
- Above the table (inside `body`, before the table), when more than 20 arrived:

```tsx
      {arrivals.count > 20 && arrivals.since && !filters.arrivedAfter && (
        <p className={s.arrivals}>
          {arrivals.count.toLocaleString("en")} new since {sinceWords(arrivals.since)} ·
          <button type="button" onClick={() => setFilters({ ...filters, arrivedAfter: arrivals.since! })}>
            Show only these
          </button>
        </p>
      )}
```

with, at the top of the file:

```ts
/** "since yesterday", "since this morning", "since Monday" — when the last visit was, in words. */
function sinceWords(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return d.getHours() < 12 ? "this morning" : "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return d.toLocaleDateString("en", { weekday: "long" });
  return d.toLocaleDateString("en", { day: "numeric", month: "short" });
}
```

The "Show only these" filter appears as a chip. In `FilterBar.tsx`, next to the source chip:

```tsx
      {filters.arrivedAfter && (
        <button type="button" className={s.sourceChip} aria-label="Remove filter: New since your last visit" onClick={() => set({ arrivedAfter: undefined })}>
          New since your last visit
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
```

- [ ] **Step 4: Run the tests**

Run: `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec vitest run src/components/leads src/lib/leads'`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

Message: `feat(web): what arrived since your last visit glows in, and what a Refresh brings slides in the same way`, with the trailer.

---

### Task 15: End to end — the real stack, with the fake Google

**Files:**
- Create: `apps/web/e2e/google-fake.ts`, `apps/web/e2e/sheets-helpers.ts`, `apps/web/e2e/sheets.spec.ts`
- Modify:
  - `apps/web/playwright.config.ts`: the fake as the first webServer.
  - `apps/web/e2e/api-server.mjs`: the Google env.
  - `apps/web/e2e/a11y.spec.ts`: the Integrations page and the Refresh card.
  - `.gitignore`: already ignores `e2e/.artifacts`; check.

**Interfaces:**
- Consumes: `startGoogleFake` (Task 3), and the `openApp`/`callApi` fixtures.
- Produces: `putSheet(rows)`, `appendRows(id, rows)` and `connectViaApi(page, id, startFrom)` in `sheets-helpers.ts`.

- [ ] **Step 1: The fake as a webServer**

`apps/web/e2e/google-fake.ts`:

```ts
// The fake Google for e2e (spec 2B §11): the API's own test fake, on a fixed port, its key written where
// api-server.mjs reads it. No test ever calls Google.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { startGoogleFake } from "../../api/test/google-fake";

const here = import.meta.dirname;
const fake = await startGoogleFake({ port: Number(process.env.E2E_GOOGLE_PORT ?? 3112) });
mkdirSync(path.join(here, ".artifacts"), { recursive: true });
writeFileSync(path.join(here, ".artifacts/google-key.b64"), fake.env);
console.log(`google fake on ${fake.url}`);
```

Because the bundle lives in `e2e/.artifacts/`, `import.meta.dirname` there is `.artifacts`. Write the key to `path.join(here, "google-key.b64")` when `here` already ends in `.artifacts`, or compute `const dir = here.endsWith(".artifacts") ? here : path.join(here, ".artifacts")` and use `dir`.

In `playwright.config.ts`, the **first** `webServer` entry:

```ts
    {
      command:
        "node ../../scripts/bundle.mjs . e2e/google-fake.ts e2e/.artifacts/google-fake.mjs && node e2e/.artifacts/google-fake.mjs",
      url: "http://127.0.0.1:3112/__fake/key",
      reuseExistingServer: false,
      timeout: 60_000,
    },
```

In `api-server.mjs`, add `import { readFileSync, existsSync } from "node:fs";` and, in the child's `env`:

```js
    // Google Sheets against the fake Google (e2e/google-fake.ts), never the real one.
    GOOGLE_SERVICE_ACCOUNT_JSON: readFileSync(path.join(here, ".artifacts/google-key.b64"), "utf8"),
    LUME_GOOGLE_ENDPOINT: `http://127.0.0.1:${process.env.E2E_GOOGLE_PORT ?? 3112}`,
```

- [ ] **Step 2: The helpers** `apps/web/e2e/sheets-helpers.ts`

```ts
import type { Page } from "@playwright/test";
import { callApi } from "./fixtures";

const FAKE = `http://127.0.0.1:${process.env.E2E_GOOGLE_PORT ?? 3112}`;
export const HEAD = ["Timestamp", "Name", "Phone", "Email"];
let n = 0;

/** A fresh spreadsheet in the fake Google, shared with LUME; its id. */
export async function putSheet(rows: string[][], title = "Website enquiries"): Promise<string> {
  const id = `1E2eSheet${Date.now()}${n++}xxxxxxxxxxxx`;
  const { email } = (await (await fetch(`${FAKE}/__fake/key`)).json()) as { email: string };
  await fetch(`${FAKE}/__fake/spreadsheets/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, sharedWith: [email], tabs: [{ sheetId: 0, title: "Form responses", rows: [HEAD, ...rows] }] }),
  });
  return id;
}
export const appendRows = (id: string, rows: string[][]) =>
  fetch(`${FAKE}/__fake/spreadsheets/${id}/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab: "Form responses", rows }),
  });
export const sheetLink = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`;

/** Switch Sheets on and connect a sheet through the API, as the page's user; the source's id. */
export async function connectViaApi(page: Page, id: string, startFrom: "all" | "new" = "all"): Promise<string> {
  await callApi(page, "PUT", "/api/v1/integrations/google-sheets", { enabled: true });
  const d = (await callApi<{ draft: { id: string } }>(page, "POST", "/api/v1/sheets/drafts", { link: sheetLink(id), sheetId: 0 })).data;
  const s = (
    await callApi<{ id: string }>(page, "POST", "/api/v1/sheets/sources", {
      importId: d.draft.id,
      name: "Website enquiries",
      pollSeconds: 3600,
      startFrom,
    })
  ).data;
  return s.id;
}
```

`pollSeconds: 3600` keeps the scheduled syncs out of the way, so what a test sees comes from its own Refresh. Check `callApi`'s real signature in `fixtures.ts` and match it.

- [ ] **Step 3: Write the specs** `apps/web/e2e/sheets.spec.ts`

```ts
import { expect, test } from "@playwright/test";
import { callApi, openApp, signInAs } from "./fixtures";
import { appendRows, connectViaApi, putSheet, sheetLink } from "./sheets-helpers";

const row = (i: number, name: string) => [`2026-09-27 0${i}:00:00`, name, `050300${String(i).padStart(4, "0")}`, ""];

test.describe("Google Sheets", () => {
  test("Settings → Integrations: switch on, add a sheet through the steps, and its leads arrive", async ({ page }) => {
    const id = await putSheet([row(1, "Wizard Lead One"), row(2, "Wizard Lead Two")]);
    await openApp(page, "/settings/integrations");
    const sw = page.getByRole("switch", { name: "Google Sheets" });
    if ((await sw.getAttribute("aria-checked")) === "false") await sw.click();
    await page.getByRole("button", { name: "Add a sheet" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a sheet" });
    await dialog.getByLabel("Sheet link").fill(sheetLink(id));
    await dialog.getByRole("button", { name: "Check" }).click();
    await expect(dialog.getByLabel("Tab")).toHaveValue("0");
    await dialog.getByRole("button", { name: "Continue" }).click(); // Sheet
    await dialog.getByRole("button", { name: "Continue" }).click(); // Columns
    await dialog.getByRole("button", { name: "Continue" }).click(); // Rules
    await dialog.getByRole("button", { name: "Continue" }).click(); // Preview
    await dialog.getByRole("button", { name: "Connect sheet" }).click();
    await expect(dialog).toBeHidden();
    const link = page.getByRole("link", { name: /Website enquiries/ }).first();
    await expect(link).toContainText(/2 new today/, { timeout: 15_000 });
    await openApp(page, "/leads?q=Wizard%20Lead");
    await expect(page.getByRole("row", { name: /Wizard Lead One/ })).toBeVisible();
  });

  test("Refresh brings new rows in with the real count, and they glow", async ({ page }) => {
    const id = await putSheet([row(3, "Before Refresh")]);
    await openApp(page, "/leads");
    await connectViaApi(page, id);
    await appendRows(id, [row(4, "Refresh Arrival A"), row(5, "Refresh Arrival B")]);
    await openApp(page, "/leads");
    const refresh = page.getByRole("button", { name: /Refresh/ });
    await refresh.click();
    await expect(page.getByRole("status").filter({ hasText: /new leads?/ })).toContainText(/\d+ new leads?/, { timeout: 20_000 });
    await expect(page.locator("tr[data-arrived]").filter({ hasText: "Refresh Arrival A" })).toBeVisible();
    await expect(refresh).toBeFocused();
  });

  test("a rep's Refresh counts only the leads they can see", async ({ page, browser }) => {
    const id = await putSheet([]);
    await openApp(page, "/leads");
    await connectViaApi(page, id);
    const rep = await signInAs(browser, "rep"); // the seeded sales rep (fixtures), who sees their own leads
    await appendRows(id, [row(6, "Nobody's Lead")]);
    await openApp(rep, "/leads");
    await rep.getByRole("button", { name: /Refresh/ }).click();
    await expect(rep.getByRole("status").filter({ hasText: /Up to date|for you/ })).toContainText("Up to date", { timeout: 20_000 });
  });

  test("Reduce Motion: a still card, the same words", async ({ page }) => {
    const id = await putSheet([row(7, "Still Card")]);
    await openApp(page, "/leads");
    await connectViaApi(page, id, "new");
    await appendRows(id, [row(8, "Still Card Two")]);
    await openApp(page, "/leads"); // the config's default is reducedMotion: "reduce"
    await page.getByRole("button", { name: /Refresh/ }).click();
    await expect(page.getByText("Syncing new enquiries").first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /new lead/ })).toBeVisible({ timeout: 20_000 });
  });

  test("with Sheets switched off there is no Refresh anywhere", async ({ page }) => {
    await openApp(page, "/leads");
    await callApi(page, "PUT", "/api/v1/integrations/google-sheets", { enabled: false });
    await openApp(page, "/leads");
    await expect(page.getByRole("button", { name: /Refresh/ })).toHaveCount(0);
    await callApi(page, "PUT", "/api/v1/integrations/google-sheets", { enabled: true });
  });

  test("screenshots: the Integrations card, a sheet's page, and the Refresh result — both themes", async ({ page }) => {
    const id = await putSheet([row(9, "Shot One")]);
    await openApp(page, "/leads");
    const sourceId = await connectViaApi(page, id);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, "/settings/integrations");
      await expect(page.getByRole("link", { name: /Website enquiries/ }).first()).toBeVisible();
      await expect(page.locator("main")).toHaveScreenshot(`integrations-${theme}.png`, { mask: [page.getByText(/Checked .* ago|Checking now|Not checked yet/)] });
      await openApp(page, `/settings/integrations/${sourceId}`);
      await expect(page.getByRole("table", { name: "Recent syncs" })).toBeVisible();
      await expect(page.locator("main")).toHaveScreenshot(`sheet-page-${theme}.png`, { mask: [page.locator("td").first(), page.locator("dd").first(), page.locator("dd").nth(1)] });
    }
  });
});
```

If the fixtures have no `signInAs(browser, role)`, use how `leads.spec.ts` opens a second person's page (the seeded "rep" in `seed.setup.ts`) and follow that pattern.

Add the Integrations page to `a11y.spec.ts`'s page list: `"/settings/integrations"`. That spec runs axe on each page.

- [ ] **Step 4: Run e2e**

Run: `bash scripts/dev.sh run bash -c 'cd apps/web && pnpm exec playwright test --update-snapshots=changed' > "$G/e2e.log" 2>&1; tail -30 "$G/e2e.log"`
Expected: every test passes, and the new screenshots are written.

Then fetch the baselines (`ssh lumedev 'cd /root/lume-dev/src && tar cf - apps/web/e2e/__screenshots__' | tar xf -`) and **look at every new or changed image**. Check that:
- the Sheets mark is on white in both themes;
- the blue is `#2A5BFF`;
- nothing overlaps.

Fix what's wrong and run again.

- [ ] **Step 5: Gate and commit**

Message: `test(e2e): Google Sheets end to end against a fake Google — the wizard, Refresh, a rep's count, Reduce Motion and screenshots in both themes`, with the trailer.

---

### Task 16: Acceptance — the runbook and the live run

**Files:**
- Create: `apps/web/e2e-live/acceptance-2b1.mjs`
- Modify: `docs/runbooks/acceptance.md` (a Phase 2B-1 section), `infra/scripts/gen-dev-env.sh` (pass a Google key through when one is present)

**Interfaces:** none new.

- [ ] **Step 1: The dev stack can take a real key.** In `infra/scripts/gen-dev-env.sh`, where the `.env` is written, add:

```bash
# Google Sheets (2B): the owner's service-account key, if they've put one on the box. Never in git.
if [ -f "$LUME_DEV_ROOT/secrets/google-sa.json" ]; then
  echo "GOOGLE_SERVICE_ACCOUNT_JSON=$(base64 -w0 < "$LUME_DEV_ROOT/secrets/google-sa.json")"
fi
```

Place it inside the block that builds the `.env` contents, matching how the other lines are emitted, and check that the API service in `infra/docker-compose.yml` passes `GOOGLE_SERVICE_ACCOUNT_JSON` through (add `GOOGLE_SERVICE_ACCOUNT_JSON: ${GOOGLE_SERVICE_ACCOUNT_JSON:-}` to its environment).

- [ ] **Step 2: The live acceptance script** `apps/web/e2e-live/acceptance-2b1.mjs`

This follows `acceptance-2a.mjs`: sign in as the owner through the setup token, then walk the spec's §1 success criteria.

1. Settings → Integrations shows Google Sheets **off**, with the service account's email once it's switched on.
2. If `ACCEPT_SHEET_LINK` is set (a real sheet shared with that email):
   - add it through the wizard with "Every row";
   - wait for its first sync;
   - check that the leads exist and that the sheet's page says "N new today";
   - press Refresh on Leads and check that the status line gives a real count (0 → "Up to date").
3. Without `ACCEPT_SHEET_LINK`, it stops after step 1 and prints `SKIP: no real sheet (set ACCEPT_SHEET_LINK)`.
4. It takes screenshots of each state into `e2e-live/.artifacts/2b1/`.

Write it by copying the structure of `acceptance-2a.mjs` (its sign-in, its `step()` logging and its failure snapshot) and replacing the steps.

- [ ] **Step 3: The runbook section** (append to `docs/runbooks/acceptance.md`)

```markdown
## Phase 2B-1 — Google Sheets and Refresh

**Needs:** a Google service-account key on the dev box (`/root/lume-dev/secrets/google-sa.json`, mode 600, never in git) and a test sheet shared with its `client_email` as a Viewer. Without them only step 1 runs; the automated e2e covers everything else against the fake Google.

1. `bash scripts/dev.sh up` (the key is picked up by `gen-dev-env.sh`), then `bash scripts/dev.sh reset-db` **only with the owner's go-ahead** (the dev DB is his demo).
2. `ACCEPT_SHEET_LINK='https://docs.google.com/spreadsheets/d/…' node apps/web/e2e-live/acceptance-2b1.mjs`
3. Expect: Integrations off by default → on; the sheet connects; its rows become leads; Refresh says the real count; the sheet's page shows its health. Screenshots in `apps/web/e2e-live/.artifacts/2b1/`.
4. Spec §2 checks by hand, once: sort the sheet → nothing new; rename a mapped column → the sheet pauses and Leads shows the banner; share it again / fix the column → Test again / Open columns.
```

- [ ] **Step 4: Run what can run now.** Run the full gate, then the whole e2e suite, then `acceptance-2b1.mjs` against the dev stack. The owner approved a reset of the dev DB for the overnight run of 2026-09-27; without a real key, only step 1 runs. Record the output in the runbook's run log.

- [ ] **Step 5: Commit, push, watch CI**

Message: `docs: Phase 2B-1 acceptance — the runbook, the live script, and the dev box ready for a real Google key`, with the trailer.

---

## Self-review (done while writing)

- **Spec coverage:**

  | Spec section | Task |
  |---|---|
  | §3 switch and env | 2, 7, 8 |
  | §4 data | 1 |
  | §5.1 scheduling | 6, 7 |
  | §5.2 steps 1–7 | 6 |
  | §5.3 never-dos | 6 (read-only client, no updates or deletes) |
  | §5.4 shape changes | 5, 6 |
  | §5.5 limits | 6 (rows), 8 (20 sheets) |
  | §7.1 | 10 |
  | §7.2 | 11 |
  | §7.3 | 12 |
  | §8.1 | 13 |
  | §8.2 | 9, 13 |
  | §8.3 | 9, 14 |
  | §9 | 8, 9 |
  | §10 | 6, 8 |
  | §11 | 3, 6, 8, 9, 15 |

  §6 (OAuth) is plan 2B-2.
- **Placeholders:** Three steps ask the implementer to match an existing file's exact names:
  - `callApi`, and the rep sign-in in the fixtures;
  - the ColumnsStep placement of `notice`;
  - the class names in `imports.module.css`.

  Each names the file to read and what to match. None leaves behaviour undecided.
- **Type consistency:**
  - `SheetSourceView`, `RefreshProgress` and `SheetDraft` (including `sheet.name`) match between Tasks 8 and 9 and `lib/sheets/types.ts`.
  - `requestSync` returns `{ syncId, fresh } | null` everywhere.
  - `sheetFingerprint(cells, mapping)` is used the same way in Tasks 5 and 6.
