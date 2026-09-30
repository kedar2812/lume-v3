# Phase 2B — Google Sheets, and the Refresh moment

Status: design approved in brainstorming on 2026-09-27; this document awaits the owner's review.
Parent spec: `2026-09-27-phase-2-intake-design.md` (its §12 outline is replaced by this document).
Built on Phase 2A: the intake engine (`packages/core/src/intake`), the import job, and the shared lead
writer. Sheets use all of these unchanged.

## 1. What this is for

Many businesses already collect enquiries in a Google Sheet, fed by ad lead forms, website forms, Google
Forms or Zapier. LUME reads new rows from one or more sheets automatically and turns them into leads.
It uses the same column matching, value rules, duplicate merging and phone handling as CSV import.

Everyone who works leads gets a **Refresh** that brings new enquiries in on demand, with a moment that
makes checking Leads a pleasant daily habit.

**Success:**
- A client connects a sheet once.
- New rows become leads within minutes, or at once on Refresh.
- There are zero duplicates.
- Nothing the team typed is ever overwritten.
- Opening Leads each morning feels rewarding: what arrived glows in, with honest counts.

## 2. Decisions made with the owner

| Question | Decision |
|---|---|
| Who sets up Google access | The owner (Kedar), once per client, as a **service account**. One key per client instance, set at deployment. |
| "Connect with Google" (OAuth) | Built now **behind a switch**. It becomes the default once Google approves LUME. It is for **connecting sheets only**. Signing in to LUME stays email + password + authenticator. |
| How rows reach LUME | **Automatically** every 2 minutes (the admin can set 1–60 per sheet), **plus Refresh**. |
| Who sees Refresh and the moment | **Everyone who works leads.** Each person's counts and glow cover only the leads they can see. |
| The Refresh animation | The approved mockup `refresh-sync-v5`: the button lifts, becomes a pill, opens into the card (sheet → rows → LUME over the blue bar), and settles back into the button as "✓ 4 new". The new rows glow for 5 s. |
| The words | "Syncing new enquiries" (never a sheet's name on the card). |
| Numbers | Always real: rows read, new leads the viewer can see, merges. Never placeholders. |
| Colour | LUME's one blue, #2A5BFF, in both themes. The card follows the theme: frosted white glass or dark glass. |
| Third-party marks | The official Google Sheets file from `public/brand`, unmodified, on a white tile, animations included. |
| Sound | None. New leads aren't an achievement. |

## 3. The module and its switch

- Sheets is an **optional per-instance integration**, off by default.
- It is enabled in Settings → Integrations by someone holding `settings.manage`.
- With it off, nothing Sheets-related shows or runs: no Refresh, no job, no Sources entries.
- The instance's environment decides which ways of connecting are offered:
  - `GOOGLE_SERVICE_ACCOUNT_JSON` (base64 of the key file) enables the service-account path. This is the default method.
  - `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_RELAY_URL` (+ a relay token) enable "Connect with Google" (§6). While Google's verification is pending they are left unset, and that path is invisible.
- The service-account key is read at start-up and never stored in the database or shown in any screen.
  Only its email is shown, with Copy.

## 4. Data

One migration, `0016_sheets.sql`.

**`lead_sources`** (from 2A), for `type = 'google_sheet'`:
- `config_enc`, encrypted with the keyring, holds:
  - `spreadsheetId`, `sheetId` (the tab's numeric id, stable across renames), `tabTitle` and `headerRow`;
  - `auth: "service_account" | "oauth"`;
  - with OAuth, the encrypted refresh token.
- New columns:
  - `poll_seconds int NOT NULL DEFAULT 120 CHECK (poll_seconds BETWEEN 60 AND 3600)`;
  - `next_sync_at timestamptz`;
  - `last_modified text` (Drive's `modifiedTime` at the last read);
  - `rows_read int NOT NULL DEFAULT 0` (how far LUME has read);
  - `head_hash text` (a hash of the header plus the first row, to notice the sheet being re-sorted or rows removed above);
  - `header_signature text`;
  - `sync_lock_until timestamptz`;
  - `stats jsonb` (today and all-time counts);
  - `config_version int NOT NULL DEFAULT 1`, bumped on every change to the mapping or rules, and `synced_config_version int`, the version the last sync ran with.
- `mapping` and `rules` hold the same `Mapping` and `Rules` as a CSV import (2A §5).

**`source_rows`**, one row per sheet row LUME has dealt with, per source:
- `source_id`, `fingerprint` (2A §6.10), `result` (`created | merged | skipped | error | dismissed | superseded`), `lead_id`, `sync_id` (the sync that last handled it), `row_number` (where it was last seen), `problems jsonb`, `raw_enc bytea`, `first_seen_at`, `last_tried_at`;
- `UNIQUE (source_id, fingerprint)`.
- This is how a row is recognised however the sheet is sorted, and how rows with problems are retried.

**`source_syncs`**, one row per sync run, for health and for Refresh:
- `id`, `source_id`, `trigger` (`schedule | refresh`), `requested_by`, `status` (`running | done | failed`);
- the counts: `rows_total`, `rows_read`, `created`, `merged`, `errors`;
- `started_at`, `finished_at`, `error`.
- Kept 30 days. The retention sweep deletes older rows and clears `raw_enc` like import rows.

**`source_refreshes`**, one row per Refresh press:
- `id`, `requested_by`, `sync_ids uuid[]` (the syncs it started or joined), `created_at`.
- Kept 1 day.
- Its counts are computed when asked. They join `source_rows` for those syncs to `leads` under the asking user's RLS, so every viewer gets their own numbers.

**Users.** `preferences.leadsSeenAt` (a timestamp) for the arrival glow (§8.3). It is updated when the Leads page is left or hidden, never on every render.

**Access.** Like the 2A intake tables, these have no RLS. The API enforces permissions, and `lume_worker` gets only the retention grants.

## 5. The sync engine

`apps/api/src/modules/sheets/`. It runs in the API process as `lume_app`, like the import job (2A amendment 1), on the job pool.

### 5.1 Scheduling
- A pg-boss queue `sheets.sync` (singleton per source).
- A cron tick every minute enqueues each active source whose `next_sync_at` is due.
- Refresh enqueues every active source immediately (§8).
- A source already syncing isn't started twice: the queue's `singletonKey` plus `sync_lock_until` guard it. A Refresh during a running sync **joins** it.
- A source synced in the last 10 seconds returns its last result instead of syncing again.

### 5.2 One sync, step by step
1. **Changed?** Ask Drive for the file's `modifiedTime`. If it equals `last_modified` and `synced_config_version = config_version`, the sync ends immediately as "up to date". Retrying unchanged rows under unchanged rules can't give a different answer. Drive's quota is separate and large, and this keeps Sheets reads for sheets that actually changed. One Google project serves every client, so this matters.
2. **Header check.** Read the header row. Its signature must still match the mapping (§5.4).
3. **Where to read from.**
   - If `head_hash` still matches, read rows `rows_read + 1 …` (only what's new).
   - Otherwise the sheet was re-sorted or rows were removed above, so read it all. Fingerprints make that safe.
   - Reads go in batches of 5,000 rows (fewer calls against Google's per-minute quota) with backoff on 429/5xx.
4. **Each row** goes through the 2A pipeline unchanged:
   - `mapRow` with the source's mapping and rules;
   - then the per-row transaction: advisory lock, match, create/merge/skip.
   - The row's `source_rows` entry is claimed inside that same transaction. A new fingerprint is inserted. An existing entry is left alone unless its result is `error`, in which case it is retried. So every row is handled once, even across crashes and repeats.
5. **Rows with problems** (result `error`) are retried whenever the sheet or the rules change, until they import or an admin dismisses them.
   - An incremental sync also re-reads the rows at the problem entries' `row_number`s, in one batched request.
   - A fixed row whose fingerprint didn't change imports.
   - A row edited so that its fingerprint changed is handled as a new row. Its old entry is closed as `superseded` once the row at that position no longer carries the old fingerprint.
   - A full re-read supersedes every `error` entry whose fingerprint no longer appears anywhere in the sheet.
6. **Progress.** `source_syncs.rows_read` is updated every 50 rows for the Refresh card.
7. **Finish.** Record the counts and `last_modified`/`rows_read`/`head_hash`, and set `next_sync_at = now + poll_seconds`.

### 5.3 What LUME never does
- It never writes to the sheet. Access is read-only by construction.
- It never updates a lead from an edited sheet row. After import, LUME is the source of truth.
- It never deletes a lead because its row disappeared.
- A person who fills the form again is a new row with the same contact: it merges ("Enquired again"), exactly as in 2A §6.9.

### 5.4 When the sheet changes shape
- **A mapped column renamed or removed** (the header signature changed):
  - the source becomes `needs_attention` and stops syncing;
  - admins see a banner on Leads and in Settings → Integrations naming the sheet and the column;
  - fixing it means opening the source's Columns step again.
  - A broken mapping never imports.
- **A new column added:** nothing breaks. The source shows "1 new column: map it?".
- **Access lost** (unshared, key revoked, OAuth token revoked) or **the sheet or tab deleted:** `needs_attention` with the reason and a "Test again" button.
- **Google unreachable or over quota:** the sync fails quietly with backoff. The source stays active, and after 3 failed syncs in a row it shows a warning.

### 5.5 Limits
- Up to 20 sheet sources per instance.
- 50,000 rows per sheet on the first sync. The owner can raise it in `.env`.
- Rows over 10,000 cells, or cells over 10,000 characters, are problems (2A limits).

## 6. "Connect with Google" (behind the switch)

- **Scope.** `drive.file` only, with **Google Picker**. The admin picks the one spreadsheet in Google's own picker, and LUME can open only that file. This is the least permission and Google's recommended pattern, and the lightest verification.
- **The relay.** Every client runs on their own domain, so the OAuth round trip goes through `apps/connect`, a tiny stateless service the owner hosts at `connect.lumecrm.in`.
  1. The instance starts the flow: `state` = HMAC-signed {instance URL, nonce, expiry}.
  2. Google returns to the relay. The relay exchanges the code with the client secret (which never leaves the relay) and hands the tokens to the instance's callback in a one-time, signed POST.
  3. The instance stores the refresh token encrypted, in the source's `config_enc`.
  4. Access-token refreshes go through the relay's `/refresh`, authenticated by the instance's relay token.
- **What passes through.** Only OAuth tokens. **No lead data ever passes through the relay.**
- **When the switch goes on.** Once Google approves LUME, setting the env values makes "Connect with Google" the first choice in Add a sheet, and the service-account path moves under "Other ways".
- **Tests.** Tests use a fake Google OAuth server. Real verification is the owner's step.

## 7. Screens

All screens use the `apple-design` principles: spring motion, response on press, clear hierarchy, reduced-motion equivalents, and both themes.

### 7.1 Settings → Integrations (new area, `settings.manage`)
- Google Sheets appears with its official mark, an On/Off switch and a one-line description.
- When On, it shows:
  - the service-account email with Copy (or "Connect with Google" when enabled);
  - the list of sheet sources, each with its status (Active, Paused, Needs attention, Off), last sync, "new today" and problems;
  - an **Add a sheet** button.

### 7.2 Add a sheet (a sheet over the app, reusing the Import sheet's frame, rail and steps)
1. **Sheet:**
   - paste the link (with the "share with this email" instruction), or use Google's Picker;
   - LUME tests access right away, then lists the tabs;
   - choose the tab and confirm the header row.
2. **Columns** and 3. **Rules:** the 2A steps, reused as they are.
4. **Preview:** the first 20 rows exactly as they'd land, with the 2A preview.
5. **Start from:** "Every row already in the sheet ({n})" or "Only rows added from now on". Then name the source (default: the spreadsheet's title) and choose how often to check it (default 2 minutes).
6. **Save:** the first sync runs at once. If the admin is on Leads, it plays the Refresh moment.

### 7.3 A source's page
It shows:
- health: the status, when it last synced, the next sync, and rows and new leads (today and all time);
- the last 10 syncs;
- problem rows with their reasons, each with Dismiss, plus a Download of the problem rows (2A report format).

Its actions are:
- **Sync now**, **Pause**, **Edit columns and rules** (a changed mapping applies to rows from then on, never retroactively), and **Remove**.
- **Remove** keeps the leads, and its confirmation says so.

## 8. The Refresh moment

### 8.1 Where and when
- A **Refresh** button in the Leads toolbar, beside Import (and on the board).
- Shown only when Sheets is on, at least one source is active, and the viewer can see leads.
- Keyboard: **R**, with the same guards as **N**.

### 8.2 What happens
This is the approved v5 motion, built with `motion` springs:
1. The button lifts into a glass pill: the LUME mark plus "Syncing new enquiries…".
2. The pill opens into the card, anchored under the button:
   - the official Google Sheets mark, rows drifting along an arc into the LUME mark;
   - "Reading rows… {read} of {total}";
   - the #2A5BFF → cyan bar filling with real progress.
3. At the end, a green tick springs in and the count ticks up to **{n} new leads** (or "{n} new for you"). "· {m} merged into existing ones" is added only when m > 0.
4. The card shrinks back into the button as the new rows slide into the table and glow (§8.3). The button reads "✓ {n} new" for 1.6 s, then "Refresh".

**The numbers are computed on the server:**
- `created` = leads created by this Refresh's syncs that the viewer's row-level security lets them see;
- `merged` = the same for merges;
- `rows_read` and `rows_total` are summed across the syncing sources.

`POST /api/v1/sheets/refresh` starts or joins the syncs and returns a refresh id. `GET /api/v1/sheets/refresh/:id` returns progress. The client polls it every 300 ms while the card is open, and stops when the card closes or the page is hidden.

**Other outcomes:**
- **Nothing new:** "Up to date" with the tick, back into the button in about 1.5 s.
- **Google unreachable:** an amber "Couldn't reach Google. LUME will try again in 2 minutes."
- **A source needs attention:** admins see "{sheet} needs attention" with a link. Reps see only the counts from sources that worked.

**Accessibility:**
- One polite live announcement at the start ("Syncing new enquiries") and one at the end ("{n} new leads").
- Focus stays on Refresh, which is disabled while the moment plays.
- **Reduce Motion:** a still card under the button with the bar and the count; no morph and no drifting rows. The glow is a plain fade.

### 8.3 The arrival glow
- New rows slide in at the top.
- They carry an #2A5BFF wash and a 3 px accent edge that settle in and fade over **5 s**.
- The rows are staggered 70 ms apart, the easing is "light passing" with no bounce, and a small "NEW" tag fades with the wash.
- **When you weren't watching:** on opening Leads, leads created since your `leadsSeenAt` get the same glow, with no card.
  - If more than 20 arrived, the newest 20 glow, with a quiet line above the table: "37 new since yesterday · Show only these". It filters by created time.
  - Your own imports and hand-made leads don't glow.
- The glow is per viewer and per visit, never stored.

## 9. API

All under `/api/v1`, all in the permission matrix (`probes.ts`):

| Method and path | Permission | What it does |
|---|---|---|
| `GET /integrations` | `settings.manage` | Which integrations exist and are on, and what's configured. |
| `PUT /integrations/google-sheets` | `settings.manage` | Switch Sheets on or off. |
| `POST /sheets/sources/inspect` | `settings.manage` | Test access to a sheet link: title, tabs, header guess. |
| `POST /sheets/sources` | `settings.manage` | Create a source as a draft, then reuse the 2A draft flow (patch mapping and rules, preview). |
| `PATCH /sheets/sources/:id` | `settings.manage` | Change the mapping, rules, poll interval or name; pause or resume. |
| `DELETE /sheets/sources/:id` | `settings.manage` | Remove. The leads stay. |
| `GET /sheets/sources`, `GET /sheets/sources/:id` | `settings.manage` | Health, syncs and problem rows. |
| `POST /sheets/sources/:id/sync` | `settings.manage` | Sync now. |
| `POST /sheets/sources/:id/rows/:rowId/dismiss` | `settings.manage` | Stop retrying a problem row. |
| `POST /sheets/refresh`, `GET /sheets/refresh/:id` | `leads.view` | The Refresh moment (§8.2). |
| `GET /integrations/google/connect`, `POST /integrations/google/callback` | `settings.manage` | OAuth, behind the switch (§6). |

## 10. Audit

These are written in LUME's words:
- `integration.enabled` and `integration.disabled`;
- `sheet.connected` and `sheet.removed`;
- `sheet.mapping_changed`;
- `sheet.paused` and `sheet.resumed`;
- `sheet.needs_attention` (by the system);
- `sheet.row_dismissed`.

Syncs themselves aren't audited, only their effects: a lead's history says "Imported from {sheet}" or "Enquired again".

## 11. Testing

- **The Google fake.** `packages/testing/google-fake` implements the few endpoints LUME uses: Drive `files.get` (`modifiedTime`), Sheets `spreadsheets.get` (tabs) and `values.get` (ranges), and the OAuth token/relay endpoints. It holds scriptable sheets (append, sort, rename a header, unshare, 429). Unit, integration and e2e tests all use it. No test ever calls Google.
- **Engine unit tests:**
  - incremental reading;
  - re-sort and removal detection with a full re-read and no duplicates;
  - fingerprints across a sort;
  - retry of problem rows and supersede on fix;
  - header-change pause;
  - join-don't-duplicate for concurrent Refreshes.
- **Integration:**
  - a 5,000-row sheet: first sync, then 30 appended rows, then a shuffle, then a renamed header, then a fix;
  - two sources feeding the same contact;
  - Refresh counts per viewer under RLS (an admin's count and a rep's count differ correctly).
- **e2e:**
  - add a sheet end to end (with the fake);
  - Refresh with the animation;
  - the glow on return;
  - a rep's personal count;
  - Reduce Motion;
  - Integrations off hides everything;
  - screenshots of the card mid-sync and at the end, and of the Integrations and source pages, in both themes;
  - axe checks.
- **Live:** on the dev stack with the owner's real service account and a real test sheet, once the owner provides one.

## 12. Plans

This spec is delivered in two plans, each ending in live acceptance:
- **2B-1: Sheets with the service account, Refresh and the glow.** Covers §3–5, §7, §8, §9 (except OAuth), §10 and §11.
- **2B-2: "Connect with Google" behind its switch.** Covers §6, the relay (`apps/connect`) and the Picker.

## 13. Out of scope

- Writing back to sheets.
- Updating leads from edited rows.
- Excel Online.
- Two-way sync.
- A notification centre: admins see banners for now, and the bell gets its own phase.
- Webhooks and ManyChat (2C).

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
