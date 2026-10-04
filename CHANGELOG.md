# Changelog

Every LUME release, newest first. The version is the root `package.json`'s; tagging `vX.Y.Z` builds the
release images (`docs/runbooks/fleet.md`). Migrations are forward-only and additive: an update never drops a
column in the release that stops using it.

## Unreleased

- **Security (Phase 6A):** LUME watches for anyone taking more lead data than their work needs: contacts
  revealed, different leads opened, and send-queue runs, each with a limit and an action (tell admins, or tell
  them and pause access). A pause ends every session and stops the act that crossed the line. Admins review
  alerts in Settings → Security (Overview, Rules, Access limits), with a live HUD and a line in the daily email.
  Access limits per role (hours and networks) get their screen. Lead screens carry an on-screen watermark for
  people who can't see every contact. See `docs/runbooks/security.md`.
- **Before you update, check the rules.** They're on from the moment an installation updates: anyone who can't
  see every contact is paused after more than 30 different contacts, or 200 different leads, in an hour.
  Change the limits or switch a rule to "Tells you" in Settings → Security → Rules first if your team works
  faster than that. The new audit index is built during the update, with the app stopped, as every migration is.

- **Exports you can trace (Phase 6B):** Export on the Leads list makes a CSV or Excel file of the current view,
  marked with a code on every row and a hidden check row, kept 24 hours, every download audited. Settings →
  Security → Exports traces a file found outside the business back to its export.

- **Offboarding and Security activity (Phase 6C):** People → Offboard replaces Disable with a guided sheet:
  sign them out everywhere, hand on their leads (shared across a team by who has the fewest open leads, to one
  person, or unassigned), disconnect their Google Calendar (their lead meetings go with their leads), and see
  their last 30 days, then one act, recorded as one audit entry. An alert offers Offboard too. Settings →
  Security → Overview gains today's figures, contacts opened per person over 14 days, and who is signed in now
  (with Sign out), each figure opening the Audit log at its own day.

- **Faster at volume (Phase 7A):**
  - **What's fast now:** lists, filters, search, the stage strip and the saved views' counts stay quick with a
    million leads (figures in `docs/runbooks/performance.md`, measured on one CPU). Search is through its own
    table; the stage strip's counts are kept rather than counted.
  - **Counts that are still live:** counts with any other filter (a tag, a phone status) are counted live, and
    take longer on very large instances.
  - **Search terms:** one character, or symbols only, doesn't search; two match names that start with them; three
    or more look inside names and the contacts a person may see. A saved view whose search is one or two
    characters now follows these rules.
  - **Broad searches:** a search matching more than 10,000 leads lists the newest of them and says so; an export
    or a send queue over it asks for a narrower search.
- **Updates stop the app before migrating** (`scripts/update.sh`), so a migration that builds indexes never leaves
  the Leads screen or webhooks waiting on a lock.

- **Bulk actions at scale (Phase 7B, API):** a bulk action covers the leads picked, or everything a filter shows
  (minus the ones unticked), up to 50,000 at a time.
  - **How it runs:** up to 500 leads change at once; more run in the background in batches of 500, with
    progress, Stop, and one notice when it's done.
  - **Undo, for 24 hours:** each lead goes back only if nobody has changed it since. Automations a stage already
    ran stay done.
  - **What's recorded:** each lead's history is kept as for a single edit; the audit log keeps one entry per bulk
    action, and a new owner gets one notice for all their leads.
  - **The screens (7C):** selecting leads raises a floating bar with Move to, Assign, Tags and more; "Select all
    N that match" acts on a whole filter. A long run shows its progress, can be stopped or tucked into the top
    bar, and says when it's done, with what was skipped and why. Recent bulk actions (the clock icon on the
    Leads toolbar) lists the last 7 days, with Undo while it lasts.
- **Search says how it's searching (7C):** the search field shows "One more letter", "Names starting with",
  "Names, emails, numbers" or "Names only", and a broad search says it lists the newest 10,000.
- **Loading, said plainly (7C):** a bar under the top bar while anything loads; rows that are being refreshed
  dim, then give way to skeletons after a moment; "Taking longer than usual" after 3 seconds; offline, the Leads
  list tries again by itself every 5 seconds and says when.
- **Popups cover the whole window (7C):** every popup now dims and softly blurs everything behind it, sidebar and
  top bar included.
- **Profile photos (7C):** My account → You: pick a colour for your initials, or choose a photo and line it up
  (drag, zoom, turn, with a thirds grid and live previews). Everyone you work with sees it beside your name.
  The photo is cropped in the browser to 256 px and checked by LUME before it's kept; nothing else from the file
  (where it was taken, the camera) is kept.
- **Analytics groundwork (Phase 8A):** LUME now keeps when each lead was first contacted and first replied,
  logs phone calls ("Log a call": talked, no answer, left a message), and keeps daily analytics totals in the
  business's own days, refreshed every 10 minutes. The Analytics screens follow.

### Migrations

- **0053** adds the daily analytics rollups (`analytics_daily_cohort`, `_event`, `_stage`, `_slot`), read under each
  person's analytics reach, and `lume_rollup_day`, which recomputes one business day; plus indexes on wins,
  meetings, follow-ups' due times, stage changes and sent messages.
- **0052** adds `lead_sources.monthly_spend`, `goals` and `analytics_insight_seen`.
- **0051** adds `lead_firsts` (when each lead was first contacted and first replied), kept by a trigger on
  `activities` and backfilled from every activity already recorded.
- **0050** adds `users.avatar_color` and `users.avatar_version`, and `user_avatars` (each person's checked photo).
- **0049** adds `bulk_runs` (each bulk action: what it did, its selection in words, its counts and reasons) and
  `bulk_run_items` (each lead's place, result and before-values, for resuming and undo; cleared 30 days after a
  run ends).
- **0048** adds `lead_counts` (the stage strip's counts per pipeline, stage and owner) with `lead_count_deltas`
  (changes appended by triggers on `leads`, folded in every minute by `lume_lead_counts_rollup`) and the
  `lead_counts_now` view.
- **0047** adds `lead_search` (a search mirror the app can't read, kept by trigger) and `lume_lead_search`, and
  drops the three trigram indexes on `leads` that nothing reads any more.
- **0046** adds read indexes on `leads` (name sort, newest per owner, counting, the saved views' date filters) and on
  open follow-ups by due date.
- **0045** rewrites the `leads` and `lead_tags` row-level security policies to read their settings once per query
  (same rules).
- 0046–0048 build indexes and backfill `lead_search` and `lead_counts`: longer on a big instance, with the app
  stopped (above).
- **0044** lets an export record no check-row position (a file with neither Email nor Phone carries none).
- **0043** adds `lead_exports` (each export's code, check row, sealed file and downloads).
- **0042** adds the `suspended` status and `users.watch_from`, the `security_alerts` table, and a partial
  index on the audit log for the counted acts.

## 1.0.0 — 2026-10-01

The first release for clients.

- **Leads:** the pipeline, lists and board; custom fields, tags, owners; saved views; import from CSV and
  Google Sheets; webhooks (website forms, Zapier, Make).
- **Follow-ups:** tasks with reminders, automations on stage changes, the no-touch alert, working hours, the
  daily digest.
- **Messages:** WhatsApp templates and sending, and the send queue (50 a run, 150 a day by default).
- **People and access:** roles with scoped permissions, teams, two-step sign-in, recovery codes, sessions,
  the audit log.
- **Licensing:** each installation checks its licence with license.lumecrm.in (six numbers, never a lead),
  knows its state (active, grace, read-only, suspended), and enforces it in the API. Export all data works in
  every state.

### Migrations

- **0030 widens existing roles:** every role that can send messages (`messages.send`) is also granted
  `messages.send_queue` at the same scope, so Sales can run send queues. Remove it from a role in
  Settings → Roles if you don't want that.
- **0031** adds the licence's own state (`licence_state`, and `sessions.notice_dismissed`).
- **0032** adds `data.export`, granted to roles that change settings.
