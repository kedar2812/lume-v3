# Phase 2 — Lead intake: design

**Date:** 2026-09-27 · **Status:** awaiting owner review · **Source:** `docs/LUME_PROJECT_REPORT.md` §8, §17 (Phase 2), §18.5

## 1. What this phase delivers, and in what order

LUME pulls leads in from wherever a business captures them. Phase 2 builds that intake as **one engine with several doors**, in three plans, each shipped and accepted on its own:

| Plan | Delivers | Needs from outside |
|---|---|---|
| **2A — Intake engine + CSV** | The mapping, validation, duplicate and per-row reporting engine; CSV import (migration of an existing lead list *and* occasional lists); the bulk phone-country fix | Nothing |
| **2B — Google Sheets** | A Sheets source on top of the engine: service account, tab and header choice, polling sync with row fingerprints, source health, "needs attention" on header changes | A Google Cloud project and a service account (the owner) |
| **2C — Inbound webhooks** | `POST /webhooks/in/:sourceId` on the same engine, with two security modes, and ready-made presets for **ManyChat**, Zapier, Make and plain website forms | For ManyChat: a Pro account to verify the preset against |

Decided with the owner (2026-09-27):

- Order is 2A → 2B → 2C. ManyChat is a general-purpose extra, not Nupuur's current source.
- CSV serves **both** a one-time migration (keeping stage, owner, original date, value, lost reason) and later occasional lists.
- On a match with an existing lead the default is **Merge**.
- Rows are processed by a **server job with one engine**, so every door behaves identically.

This document specifies 2A completely, and 2B and 2C at the level needed to keep the engine's shape right for them. 2B and 2C get their own detailed sections before their plans are written.

## 2. Principles (all of Phase 2)

1. **LUME's database is the source of truth.** Intake is a one-way pull; LUME never writes to a sheet, a CSV or a caller.
2. **Nothing is guessed silently.** A value LUME can't read is reported: as a row error when it would make the lead wrong, or as a warning when the lead is still right without it. Every decision in §6 says which.
3. **One bad row never stops the rest.** Each row is written in its own transaction and gets its own result.
4. **Contact problems never lose a lead.** A bad phone, email or Instagram value is kept or dropped with a warning; the lead still imports and can be fixed later.
5. **What the team typed is never overwritten.** A merge fills only empty fields.
6. **Nobody learns what their role hides.** Previews and reports name an existing lead, and its owner, only if the importer can see it.
7. **Every run is resumable and exact.** A row is written once, however often a job is retried.

## 3. Permissions

| Action | Needs |
|---|---|
| Start, configure, preview, run, cancel or resume a CSV import; see the import list and counts | `leads.import` |
| Assign imported leads to anyone other than yourself (an owner column, a fixed owner or round-robin) | `leads.import` **and** `leads.assign` |
| Create a custom field from a column during mapping | `fields.manage` |
| Map a column into a field | That field must be `edit` for the importer's role (hidden and view-only fields aren't offered) |
| Download an import's failed rows, or see raw values in its row report | The importer themselves, or someone holding `leads.import`, `leads.view` at scope `all`, and `leads.contact.full` |
| Bulk "Set country" on phone numbers | `leads.bulk_edit` and `leads.edit`, within the actor's scope |
| Connect Sheets or webhooks (2B, 2C) | `integrations.manage` |

The job re-checks `leads.import` (and `leads.assign` when the rules need it) before every batch. If the importer lost it, the job stops with status `stopped_access`.

## 4. Data model (2A)

New migration `0015_intake.sql`, mirrored in `packages/db/src/schema/intake.ts`. All tables get row-level security like the rest of the schema; the policies are in §4.5.

### 4.1 `lead_sources` — where leads come from

Used by 2A for attribution, and extended by 2B and 2C.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `type` | text | `csv` · `google_sheet` · `webhook` · `manual` |
| `name` | text | For CSV, the file name as uploaded (sanitised for display) |
| `config_enc` | bytea null | Encrypted JSON (2B: sheet id, tab, header row; 2C: secret). Null for CSV |
| `mapping` | jsonb | The column mapping (§5.3) |
| `rules` | jsonb | Dedupe and defaults (§5.4) |
| `status` | text | `active` · `paused` · `needs_attention` · `archived` |
| `last_synced_at`, `last_error` | | 2B and 2C |
| `created_by`, `created_at`, `archived_at` | | |

Each CSV import creates one `csv` source named after the file, so the leads list can filter and group "Source: leads-march.csv". Leads keep pointing at their source even after it's archived.

### 4.2 `imports` — one run

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `source_id` | uuid → lead_sources | |
| `kind` | text | `csv` (2B adds `sheet_sync`) |
| `status` | text | See the state machine, §7.1 |
| `file_enc` | bytea null | The uploaded bytes, encrypted with the keyring (AES-256-GCM). Nulled by the retention job |
| `file_sha256` | text | For the "already imported" warning |
| `file_name`, `file_bytes` | | |
| `encoding`, `delimiter`, `header_row` | | Detected, and overridable while a draft |
| `row_count` | int | Data rows after the header, excluding trailing empty rows |
| `mapping`, `rules` | jsonb | A copy taken when the run starts; later edits to the source don't change a running import |
| `cursor_row` | int | The last row index fully processed; resuming starts after it |
| `rr_cursor` | int | Round-robin position (§6.6) |
| `created`, `merged`, `skipped`, `errors`, `warnings` | int | Live counts, saved after every batch |
| `started_by`, `created_at`, `started_at`, `finished_at` | | |
| `stop_reason` | text null | `cancelled` · `access_changed` · `failed: <message>` |

### 4.3 `import_rows` — one row's outcome

| Column | Type | Notes |
|---|---|---|
| `id` | bigserial pk | |
| `import_id` | uuid | |
| `row_index` | int | 1-based data row number as the importer sees it (the file's line numbers, header counted, so it matches their spreadsheet) |
| `fingerprint` | text | sha256 of the row's normalised identity values (§6.10); used by 2B |
| `raw_enc` | bytea null | The row's cells, encrypted. Nulled by the retention job |
| `result` | text | `created` · `merged` · `skipped` · `error` |
| `lead_id` | uuid null | The lead created or merged into |
| `problems` | jsonb | `[{ column, code, message }]` for `error` rows |
| `warnings` | jsonb | Same shape; any result can carry warnings |
| `also_matched` | uuid[] | Other leads this row matched but didn't merge into |

`UNIQUE (import_id, row_index)` makes every row write-once: a retried job that reaches a finished row inserts nothing.

### 4.4 `import_mapping_memory`

`header_signature text pk` (sha256 of the lower-cased, trimmed header list in order), `mapping jsonb`, `rules jsonb`, `updated_by`, `updated_at`. When a file with the same headers is uploaded, its mapping and rules start from the remembered ones, re-validated against today's fields and stages (anything that no longer exists is dropped and flagged).

### 4.5 Row-level security

- `lead_sources`, `imports` and `import_mapping_memory` are readable by anyone with `leads.import`, and written through the API only.
- `import_rows` is readable by an import's starter, and by the §3 "raw values" holders. Everyone else with `leads.import` sees counts only, never rows.
- The job itself runs as `lume_worker`. For each row it sets `lume.user_id` to the importer and `lume.lead_scope` to `all`, inside that row's transaction only (the pattern of migration 0012). The duplicate check must see every lead; the importer still learns only what their own scope allows (§6.8).

### 4.6 Retention

A nightly maintenance step nulls `imports.file_enc` and `import_rows.raw_enc` 30 days after an import finished (or was abandoned as a draft). Counts, results, problems and lead links stay. Drafts never started are deleted outright after 7 days.

## 5. The engine (`packages/core/src/intake/`)

Pure functions with no database access, so every rule is unit-tested in isolation. Both the API (for preview) and the worker (for the run) call exactly the same code.

### 5.1 Reading the file — `readCsv(bytes, overrides?)`

Returns `{ encoding, delimiter, headerRow, headers, rows, fileWarnings }`, or a file-level refusal.

- **Encoding:**
  - a UTF-8 BOM means UTF-8;
  - a UTF-16 LE or BE BOM means UTF-16;
  - otherwise, bytes that decode as strict UTF-8 are UTF-8;
  - otherwise Windows-1252, with the file warning "Some characters may be wrong — check the accents in the preview". The importer can override with UTF-8, UTF-16 or Windows-1252.
- **Delimiter:**
  - chosen from `,` `;` tab `|` as the one that gives the most consistent column count over the first 50 lines, outside quotes;
  - a tie prefers `,`;
  - overridable.
- **Parsing:** RFC 4180 through a maintained parser (Papa Parse), not hand-rolled.
  - Quoted cells may contain the delimiter, `""` and line breaks.
  - CRLF, LF and lone CR line endings are all accepted.
- **Header row:**
  - defaults to the first non-empty line;
  - can be set to any of the first 10 lines (for files with a title line);
  - lines above it are ignored.
- **Headers:**
  - trimmed;
  - an empty header becomes `Column C` (by spreadsheet letter);
  - a repeated header becomes `Phone (2)`, `Phone (3)`.
- **Rows:**
  - trailing rows whose cells are all empty are dropped and not counted;
  - a row with fewer cells than headers is padded with empties;
  - a row with more cells keeps the extras out of the mapping and gets a warning naming the lost cells.
- **Refused outright, with the reason:**
  - an empty file;
  - a header but no data rows;
  - more than 10 MB (also enforced by the API's body limit);
  - more than 20,000 data rows;
  - more than 200 columns;
  - an Excel file (`.xlsx`/`.xls` bytes or extension): "Save it as CSV (File → Save as → CSV UTF-8) and upload that";
  - bytes that aren't text in any supported encoding.
- **A single cell over 10,000 characters** is a row error, "Too long", and doesn't refuse the file.

### 5.2 Suggesting a mapping — `suggestMapping(headers, fields, memory?)`

- Remembered mappings win (§4.4).
- Otherwise each header is compared, case- and punctuation-insensitively, against a synonym table and every field's label and key. For example:
  - `phone`, `mobile`, `whatsapp`, `contact number` → Phone;
  - `full name`, `name` → Name;
  - `first name` + `last name` → Name, as a two-column combine;
  - `date`, `created`, `timestamp`, `submitted at` → Created date;
  - `owner`, `assigned to`, `handled by` → Owner;
  - `status`, `stage` → Stage.
- A header matches at most one field, and a field is suggested for at most one column (except Name's first+last combine and multi-choice).
- Anything unsure is left as "Ignore". A wrong suggestion is worse than none.

### 5.3 Mapping shape

```ts
type ColumnMap =
  | { column: number; to: "ignore" }
  | { column: number; to: "field"; field: string /* key */; transform: Transform }
  | { column: number; to: "new_field"; label: string; type: FieldType; transform: Transform };

type Transform = {
  trim: true;                                   // always
  case?: "lower" | "title";                     // text only
  dateOrder?: "DMY" | "MDY" | "YMD";            // date/datetime, created date
  defaultCountry?: string;                      // phone: overrides the rules' default
  valueMap?: Record<string, string | null>;     // raw → option label / stage name / owner email / "yes"|"no" / null (= leave empty)
  splitOn?: "," | ";" | "|";                    // multi-choice and tags; default: , and ;
};
type NameMap = { first: number; last?: number }; // the combine case
```

A mapping is valid only if:
- at least one column maps to Name (or a first/last pair), **or** the rules' "no name" fallback is on (§6.4);
- no field is mapped twice (except by a first/last Name pair);
- every `new_field` has a unique label that doesn't clash with an existing field.

The API refuses to start an import whose mapping or rules aren't valid.

### 5.4 Rules shape

```ts
type Rules = {
  matchOn: ("phone" | "email" | "instagram")[];  // ordered; default all three
  onMatch: "merge" | "skip" | "duplicate";       // default merge
  reopenClosedTo: string | null;                 // stage id: a merged won/lost lead moves here; default null (stays closed)
  pipelineId: string;                            // default: the default pipeline
  stageId: string;                               // entry stage when no stage column; default: its first open stage
  owner: { mode: "unassigned" } | { mode: "user"; userId: string } | { mode: "round_robin"; userIds: string[] };
  defaultCountry: string | null;                 // default: the business's country
  noName: "use_contact" | "error";               // default use_contact
  unknownOwner: "fallback" | "error";            // default fallback (to the owner rule), with a warning
};
```

### 5.5 Mapping one row — `mapRow(cells, mapping, rules, ctx)`

`ctx` carries everything the row is checked against:
- fields with their options;
- the pipeline's stages;
- active and disabled people (id, name, email);
- tags;
- the business currency, timezone and country;
- today's date in the business timezone.

Returns `{ draft, warnings }` or `{ problems, warnings }`. A draft holds the lead's fields, custom values, tags, stage, owner hint and created date. `mapRow` never touches the database; §6 lists every rule it applies.

## 6. Every rule, and every edge case

### 6.1 Empty rows and whitespace

- Every cell is trimmed; non-breaking spaces count as spaces.
- A row whose *mapped* cells are all empty is `skipped` with the reason "Empty row", and counted separately in the report ("12 empty rows").

### 6.2 Name

- A mapped name is trimmed, and internal runs of spaces collapse to one.
- First + last combine as "First Last", skipping whichever is empty.
- `case: "title"` is available but off by default: names are kept as typed.
- Longer than the API's name limit (200) → error "Name is longer than 200 characters".

### 6.3 Contacts

- **Phone:** through `normalizePhone(raw, transform.defaultCountry ?? rules.defaultCountry)`.
  - `valid`, `needs_country` and `invalid` all import; the raw value is always kept.
  - `invalid` and `needs_country` add a warning.
  - A value in scientific notation (`9.71501E+11`, `9,71501E+11`) is kept raw, status `invalid`, with the warning "Excel shortened this number; the full number is lost — re-export the column as text".
  - Several numbers in one cell (`050 111 2222 / 055 333 4444`, separated by `/`, `,`, `;` or " or "): the first becomes the phone, and the rest go into the history entry with a warning.
- **Email:**
  - trimmed and lower-cased;
  - a `mailto:` prefix is stripped;
  - an invalid address is dropped with the warning "Not an email address: …".
- **Instagram:**
  - `@handle`, `handle` and `instagram.com/handle` URLs (with or without `www.` and query strings) all become `handle`;
  - an invalid handle (not 1–30 of letters, digits, `.` and `_`) is dropped with a warning.

### 6.4 A row without a name

- `noName: "use_contact"` (the default):
  - the name becomes the formatted phone, else the email, else `@handle`;
  - a warning "No name; used the contact instead" goes on the row;
  - the report lists these rows, and the leads list can filter them (their history carries the "no name in the import" note).
- `noName: "error"` → error "No name".
- A row with no name **and** no usable contact is always an error: "No name and no contact".

### 6.5 Stage (a mapped stage column)

- Matched by name within `rules.pipelineId`, ignoring case and extra spaces, or through the column's `valueMap`.
- Unknown or archived → error "No stage called 'X' in Coaching sales". The mapping step lists every unmatched stage value first, so they can be mapped before running.
- A Won stage sets `won_at` to the row's created date (else today); a Lost stage sets `lost_at` the same way. A lost reason column is matched like a choice (§6.8); without one, the reason stays empty.
- **A stage's required fields are not enforced for imports.** History must not be refused. Each such lead gets a warning, and the report counts "N leads are missing fields their stage asks for".
- Without a stage column, every created lead enters `rules.stageId`.

### 6.6 Owner

**A mapped owner column:**
- Matches an active person by email (case-insensitive), else by name when exactly one active person has it.
- Two or more people with that name → error "More than one person is called 'Sam'; use their email".
- Unknown or disabled:
  - `unknownOwner: "fallback"` → the owner rule applies, with the warning "No active person 'X'; used the owner rule";
  - `"error"` → error.
- If the importer lacks `leads.assign`, an owner column can only resolve to the importer or be empty. Any other name is an error, "You can't assign leads to others". The rules step says so before running.

**The owner rule**, when there's no owner column or it's empty:
- `unassigned`.
- `user`: must be active at run time; if not, unassigned with a warning.
- `round_robin` over the chosen people:
  - ordered by name, then id;
  - `rr_cursor` advances only when a lead is *created*;
  - a person disabled mid-import is skipped;
  - if all are disabled, unassigned with a warning.

**Merges never change an existing owner.** An existing *unassigned* lead counts as empty, and gets the row's owner.

### 6.7 Dates (created date, and date/datetime custom fields)

- **Accepted:**
  - ISO `2026-03-04` and `2026-03-04T10:30[:ss][Z|±hh:mm]`;
  - separators `/`, `-` and `.`;
  - two- or four-digit years (two digits mean 20xx when ≤ today's year − 2000 + 1, else 19xx);
  - month names in English, full or three letters (`4 Mar 2026`, `March 4, 2026`);
  - Excel serial numbers from 20000 to 80000, 1900 date system.
- **Order per column:**
  - scan every non-empty value;
  - any value with a first part over 12 means DMY, any with a second part over 12 means MDY;
  - if both appear, the column's `dateOrder` must be chosen by the importer (preview blocks until then);
  - if neither appears (all ambiguous), the default comes from the business country (US → MDY, everywhere else DMY), shown in the mapping step as "Read 03/04/2026 as 3 April (change)".
- **A date without a time** is that calendar date in the business timezone. A datetime without an offset is business-timezone local time. With an offset, it's converted. The lead's `lead_created_at` is a calendar date in the business timezone.
- **Impossible** (31/02, month 13) → error. **After today** (business timezone) → error "Date is in the future — check the day/month order". **Before 1990** → error "Date looks wrong".
- **Empty** → no date (the lead's created date shows as when it was imported).

### 6.8 Choices, tags, lost reasons, booleans, numbers, links, people fields

- **Single choice:**
  - matched to an option label ignoring case, accents and extra spaces, or through `valueMap`;
  - unmatched → error "'Gold' isn't an option for Tier".
  - The mapping step lists each distinct unmatched value with its row count, and three choices: map it to an option, add it as a new option (`fields.manage` only), or leave it empty (`valueMap → null`).
- **Multi-choice and tags:**
  - split on `,` and `;` (or the column's `splitOn`);
  - each part is matched like a single choice;
  - duplicates collapse;
  - tags not found are created only if the importer chose "Create missing tags" in the mapping step and holds `settings.manage`; otherwise it's an error listing them.
- **Lost reason:** matched to a live reason like a single choice, and only meaningful for a Lost stage (ignored with a warning otherwise).
- **Boolean:**
  - `yes/no`, `y/n`, `true/false`, `1/0`, `✓/✗`, `x/(empty)`, case-insensitive, or `valueMap`;
  - anything else → error.
- **Number:**
  - accepts `1,234.5`, `1.234,5`, `1 234,5` and `1234`;
  - the decimal mark is the last `.` or `,` followed by 1–2 digits, or 3 digits when no other separator appears;
  - ambiguous single-separator values like `1,234` are thousands in a column where any value has two separators, else decided by the business country's convention;
  - `%` is stripped for number fields;
  - an empty cell leaves the field empty.
- **Money (value, currency fields):**
  - as Number, plus an optional currency code or symbol before or after;
  - the business currency's code or symbol is accepted;
  - any other currency → error "This amount is in USD; LUME works in AED — convert it before importing";
  - negative → error;
  - more than 2 decimals → rounded half-up with a warning.
- **Link:** `http(s)://` is added when missing; anything that isn't a valid URL is dropped with a warning.
- **Person field:** matched like Owner (§6.6), without the rule fallback: unknown → error.
- **Long text:** kept as-is, line breaks included, up to 10,000 characters.

### 6.9 Duplicates and merging (in the job, per row)

1. Build the row's contact keys, in `rules.matchOn` order, from the draft (phone only if `valid`: an unreadable number never matches).
2. Take a transaction-scoped advisory lock on each key's hash, sorted, so two imports (or an import and a person typing) can't race on the same contact.
3. Look up `lead_contact_keys` for those hashes, joined to leads that aren't deleted, in any pipeline.
4. **No match** → create.
5. **Matches:** the lead matched by the earliest key in `matchOn` wins; ties (the same key matching two leads, possible for older data) go to the most recently active lead. Every other matched lead is recorded in `also_matched`.
6. By `rules.onMatch`:
   - **merge:**
     - each draft field fills the lead's field only if it's empty. Empty means null or `""`; for multi-choice an empty list; for phone, status `missing`; for owner, unassigned;
     - tags are added (a union);
     - `lead_created_at` fills only if empty (the lead's first appearance stays its origin);
     - if the lead is won or lost and `reopenClosedTo` is set, it moves there, with a stage-history row and `won_at`/`lost_at` cleared;
     - `version` increments;
     - an activity "Enquired again (import: leads-march.csv, row 42)" records which fields were filled.
   - **skip** → result `skipped`, with the matched lead linked.
   - **duplicate** → create a new lead anyway; the row links the matched lead in `also_matched`.
7. **Within one file**, rows commit in order, so a later row that repeats an earlier row's contact merges into the lead that earlier row created. Re-importing the same file merges every row, so nothing is duplicated.

### 6.10 Creating a lead

- Same writes as creating by hand:
  - the lead row;
  - its contact keys;
  - a stage-history row;
  - an assignment-history row when owned;
  - the tags;
  - an `imported` activity "Imported from leads-march.csv (row 42)", with the row's warnings summarised.
- `source_id` is the import's source; `created_by` is the importer.
- The created date comes from the mapping (else empty); `stage_entered_at` is the created date when one was mapped, else now.
- `fingerprint` = sha256 of the normalised identity values:
  - the mapped created date, E.164 phone, email and Instagram, joined by `\u001f`;
  - or, when all four are empty, of all mapped cells.

  2B uses it to recognise a row it has already imported; for CSV it's recorded for traceability.
- The lead-writing path is **extracted from the API's `createLead` into a shared module** (`packages/db`), used by both the API and the worker. There's no second copy of "what creating a lead means".

### 6.11 Preview — `POST /imports/:id/preview`

- Runs the first 20 data rows (or 20 chosen rows, for "show me the errors") through `mapRow` and a read-only duplicate check.
- Writes nothing.
- Treats earlier preview rows as if created, so within-file repeats show "Merges into row 3".
- Returns per row: the outcome, the lead it would merge into, warnings and problems.
- A merge into a lead the importer can't see says "An existing lead" with no name or owner; one they can see names it (and its owner if they can see the owner).
- Also returns, per mapped column, the distinct values that failed to match (up to 50, with row counts), the detected date order, and whole-file counts of empty rows and too-long cells. The mapping step's "unmatched values" panel is built from this.

### 6.12 The report

- **Counts:** created, merged, skipped (with empty rows shown separately), errors, rows with warnings, "no name, used contact", "missing required stage fields" and "phone needs a country".
- **Failed rows** download as CSV:
  - the original headers plus a leading `Problem` column, in file order;
  - formula-injection-safe: any cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`;
  - UTF-8 with BOM, so Excel opens accents correctly.
- **Fix and retry** is simply importing that CSV: its `Problem` column is ignored by suggestion, and already-imported rows would merge.

### 6.13 The bulk phone fix

- New bulk action `{ type: "set_phone_country", country }` on the existing bulk endpoint, obeying its scope and permission checks.
- For each selected lead:
  - `phone_status` already `valid` → skipped, "already valid";
  - no raw number → skipped, "no number";
  - otherwise `normalizePhone(phone_raw, country)`: valid → stored with its contact key and a history entry "Country code set (+971)"; still not valid → left as it was, skipped with the reason ("too short for UAE numbers", etc.).
- Works on numbers the actor sees masked. The response and the UI reveal no digits.
- The result uses the existing "N fixed, M skipped: reason" bulk summary.

## 7. The job

### 7.1 States

```
draft ──start──▶ queued ──▶ running ──▶ done
  │                │           ├──cancel──▶ cancelling ──▶ cancelled ──resume──▶ queued
  │                │           ├──access lost──▶ stopped_access ──resume (once regained)──▶ queued
  │                │           └──unexpected error ×5──▶ failed ──resume──▶ queued
  └──discard──▶ (deleted)      └──cancel (before it runs)──▶ cancelled
```

Only `draft` can change mapping, rules, encoding, delimiter or header row. Everything after `start` uses the copies taken at that moment.

### 7.2 A run (pg-boss job `imports.run`, singleton per import)

1. Load the import. If its status isn't `queued`/`running`, exit (someone cancelled).
2. Mark it `running`.
3. Decrypt the file, `readCsv` with the saved settings, and build `ctx` once.
4. From `cursor_row + 1`, in batches of 200:
   - re-check the importer's permissions (§3). If they're lost → `stopped_access`, and exit;
   - if the status is `cancelling` → `cancelled`, and exit;
   - for each row: its own transaction.
     - `mapRow`;
     - on error, insert an `import_rows` error;
     - otherwise run §6.9–6.10 and insert the `import_rows` result.
     - The insert uses `ON CONFLICT (import_id, row_index) DO NOTHING`. If it inserted nothing, the row was already done: roll back and continue.
   - after the batch: update counts and `cursor_row` in one statement.
5. **Unexpected exceptions** (not row problems): pg-boss retries the job with backoff, up to 5 attempts, and each attempt resumes from `cursor_row`. After the last, the status is `failed` with the message.
6. **When finished:**
   - `done` with `finished_at`;
   - audit `import.finished` with the counts;
   - the importer is told once. LUME has no notification centre until Phase 3, so for now the finished import shows a "Done" badge on the Import button and at the top of Settings → Imports until opened. Phase 3's notification centre adds one notification ("leads-march.csv: 4,812 created, 190 merged, 3 errors");
   - no per-lead notifications, and no automations for imported leads (§9).

### 7.3 Concurrency

- Two imports can run at once. Contact advisory locks (§6.9) keep them from creating the same person twice.
- The job's own database connections are capped (worker pool of 5), so an import never starves the API.

## 8. API (2A)

All under `/api/v1`, JSON unless noted. Every route goes into `test/probes.ts` (the permission matrix) and gets integration tests.

| Route | Does |
|---|---|
| `POST /imports` | Body `application/octet-stream` (the file, ≤ 10 MB), header `X-File-Name`. Reads it (§5.1). Creates the `csv` source and a `draft` import. Returns the detected settings, headers, 5 sample rows, the suggested mapping and rules, and `alreadyImported: { at, by } \| null` when `file_sha256` matches a finished import. File refusals are `400` with a specific code (`FILE_EMPTY`, `FILE_TOO_BIG`, `TOO_MANY_ROWS`, `TOO_MANY_COLUMNS`, `NOT_CSV_EXCEL`, `NOT_TEXT`) |
| `PATCH /imports/:id` | Draft only. `{ encoding?, delimiter?, headerRow?, mapping?, rules? }`. Re-reads the file when reading settings change, and returns the same shape as upload. Invalid mapping or rules → `400` with field-level `details` |
| `POST /imports/:id/preview` | §6.11. `{ rows?: number[] }` to preview specific rows |
| `POST /imports/:id/start` | Draft → queued. Re-validates everything, creates any `new_field`s and any options or tags chosen in mapping (permissions checked), copies mapping and rules, audits `import.started`, enqueues. `409 NOT_DRAFT` otherwise |
| `POST /imports/:id/cancel` | queued or running → cancelling or cancelled |
| `POST /imports/:id/resume` | cancelled, stopped_access or failed → queued (permissions re-checked) |
| `DELETE /imports/:id` | Draft only: removes it and its source |
| `GET /imports` | Newest first, cursor-paged: name, status, counts, who and when |
| `GET /imports/:id` | Status and counts (the progress screen polls this every 2 seconds while running) |
| `GET /imports/:id/rows?result=&cursor=` | Row results. Raw values only for the §3 holders |
| `GET /imports/:id/errors.csv` | §6.12, same holders |
| `POST /leads/bulk` | Gains the `set_phone_country` action (§6.13) |

**Audit actions:** `import.started`, `import.finished`, `import.cancelled`, `import.stopped`, `import.failed`, `import.discarded`. Each gets a phrase in `lib/settings/audit.ts`, whose test lists every action the API writes.

## 9. Automations and notifications

Phase 3 builds automations. So they can't misfire later, every imported lead's creation activity has type `imported`, and the lead's source type is `csv`. Phase 3's "lead created" triggers must ignore `imported` by default (a per-source switch can opt in, for 2B and 2C sources that are live intake rather than history). This is recorded here so Phase 3 honours it.

## 10. Screens (2A)

**Voice:** the product speaks as **LUME** in its own copy ("LUME will let you know", "LUME couldn't read row 42"), never a faceless "we" — the owner wants people to recognise LUME as the one doing the work for them.

Built to the existing design system (Porcelain and Carbon, the settings panel language, Apple-grade motion), with every state designed: loading, empty, error, partial and done.

- **Leads toolbar → "Import"** (for `leads.import` holders) opens a full-screen sheet with a step rail: **File → Columns → Rules → Preview → Import**. Back and forward keep everything, and closing a draft asks "Keep this draft?".
- **File:**
  - a drop zone, with a click to choose;
  - the refusal reason inline when refused;
  - detected encoding, delimiter and header row as editable chips;
  - the "already imported on 3 Sep by Tasneem" banner.
- **Columns:**
  - one row per column: header, 3 sample values, a field picker (grouped: Contact, Lead, Custom, Ignore, "New field…"), and a transform line (date order, default country, split, case);
  - an **Unmatched values** panel, per column: each distinct value with its count and map / add / leave empty. Preview stays locked while any column has unresolved unmatched values that would make rows fail, or an unresolved date order. The lock says exactly what's left.
- **Rules:**
  - Match on (reorderable chips);
  - When it matches (Merge, recommended, with one line on each option);
  - Reopen closed leads to…;
  - Pipeline and entry stage;
  - Owner (unassigned, a person, or taking turns; people beyond yourself only with `leads.assign`);
  - Default phone country;
  - Rows without a name.
- **Preview:**
  - the 20 rows as a table of outcomes (Create, Merge into…, Skip, Error), with warnings and problems inline in plain words;
  - a summary line ("16 create · 2 merge · 2 errors");
  - "Show rows with errors" (up to 20 errors from the whole file) jumps back to fix the mapping.
- **Import:**
  - a progress ring and live counts, "You can close this — LUME will let you know when it's done" (until Phase 3, LUME does that with the Done badge; §7.2), and Cancel;
  - at the end, the report with "Download failed rows" and "View imported leads" (the leads list filtered to this source).
- **Settings → Imports** (a new Settings area for `leads.import`): past imports with status, counts, who and when; open one for its report; Resume where allowed.
- **Leads table:**
  - the bulk bar gains "Set country…" when any selected lead's phone isn't valid;
  - a country picker (the existing searchable one);
  - the result in the bulk summary.

## 11. Testing and acceptance (2A)

- **Unit (`packages/core/src/intake`):** every rule in §5 and §6, table-driven, including each listed edge case. The fixtures are:
  - UTF-16 and Windows-1252 bytes;
  - embedded newlines;
  - ragged rows;
  - duplicate and blank headers;
  - Excel serials and scientific phones;
  - DMY/MDY columns (decidable and ambiguous);
  - European money;
  - foreign currency;
  - no-name rows;
  - multi-number cells;
  - title lines above the header.
- **Integration (API + worker against Postgres):**
  - upload → preview → start → done;
  - resume after a simulated crash mid-batch (no row twice);
  - cancel and resume;
  - two imports racing on the same contacts (one lead);
  - merge semantics field by field;
  - reopen closed leads;
  - hidden-lead privacy in preview and report;
  - permission loss mid-run;
  - owner rules and round-robin with a disabled person;
  - `set_phone_country`;
  - the permission matrix.
- **The report's acceptance, as an automated test:**
  - a generated 500-row file with mixed phone formats (local, international, `00`-prefixed, spaced, scientific, blank) and repeated contacts imports with zero duplicate leads and the expected `phone_status` for every row;
  - re-importing it creates nothing new (all merges, no field overwritten);
  - a row-shuffled copy creates nothing new.
- **End to end (Playwright):**
  - the full flow in both themes;
  - a11y on every step;
  - screenshots of Columns, Preview and the report;
  - a rep without `leads.import` sees no Import button;
  - the bulk phone fix.
- **Live acceptance** on the dev box (`acceptance-2a.mjs`), with screenshots, then a database reset for the owner.

## 12. 2B — Google Sheets (outline; detailed before its plan)

- **Auth:** one Google service account per installation. Its key is pasted once in Settings → Integrations and stored encrypted. The screen shows the account's email with Copy, and "Test access" per sheet. Read-only by construction.
- **Setup:** paste a sheet link → tabs listed → tab and header row → the same Columns and Rules steps as CSV → Preview → backfill choice (all existing rows, or only rows added from now) → Save.
- **Sync:** job `sheets.sync` every `poll_interval_sec` (default 120, minimum 60) plus "Sync now". It reads the mapped range in batches with backoff on 429/5xx, and runs each row through the same `mapRow`, dedupe and write path.
  - **Row identity is the fingerprint** (§6.10), unique per source. Sorting, inserting or deleting rows creates nothing.
  - An already-imported fingerprint is ignored: LUME is the source of truth after import.
- **Header changes:** a mapped header renamed or removed → the source becomes `needs_attention`, sync pauses, and admins are notified. A broken mapping is never imported.
- **Health:** last sync, rows seen and imported, errors with fix-and-retry, and the source's status on a Sources page.
- **Onboarding copy:** once live, remove the sales team's access to the sheet (report §8.1).

## 13. 2C — Inbound webhooks, with ManyChat (outline; detailed before its plan)

- **Endpoint:** `POST /webhooks/in/:sourceId` returns `202` at once, and processing is queued through the same engine. The mapping uses JSON paths instead of columns.
- **Two security modes, chosen per source:**
  - **Signed:** HMAC-SHA256 of the raw body in `X-Lume-Signature`, plus `X-Lume-Timestamp` within 5 minutes. For Zapier, Make, custom website code, and SuperReply if it can sign.
  - **Secret token:** a long random token in a header (`X-Lume-Token`). For tools that can send fixed headers but can't sign — **ManyChat's "External Request"** is one. The token is shown once, can be rotated, and is compared in constant time.
- **Replay protection:** a `webhook_events` table keeps each event's id or body hash. Rate limit per source 60/min by default (edge and API).
- **Presets:** choosing ManyChat, Zapier, Make or Website form pre-fills the JSON-path mapping and shows copy-paste setup steps. For ManyChat that means the External Request's URL, header and a JSON body of subscriber fields (name, phone, email, Instagram username, custom fields). **The ManyChat preset is verified against a real ManyChat Pro account before 2C ships**, not written from memory.
- **Health:** last event, events accepted and rejected, and why (bad signature, stale timestamp, unmapped payload) on the Sources page.

## 14. Risks and decisions to revisit

- **Required stage fields are not enforced on import** (§6.5). This is deliberate for migrations; revisit if teams misuse it for live intake (2B and 2C may enforce, per source).
- **Phone "empty" means status `missing`** (§6.9): a merge won't replace an existing unreadable number with a good one. The bulk fix handles those instead, so nothing the team typed is replaced automatically.
- **Excel `.xlsx` is refused**, not read. Revisit if owners find "Save as CSV" a barrier.
- **Keys are stored in the database encrypted**, not in a separate secrets service. That's consistent with the rest of LUME (report §15).
