# Performance at volume (Phase 7)

LUME is built for a business taking up to 5,000 new leads a day and holding 1–2 million, with 50 people working
at once, on one server. Every list, filter, search and count must answer in under 300 ms at that size.

## How it stays fast

- **Row-level security reads its settings once per query** (0045). The rule hasn't changed; it used to be
  evaluated per row through a function Postgres couldn't inline.
- **"My leads" uses the owner index.** The list spells out the person's own scope as a plain condition, mirroring
  row-level security, which still enforces it.
- **Indexes** (0046):
  - sort by name;
  - my newest;
  - covering indexes for counts.
- **Tags live on the lead** (`tag_ids`, 0047), kept equal to `lead_tags` by trigger. A direct write to them is
  refused.
- **Search has its own table** (`lead_search`, 0048).
  - Why: under row-level security, Postgres can't use a `LIKE`/`ILIKE` index (those operators aren't leakproof).
  - How it works: `lume_lead_search` applies the same visibility rule and returns only ids. The page is still read
    from `leads` under row-level security.
  - What a term matches:
    - one character: no search;
    - two characters: names that start with them;
    - three or more: inside names, and the contacts the person may see.
  - Past 10,000 matches, the list and counts answer `searchCapped: true`.
- **The stage strip's counts are kept, not counted** (`lead_counts`, 0049). They're kept per pipeline, stage and
  owner by statement triggers. Counts filtered only by pipeline, owner or stage read them; any other filter
  counts live.

## Measuring it

The scale test seeds made-up leads (generic names, `example.com`, +9715… numbers) and times each path through the
real API code:

```bash
bash scripts/dev.sh test-db scale-up     # a disk-backed Postgres (1 CPU, 1 GB); never the test database's tmpfs
bash scripts/dev.sh run sh -c 'LUME_SCALE=200000 pnpm exec vitest run apps/api/test/scale'
bash scripts/dev.sh test-db scale-down   # when done: drops the container and its volume
```

- **Output:** it prints `SCALE|path|ms|rows` for each path, and **fails** if any list, filter, search or count path
  takes more than `LUME_SCALE_BUDGET` ms (150 by default).
- **Query plans:** `LUME_SCALE_EXPLAIN=1` prints them for the paths that used to be slow.
- **Dev box limits:** the dev box is a client's live server, so the scale database is capped at 1 CPU and 1 GB.
  Seed in batches (the test does); one huge insert outgrows the memory cap.

## Measured (dev box, scale database: 1 CPU, 1 GB)

| Path | Before 7A, 200k | After 7A, 200k | After 7A, 1M |
|---|---|---|---|
| Lists (newest, updated, oldest, page 2) | 6–15 | 5–18 | 5–11 |
| Sort by name | 1,612 | 8 | 6 |
| Filter by tag | 1,474 | 7 | 6 |
| Filter by owner and stage | 4 | 9 | 22 |
| Search (name, phone, email, no match) | 1,562–1,779 | 3–17 | 3–38 |
| Rep's search | 5,265 | 10 | 20 |
| Stage counts, admin | 1,600 | 2 | 2 |
| Stage counts, rep | 5,089 | 3 | 2 |
| Stage counts, team lead | 7,102 | 2 | 2 |
| Export (25,000 cap, owner filter) | 262 | 239 | 571 |
| Bulk, 100 leads (today's ceiling) | 215–458 | 297–499 | 360–643 |

ms, median of 5. Bulk actions on large selections are Phase 7B.

The target at 2,000,000 leads is checked once on a production-sized server when one exists.

## Bulk actions

Bulk actions on large selections, with progress and undo, are Phase 7B
(`docs/superpowers/specs/2026-10-03-phase-7-scale-design.md`).
