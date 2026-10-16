# Fleet: every client's LUME at a glance, and announcements to them (design)

Project B, part 2 of 5 (feedback → **fleet** → control each client → get paid → win clients). Canvas:
https://claude.ai/artifact/32HRBdpQw1i356NZzGeHhu (page "2 · Fleet"). Written under the
owner's full authority (2026-10-16): decided and recorded here; the owner reviews at the end.

## 0. What it's for

The owner runs many LUME installs, each on a client's own server. Today the dashboard knows only that an install
checked in, its version, how many people use it and how many leads it holds. It can't tell a LUME whose reminders
stopped, whose background jobs fail, whose disk is filling or whose backups can't be restored, and it can't tell
clients anything (a new release, planned maintenance) except one by one on WhatsApp.

Success: the owner opens **Fleet** and sees, worst first, which LUMEs need a look and why, in plain words, before
the client notices; and can write one announcement that reaches every chosen LUME within 6 hours, and see how far
it got.

Rules that bind every part of this: nothing about a lead or a contact leaves a client's server (counts, times and
fixed problem keys only); an install on an older LUME keeps working exactly as today; the dashboard's existing
look (Porcelain/Obsidian, one accent blue, its cards, `.seg` controls and full-window scrims); LUME's voice.

## 1. What LUME sends (the client's side)

### 1.1 Health with each check-in
`checkBody` gains two optional fields, sent by LUME from this release on:

- `accepts: ["announcements"]` — what this LUME can show. The licence server includes a claim in its signed answer
  only when the install lists it (§1.3).
- `health`:
  - `uptimeS` — seconds since LUME's API started.
  - `dbBytes` — `pg_database_size(current_database())`.
  - `diskFreePct` — free space on the server's disk as LUME sees it (`fs.statfs("/")`), 0–100, or null if unreadable.
  - `errors24h` — responses LUME's API answered with a 5xx in the last 24 hours (counted in memory, so since the
    last start if that was sooner).
  - `queue` — `{ waiting, retrying, failed24h }` from the background jobs (readHealth's numbers).
  - `remindersLate` — follow-up reminders late (readHealth).
  - `restoreTest` — `{ at, ok }` of the last backup restore test, or null.
  - `problems` — readHealth's problem keys, from a fixed list only: `reminders_late`, `sweeper_stopped`,
    `jobs_unreadable`, `jobs_failed`, `digest_failing`, `source`, `restore_test`. A source problem travels as
    `source` (never the source's name: a client's sheet name is theirs). Each key at most once.
  - `sourcesNeedingAttention` — how many.

All numbers are capped and integer; unknown keys are dropped on LUME's side and refused on the licence server's.
Reading health never blocks a check-in: if it fails, the check-in goes without `health`.

### 1.2 Seen counts
`seen: [{ id, people }]` — for each announcement LUME is showing, how many people have pressed **Got it**. Numbers
only, never who.

### 1.3 Compatibility
- The licence server is deployed first; it accepts the new optional fields and still accepts today's body.
- An install that doesn't send `accepts` gets exactly today's signed answer (an older LUME rejects any payload with
  a field it doesn't know, so new claims go only to installs that list them).
- The new LUME accepts both today's payload and one with `announcements`.

## 2. The licence server

### 2.1 Storage — migration `0006_fleet.sql`
- `check_ins.health jsonb` (null for older installs). Kept with the check-in (pruned at 180 days as today).
- `check_ins.accepts text[]`.
- `announcements`: `id uuid`, `title` (1–80), `body` (1–600, plain text), `kind` (`update` | `maintenance`),
  `window_start`, `window_end` (maintenance only, both or neither), `audience` (`everyone` | `admins`), `all_clients
  boolean`, `starts_at`, `ends_at` (after starts_at, at most 60 days later), `created_at`, `withdrawn_at`.
- `announcement_clients (announcement_id, client_id)` when not all clients.
- `announcement_seen (announcement_id, client_id, people, at)` — the latest count each install reported.

### 2.2 What's healthy
Worked out on the licence server from the newest check-in, for live clients (not suspended, not decommissioned):

- **Down** — no check-in for over 24 hours (as the bell says today).
- **Needs a look** — any problem key; disk free under 15%; `queue.failed24h` > 0; `errors24h` ≥ 20; restore test
  failed or older than 8 days.
- **Healthy** — checked in within 24 hours with none of the above.
- **No health yet** — checked in, but on a LUME that doesn't send health. Shown as such, never as healthy.

The words for each problem live in the dashboard (`lib/fleet.ts`), one line each, saying what to do: "Follow-up
reminders are late: the engine may have stopped. Restart LUME's API on their server." Disk under 5% is the one red.

### 2.3 Announcements in the answer
`/v1/check`, when `accepts` includes `announcements`: the signed payload gains `announcements` — the ones live now
for this client (started, not ended, not withdrawn, audience includes it), newest first, at most 3:
`{ id, title, body, kind, audience, windowStart, windowEnd, endsAt }`. Records `seen` counts. A withdrawn or ended one
is simply absent from the next answer.

### 2.4 Admin API (session + CSRF, as the rest)
- `GET /api/fleet` — every live client: status, problems, last heard, version, people, leads, uptime, DB size, disk
  free, errors, queue, restore test, and whether it accepts announcements; plus counts per status.
- `GET /api/clients/:id` gains `health` (latest) and `healthTrend` (DB size and disk free, one point a day, 14 days).
- `GET /api/announcements`, `POST /api/announcements`, `POST /api/announcements/:id/withdraw`. Each answer carries
  reach: `{ audience: n, reached: n, cannot: n, seenBy: people }` — reached = installs in the audience that checked
  in on a LUME that accepts announcements after it started; cannot = installs in the audience on an older LUME.
- The bell gains **Needs a look** (amber, one per client, its problems in words) and **Disk almost full** (red, under
  5%), dismissible like the rest, with fingerprints so a new problem shows again.
- Each publish and withdraw writes an `events` row on every client in its audience ("Announcement: <title>").

## 3. The dashboard

### 3.1 Navigation
**Fleet** in the sidebar after Clients. Two tabs in the page's `.seg`: **Health** and **Announcements**.

### 3.2 Health
- Four tiles: **Online** (n of m), **Need a look**, **Down**, **Behind** (not on the latest version).
- A table, worst first: status dot and word; client; last heard ("2 h ago"); version (amber "update" pill when
  behind, as on Clients); people; leads; DB size; disk free (amber under 15%, red under 5%); and the problems as
  short chips ("Reminders late", "Jobs failing", "Restore test"). A row opens the client.
- Filter by status (All / Need a look / Down / No health yet), search by client.
- Empty state (no clients yet) and a loading bar with skeleton rows, as every data screen.

### 3.3 The client's page
A **Health** card beside This installation: status and the problems in words; uptime; DB size and disk free, each
with a 14-day line (the panel's own bar-trend style); background jobs; errors; restore test. On an older LUME:
"Health arrives once this LUME is updated."

### 3.4 Announcements
- The list: Live, Scheduled, Ended — title, kind, who it's for ("Everyone at all clients", "Admins at 3 clients"),
  when, and its reach as a thin bar ("Reached 9 of 14 · 2 on an older LUME · seen by 23 people").
- **New announcement**, a full-window sheet:
  - Kind: **Update** · **Maintenance** (the latter asks for the window, start and end, in the owner's time).
  - Title, message (plain text, a live count from 500).
  - Who sees it in LUME: **Everyone** · **Admins only**.
  - Which clients: **All clients** · **Choose…** (a searchable checklist).
  - Shows from (now, or a date and time) until (default 14 days later).
  - A live preview of the strip as it will look in LUME, in Porcelain and Obsidian.
  - The plain line: "Reaches each LUME at its next check-in, within 6 hours. LUMEs on an older version won't show it."
  - **Publish**. Withdrawing asks first and says it leaves each LUME within 6 hours.
- One announcement opens to its details: the text, the audience, reach per client (reached / waiting / older LUME),
  and seen counts.

## 4. In a client's LUME
- A strip under the top bar, the same family as the licence banner, labelled **From LUME's team**: the title, the
  message (two lines, then **More**), for maintenance the window in the business's timezone ("Sat 18 Oct, 10:00 –
  10:30 pm"), and **Got it**. One at a time, newest first; Got it shows the next.
- Shown to everyone or to admins, as the announcement says; dismissed per person (stored on the person, so another
  device doesn't show it again); gone when it ends or is withdrawn. No sound (not an achievement).
- On a phone the strip sits above the content, full width, the message clamped to three lines.
- Settings → About lists the live announcements, so a dismissed one can be read again.

## 5. Errors, security, testing
- Every new field is validated on both sides with strict schemas; limits: 3 announcements per answer, title 80,
  body 600, problem keys from the fixed list.
- Announcement text is plain text everywhere (rendered as text, never HTML), on the dashboard and in LUME.
- Health never names a lead, a person or a source. A test proves the check body holds only the listed keys.
- Tests first: the body builder and its caps (core); the server's health status rules and the bell's new alerts;
  the answer including announcements only for installs that accept them (and staying byte-for-byte compatible
  for those that don't); reach counting; withdraw; LUME's keeper sending health and seen counts; the strip (one at a
  time, Got it per person, admins-only, the maintenance window in the business timezone); e2e for the Fleet screen,
  a client's Health card and publishing an announcement that a fake licence server delivers to LUME's strip.

## 6. Out of scope
Pushing announcements faster than the 6-hour check-in; replies from clients (feedback covers that); remote actions
on a client's server (restart, update) — the dashboard says what to do, the owner does it.
