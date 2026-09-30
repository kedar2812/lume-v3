# The minors sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every minor finding deferred by the final reviews of Phases 2A–4C and Licensing L-A–L-C is fixed, proved already gone, or ruled on with a reason. Nothing is left as "deferred".

**Architecture:** No new subsystem. Each task takes one area's deferred minors (listed verbatim from its ledger or runbook section) and, for each: writes the test that shows it, watches it fail, fixes it, watches it pass. A minor whose test passes before any change was already fixed by later work: the ledger says so with the test kept. A minor that is a note rather than a defect (a runbook line, a changelog line) is fixed in the doc it names. A minor whose fix would be wrong is a `Ruling:` with its reason.

**Tech Stack:** as the codebase: Fastify API, Next 16 web, pg-boss worker, the licence app (Next, raw SQL), bash fleet scripts; vitest, Playwright.

**Spec:** the source is each area's own spec and final review. The findings are copied below from the ledgers (`.superpowers/sdd/*/progress.md`, `Final: minor (deferred)` lines), `docs/runbooks/acceptance.md` (4A, 4B, 4C) and `docs/overnight-2026-09-27.md` (3B, 3C).

## Global Constraints

- CLAUDE.md holds: no client names, integrations optional, lead data leaves an instance only to integrations the client enabled.
- Every code fix has a test that failed first (RED) and passes after (GREEN); the task's whole package suite is green at `task-done`.
- Copy speaks as "LUME"; sounds only on achievements; Reduce Motion gets a cross-fade, never a spring.
- New migrations only (never edit a deployed one); migration numbers continue from the last in `packages/db/migrations`.
- Tests run on the dev box through `scripts/dev.sh run` (never two at once); prettier's output is fetched back with scp.

## Review Focus

1. A fix that changes an API answer (409 instead of 500, 404 instead of 500) must not change any answer a screen already relies on.
2. Fixes to the licence server must keep `/v1/check`'s answer byte-for-byte the same for a well-formed request.
3. Screen-reader fixes must be checked in Chromium (the e2e), not only jsdom: 2026-09-30 showed jsdom naming differs.
4. A fix to a streaming/export path must still stream (no whole-file buffering on the server).
5. Fleet script fixes keep `--dry-run` calling nothing remote.

---

### Task 1: The licence server (L-B)

**Files:** `apps/licence/src/**`, `apps/licence/scripts/*`, `infra/licence/docker-compose.yml`, `.dockerignore`, root `package.json` (overrides).

Findings:
1. missing rates also drop a client from paying/joined/left counts, not only rupee totals → counts come from clients; only rupee sums need a rate (analytics.test).
2. a payment made on a day the rate fetch failed stores the last known day's rate as "that day's" → the payment records the rate's own date (payments carry `rate_date`, new migration) (clients.test).
3. the code step returns faster for an unknown email → the code step does the same TOTP/argon2 work for an unknown email (auth.test measures that both paths call the same verifier).
4. admin-create echoes the typed password → read it with echo off (TTY raw mode); the test runs the prompt function with a fake TTY and asserts setRawMode(true).
5. .dockerignore doesn't exclude .env*, *.pem, deploy/clients/*.env → add them (a test reads .dockerignore).
6. a malformed %-escape in an API path is a 500 → 404 (api.test).
7. the licence compose passes secrets as environment variables and doesn't drop capabilities → `cap_drop: [ALL]`, `security_opt: no-new-privileges`, `read_only` where the image allows; secrets as files is a Ruling (compose `secrets:` files, read via `*_FILE`) (compose test).
8. /v1/check reads the whole body before its 4 KB check → read the stream with a running cap, stop at 4 KB (check.test with a 1 MB streamed body).
9. uuid (moderate, under exceljs) → a pnpm override to a fixed uuid if exceljs accepts it; else Ruling.

### Task 2: The instance (L-A)

**Files:** `apps/web/src/components/licence/*`, `apps/api/src/licence/*`, `apps/worker/src/**`, `apps/api/src/export/service.ts`.

1. the read-only banner says "everyone can look and export" but reps don't have data.export → the words follow the viewer's permission (web test).
2. jobs skipped while locked don't log that they skipped → one log line per skipped run (worker test).
3. the browser holds the whole zip (r.blob()); a failed stream shows a raw "Failed to fetch" → the browser downloads the zip itself (a same-origin GET link, cookie-authenticated, `Content-Disposition`), and a failure reads in LUME's words (web + api tests).
4. notes/activity/follow-ups include rows for soft-deleted leads not in leads.csv → the same lead filter for every file (export test).

### Task 3: Releases and the fleet (L-C)

1. a pg-boss upgrade changes its schema outside "applied" → update.sh treats a changed pg-boss schema version as "migrations ran" (update.test).
2. release-marker.sh accepts non-semver → strict X.Y.Z (release.test).
3. /healthz doesn't say the version → `/healthz` answers `{ok, version}`; update.sh still checks the image (api test).
4. an IPv6 host would need brackets for scp → `upload` brackets an IPv6 host (fleet.test).

### Task 4: Sheets (2B-1)

1. the "needs attention" link on the Refresh card is inside aria-hidden and gone in 1.3 s → move it to the announcement/banner.
2. every Refresh failure is titled "Couldn't reach Google" and "2 minutes" is hard-coded → titles by code (offline, SHEETS_OFF, NO_SHEETS); the wait comes from the API's answer.
3. a failed action on the sheet page replaces the page with one error line; a failed Remove says nothing → inline error, page stays.
4. the "failing" line blames Google for internal errors → words by error kind.
5. the row limit's final check counts blank rows between filled ones → count filled rows.
6. POST /imports/:id/start on a sheet draft runs it as a one-off CSV import → 409 for kind ≠ csv.
7. refuseRow's upsert can overwrite a just-dismissed row → don't resurrect a dismissed row.
8. the stored tabTitle goes stale after a tab rename → refresh tabTitle on sync.
9. one sync at a time across all sheets → per-source singleton (pg-boss singletonKey per source).
10. multi-sheet Refresh locks sources without ORDER BY → ORDER BY id FOR UPDATE.
11. reads are 5,000-row chunks, the spec said 1,000 → Ruling (5,000 stands: fewer API calls under Google's quota; the spec is updated).

### Task 5: Connect with Google (2B-2)

1. the relay's code-token map is never swept → TTL sweep.
2. a Picker cancel or denied consent is a dead end; access_denied reads as "expired" → "Pick again" and its own words.
3. picker page's `open()` shadows window.open → rename.
4. a removed OAuth sheet keeps its sealed grant in config_enc → re-seal without it.
5. connectComplete's check-then-update isn't atomic → one conditional UPDATE.
6. GOOGLE_OAUTH_RELAY_URL accepts http: → https only outside tests.
7. relay hardening: frame-ancestors 'none', Referrer-Policy no-referrer; /done checks the file is a spreadsheet.
8. Google's 100-refresh-token limit with prompt=consent → runbook note.
9. "Continue with Google" branding; runbook homepage/privacy URLs → copy + runbook.
10. test gaps: second /done with the same code, expired state at /callback → tests.

### Task 6: Webhooks (2C)

1. X-Lume-Event-Id isn't covered by the signature → the signature covers `timestamp.eventId.body` when an event id is sent (documented; a post without one keeps the old form).
2. a stale timestamp is counted as bad_signature → its own `stale_timestamp` count.
3. the Website preset doesn't map `message` to notes → map it.
4. repeated form keys keep only the last value; paths can collide → join repeated values; a collision keeps the nested value and the flat key both (the flat one suffixed).
5. the test step has no 10-minute polling cap; an error isn't cleared after a later good poll → cap and clear.
6. Pause is hidden while a webhook needs attention → shown.
7. Retry and Dismiss aren't disabled while busy → disabled.
8. Rotate and Remove failures show nothing inside their dialogs → inline error.
9. a backdrop click on the Address and secret step closes it before the secret is copied → backdrop doesn't close that step.
10. pause-then-resume leaves attentionCode set → resume clears it.
11. no audit entry for creating a webhook or retrying a post → audit both.
12. anyone who knows the address can raise the refused count → Ruling (capped by the limiter; counting refusals is the point of the count).

### Task 7: Follow-ups, the notification centre and automations (3A, 3B, 3C)

1. "In 2 days" adds 48 h → calendar days in the person's zone.
2. Today's per-row Snooze buttons share a name; the bell has no live region → names carry the lead; a polite live region.
3. SSE writes ignore backpressure; a stream outlives a revoked session → drain-aware writes; the hub closes a session's streams on revoke.
4. the history line uses the browser's zone → the person's zone (3A and 3C list it).
5. the digest has no per-item links; new assignments are a count only → links and names (capped).
6. new arrivals in the centre have no highlight fade → the 4B accent wash.
7. a digest time in the last quarter hour of a day can be skipped → window test and fix.
8. a delayed digest still says "Good morning" → greeting by the send time.
9. reminders for follow-ups a webhook or sheet made wait for the sweeper → arm them at creation.
10. "Reminders late — restart the API" can fire right after a long outage's restart → a grace window after start.
11. switching "leads gone quiet" on works through an old backlog at 500 an hour → the backlog is marked seen when switched on (only new quiet leads alert), Ruling-level if the spec wants the backlog.

### Task 8: Templates (4A)

1. the render context returns lead and owner names even when a role can't see those fields → masked by field access.
2. confirm and prepare accept a follow-up id from another lead → refuse.
3. two creates or restores with the same name at once give 500 → 409.
4. reorder: failure doesn't restore order; a template added meanwhile; two reorders interleave → restore on failure, reorder the known set, serialise.
5. `confirmMessage` in messages.ts is dead code → remove.
6. money renders "INR 5,000" → Intl local form.
7. the send sheet's list doesn't scroll the active template into view; no Home/End → both.
8. the send sheet closes without an exit animation; the editor under Reduce Motion uses a spring on opacity → exit animation; 150 ms cross-fade.
9. the reply toast's Undo has no stale-Undo guard → guard.
10. inherited: "Sent?" lost on J/K or closing the centre; return detected by focus alone → keep the pending question per lead; also visibilitychange/pageshow.

### Task 9: Saved views (4B)

1. a malformed stored stageId can 500 /views/counts → validate ids; savepoint each stale probe.
2. out-of-order responses in loadCounts/loadViews → generation guard.
3. createdDays has no upper bound (future enquiry date = new today) → bound it.
4. leads events reach people without leads.view; a hub reconnect doesn't refresh counts → filter by permission; refresh on reconnect.
5. a failed Undo (name taken) and a failed Update view say nothing → say it.
6. each leads event costs every tab a count scan plus per-view probes → batch probes into one query.
7. the web offers fixed filter values while the API accepts any in range; a reason-only link has no chip → the API validates the same set; the chip shows.
8. stale doesn't cover an archived pipeline or a deleted select option; stage/tag/reason staleness untested → cover and test.
9. a personal and a shared view may share a name → the name is unique across what one person sees.
10. templates' keyboard reorder (4A) → checked in Chromium e2e; not reproduced (kept as a test).

### Task 10: The send queue (4C)

1. a template's role access removed mid-run refuses the rest of the run → the rest of the run skips that lead with a reason, the run goes on.
2. "Message these" plans from the view as saved → plans from the view as shown (unsaved filters included).
3. a lead lost after "Yes, sent" counts as skipped → counts as sent.
4. a Not sent lead can't be retried in the run → Retry.
5. no index behind the daily count → migration adding it.
6. a manual skip leaves like a done card → its own exit.
7. 0030 widens existing roles → CHANGELOG (already in 1.0.0: verify).
8. the run on phone widths → e2e at 390 px.

### Task 11: Intake notes (2A)

1. pg-boss queues shared by API and worker → verified by test that each queue has one consumer role; Ruling if already right.
2. Settings navigation/back arrows and type scale → owner's polish backlog: Ruling (owner asked to build features first; left to the polish pass).
