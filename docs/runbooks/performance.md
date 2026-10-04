# Performance at volume (Phase 7)

LUME is built for a business taking up to 5,000 new leads a day and holding 1–2 million, with 50 people working
at once, on one server. Every list, filter, search and stage count must answer in under 300 ms at that size.

## How it stays fast

- **Row-level security reads its settings once per query** (0045). The rule hasn't changed. It used to be evaluated
  per row through a function Postgres couldn't inline.
  - A lead's tags (`lead_tags`) are seen exactly when the lead is. For an admin (scope `all`) that check is skipped,
    since every lead is visible. Before, Postgres read it as a scan of every lead on each tag filter.
- **"My leads" uses the owner index.** The list spells out the person's own scope as a plain condition, mirroring
  row-level security, which still enforces it.
- **Indexes** (0046), all on live leads only:
  - sort by name;
  - my newest;
  - covering indexes for the stage counts;
  - the arrival and lost dates;
  - open follow-ups by due date.
- **The tag filter reads `lead_tags` by its tag index.** uuid equality is leakproof, so row-level security doesn't
  stop the index. A rare tag answers in a few milliseconds, at any size.
- **Search has its own table** (`lead_search`, 0047).
  - Why: under row-level security, Postgres can't use a `LIKE`/`ILIKE` index, because those operators aren't
    leakproof.
  - How it works: `lume_lead_search` applies the same visibility rule and returns only ids, newest first. The page is
    still read from `leads` under row-level security.
  - What a term matches:
    - one character, or symbols only: no search;
    - two characters: names that start with them;
    - three or more: inside names, plus the contacts the person may see. A role that can't see contacts searches
      names only.
  - **The cap:** past 10,000 matches, the list shows the newest 10,000 and answers `searchCapped: true`; so do the
    counts.
    - An export or a send queue of a search that broad is refused: "That search matches more than 10,000 leads.
      Narrow it, then try again." (422 `SEARCH_TOO_BROAD`).
    - Saved views' counts name the capped views (`capped`).
- **The stage strip's counts are kept, not counted** (`lead_counts`, 0048).
  - Statement triggers append each change to `lead_count_deltas`; they never update a shared row. Fifty people
    adding leads at once don't queue behind each other.
  - The follow-up clock's minute tick folds the deltas into `lead_counts`. Counts read `lead_counts_now`, which is
    `lead_counts` plus the deltas not yet folded in. So counts are exact at every moment, not a minute late.
  - Counts filtered only by pipeline, owner or stage read them; any other filter counts live (see below).
- **Updates stop the app before migrating** (`scripts/update.sh`): a migration that builds an index on a million
  leads doesn't wait behind live traffic. A failed stop applies nothing and leaves the app as it was.

### What is still counted live

The stage strip counts live when a filter other than pipeline, owner or stage is set: a tag, the phone status, a
date. Those counts read every matching lead.

- At 1,000,000 leads, a tag on 10% of them counts in about 0.6 s.
- The phone status (every lead) counts in about 0.35 s.

The list itself stays fast; only the counts above it wait. Kept per-tag counts are a recorded follow-up.

## Measuring it

The scale test seeds made-up leads (generic names, `example.com`, +9715… numbers) and times each path through the
real API code. Their ids are time-ordered, as the app mints them (UUID v7), so "newest first" and the order rows sit on
disk agree as they do in a real install:

```bash
bash scripts/dev.sh test-db scale-up     # a disk-backed Postgres (1 CPU, 1 GB); never the test database's tmpfs
bash scripts/dev.sh run sh -c 'LUME_SCALE=200000 pnpm exec vitest run apps/api/test/scale'
bash scripts/dev.sh test-db scale-down   # when done: drops the container and its volume
```

- **Output:** it prints `SCALE|path|ms|rows` for each path, and **fails** if any list, filter, search or count path
  takes more than `LUME_SCALE_BUDGET` ms (150 by default). The gate runs at 200,000 leads. At 1,000,000, the broad
  live counts above go past it, so that run sets a high budget and is read by eye.
- **Query plans:** `LUME_SCALE_EXPLAIN=1` prints them for the paths that used to be slow.
- **Dev box limits:** the dev box is a client's live server, so the scale database is capped at 1 CPU and 1 GB.
  Seed in batches (the test does); one huge insert outgrows the memory cap.

## Measured (dev box, scale database: 1 CPU, 1 GB)

| Path | Before 7A, 200k | After 7A, 200k | After 7A, 1M |
|---|---|---|---|
| Lists (newest, updated, oldest, page 2) | 6–15 | 6–9 | 6–8 |
| Sort by name | 1,612 | 9 | 9 |
| Filter by tag | 1,474 | 11 | 5 |
| Filter by a rare tag (30 leads) | — | 6 | 4 |
| Filter by owner and stage | 4 | 2 | 21 |
| Search (name, phone, email, no match) | 1,562–1,779 | 3–19 | 2–34 |
| Search past the cap (newest 10,000) | — | 34 | 155 |
| Rep's search | 5,265 | 8 | 21 |
| Stage counts: admin, rep, team lead | 1,600–7,102 | 2–6 | 2–4 |
| Stage counts with a search | — | 13 | 42 |
| Saved views' counts (sidebar) | — | 6–8 | 9 |
| Stage counts with a tag filter (live) | — | 102 | 630 |
| Stage counts with the phone status (live) | — | 80 | 355 |
| Export, owner filter (4,000 leads at 200k, 20,000 at 1M) | 262 | 172 | 1,753 |
| Bulk, 100 leads (today's ceiling) | 215–458 | 235–448 | 247–544 |

ms, median of 5. An export builds its whole file in the request, so it grows with the file: 20,000 leads take under
2 s. Bulk actions on large selections are Phase 7B.

The target at 2,000,000 leads is checked once on a production-sized server when one exists.

## Bulk actions (Phase 7B)

Every bulk action is a run (`bulk_runs`, 0049). Each lead in it is an item (`bulk_run_items`) holding its before-values.

- **The selection:** up to 50,000 leads.
  - It is the leads picked (up to 5,000 ids), or everything the filters show minus the ones unticked.
  - It is read as the person and snapshotted, so leads changing mid-run don't change the run.
  - A capped search can't be a selection (`SEARCH_TOO_BROAD`).
- **How it runs:**
  - Up to 500 leads change in the request.
  - More are queued on pg-boss inside the API. They run in chunks of 500, each chunk one transaction as the person, with their access read afresh before each chunk.
- **What each action does:**
  - assign, tags, delete and phone country are set-based within a chunk.
  - Stage moves check everything a single move checks: required fields, lost reason, won/lost stamps, history, reopened, and the stage's automations. The lookups run once a chunk and the writes go together; only the automations run lead by lead.
- **Cancel** stops after the current chunk.
- **A crash** resumes from the last committed chunk: only pending items are taken.
- **Past the queue's retries** a run ends `failed`, with its done chunks kept.
- **Undo, for 24 hours:**
  - It is a run over the done items.
  - A lead goes back only if its version is still the one the run left; otherwise it's `CHANGED_SINCE` and keeps the newer change.
  - Automations a stage already ran stay done.
- **What's recorded:**
  - One `lead.bulk` audit entry per run, and no per-lead audit entries.
  - Each lead's history (assignment, stage, activities) as a single edit writes it.
  - One notice to each new owner, and one `bulk_done` to the maker of a queued run.
- **Retention:** items are cleared 30 days after a run ends; the run stays.

### Measured: 200,000 leads, 50,000 by filter (dev box, scale database: 1 CPU, 1 GB)

| Run (49,201 leads by filter) | Time | Per 1,000 |
| --- | ---: | ---: |
| Assign | 11.7 s | 0.24 s |
| Undo of that assign | 13.4 s | 0.27 s |
| Add a tag | 8.8 s | 0.18 s |
| Move stage (every single-move check, set-based) | 9.6 s | 0.19 s |
| Delete, cancelled after 10 chunks (5,000 done) | 1.2 s | — |
| Assign / stage / tag 100, inline | 58 / 41 / 30 ms | — |

Stage moves took 199.5 s for the same 50,000 when each lead went through the single-move path; doing the checks
once a chunk and writing the chunk together brought them in line with the other actions. The list, filter, search
and count paths in the same run stayed inside their 150 ms budget (the slowest, counts with a tag filter, 96 ms).

## Analytics (Phase 8A)

Dashboards read daily rollups kept in the business's own days (0053): today and yesterday every 10 minutes, the last
7 days nightly, days 8–90 weekly. A day's recompute takes about 0.85 s at a million leads on one CPU.

### Measured: 1,000,000 leads, rollups for 91 days (dev box, scale database: 1 CPU, 1 GB; 2026-10-04, last run)

| Request (median of 5) | 30 days | 90 days |
| --- | ---: | ---: |
| Overview (admin) | 70 ms | 96 ms |
| Overview (rep, own) | 189 ms | 264 ms |
| Funnel | 43 ms | 45 ms |
| Team | 19 ms | 27 ms |
| Sources | 14 ms | 26 ms |
| Lost | 24 ms | 20 ms |
| Timing (with slot totals, 0055) | 7 ms | 5 ms |

The first run had the admin overview at 1.2 s and lost at 1.2 s: working out who owned each lead at the moment it was
won or lost, per lead, for someone who sees everything anyway. Those viewers now skip that step. Timing at 90 days read a
row per person per hour (404 ms); 0055 keeps one per hour for viewers who see everyone (5 ms). Budget: 300 ms
(`LUME_SCALE_ANALYTICS_BUDGET`).

