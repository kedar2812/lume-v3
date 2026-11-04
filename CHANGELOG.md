# Changelog

Every LUME release, newest first. The version is the root `package.json`'s; tagging `vX.Y.Z` builds the
release images (`docs/runbooks/fleet.md`). Migrations are forward-only and additive: an update never drops a
column in the release that stops using it.

## Unreleased

- **LUME AI books the time the lead asks for** (real-model eval 2026-11-04, 12 new call cases): it was told only the first
  free time of each day, so every other free time read as taken and it offered 4 pm instead. Now it may say yes to any
  time inside your call hours that's free (it's told the speaker's meetings, and LUME checks again before sending),
  may name your call hours and the call's start and end ("from 5:00 to 5:30 pm"), and may say a lead's own bare hour
  back ("9 pm", for "tonight at 9"). It never repeats a lead's budget or offered price: the price guard still holds any
  amount that isn't in your price list. Calls booked wrong: 6 of 12 before, 0 after.

- **LUME makes the Google Meet link** (owner 2026-11-02): with "Google Meet link" switched on in Settings → LUME AI →
  Calls LUME AI may say yes to, a call LUME AI books also goes into a "LUME calls" calendar in the speaker's Google
  Calendar, with a new Meet link, and LUME AI's yes carries the link. Only people who switch it on are asked for
  Google's permission (calendar.app.created: LUME may change only the calendar it made, never the person's own);
  everyone else's calendar connection stays read-only. Without the permission, or when Google won't, the lead goes to
  a person and nothing is sent. The lead gets no Google invite; moving or cancelling the call in Google Calendar moves
  or cancels it in LUME. Each speaker allows it for their own calendar; until they do, their calls are booked in
  your own words. Reconnecting keeps the permission, LUME never makes a second "LUME calls" calendar, and the calendar
  sync removes any event whose booking didn't go through.

- **LUME AI says yes to a call, inside the times you give it** (Settings → LUME AI → Calls LUME AI may say yes to:
  days and from–to, how long a call is, the notice, how far ahead, and how the call happens). When a lead asks for one
  of those times and the speaker is free, LUME AI says yes and the call is booked as its reply goes: a meeting on the
  lead (Calendar, the lead's Meetings, its history), the booking stage, a bell for the lead's owner, and the lead Ready
  for a person. A time outside them, too soon, too far or taken: it offers free ones, and never books what it wasn't
  given; checked again under a lock as it books, so two leads never get the same slot. Book meetings is set to Ask me:
  it waits for your tap. No times given: as before, a person confirms every call. Migration 0101.
- **A meeting booked shows in the lead's history** ("LUME AI booked a call", or "Meeting booked" from Calendly), with
  when; it read "Updated".
- **The two-step code is ready to type** as the code screen appears (sign-in, setting up two-step): no click first; and
  after a wrong code, the boxes take the next try at once. Typing works on keyboards that don't name their keys
  (Android's) and with a code the phone fills in by itself.
- **A profile photo saves:** Chrome now puts a colour profile into every picture a page makes, and LUME refused them
  all. What a browser adds (a colour profile, where and with what it was taken) is taken out and the picture kept.
  Lining it up stays where you put it: letting go no longer throws it from the moves before you stopped.
- **A follow-up's WhatsApp on Today opens the lead's chat** when your WhatsApp chats run in LUME.
- **Templates in the chat's reply box:** your own templates, in the lead's words, one tap into the box, to send or
  change; inside WhatsApp's 24 hours that's free, with no LUME AI.

- **LUME AI hands the right things to a person, and closes the rest kindly** (eval 2026-11-02, now 98% on the right
  kind of answer, none risky): a lead who chose someone else or already bought gets one warm closing message and is
  marked lost with the reason (no longer do not contact); a question about their own health, treatment or investment
  goes to a person even when LUME AI would only decline it; a day or time the lead proposes for the goal step is the goal
  reached, for a person to confirm; and a reply that says a file is on its way with none attached goes to a person.

- **Delete my account,** for everyone but the business owner (My account, at the foot): who takes your leads, your
  password twice (and your code with two-step), and a plain word that it can't be undone. You're signed out; your name,
  email, password and photo are gone; what you did stays on the record as "Former member". An admin can delete
  someone's account from People the same way, with their own password. Deleted people never show in People again,
  can't be enabled, and their email can be invited again. Migration 0100.
- **Deleting a role is the top of the hierarchy:** the owner, or someone who manages roles and people, and the password
  every time. Its people move to another role, to a new one made there as its copy, are offboarded, or have their
  accounts deleted (never the owner's or your own); the button says exactly what it will do.
- **LUME AI's template drafts never carry a blank to fill** ("on [day] at [time]" would have reached the lead as written).
- **A WhatsApp chat opens on the newest message** and stays there as photos and voice notes load in above it, unless
  you've scrolled up to read.
- **One reply suggestion to apply:** only the newest reply's next step offers Apply; older ones keep their meaning.
- **LUME AI's replies read like a person on WhatsApp:** no "Hi Kedar," and no sign-off on every message once the chat is
  under way; its first message keeps both.
- **New working hours move LUME AI's waiting leads** to the new times, instead of leaving them on the old opening.

- **The morning email is off until a business switches it on** (Settings → Follow-ups): an optional module, never a
  surprise in someone's inbox. A business that switched it on keeps it; each person can still turn their own off.
- **Deleting a role nobody holds works:** the Roles screen's Delete always answered "Request is invalid" (it sends no
  body, which the server refused).
- **Leads that a Refresh brings in glow once they're on screen:** the five seconds started while the list was still
  loading, so on a slow line the rows arrived with the glow already over.
- **The database takes up to 100 connections** (was 50): LUME's pools need about 45 at rest and more while a container
  restarts, and at 50 sign-ins were refused ("too many clients"). Takes effect when the database restarts with the
  update.

- **A lead LUME AI stopped reads as stopped:** in red on the LUME AI page, with why in the list and the header
  ("Stopped · Said stop"), and a red card where the reply box would be: "LUME AI won't message them again", with the
  reason (a lead who said stop, or one marked do not contact).
- **The LUME AI ring beside the bell** is the bell's size, its mark readable (it was a 9px mark in a 20px ring).

- **Let LUME AI carry on, carries on:** pressed on a lead LUME AI handed over ("lets do a call tomorrow 5 pm"), it now
  answers them, where it read the same words again and came straight back as Ready, notice after notice. If it still
  can't, the lead stays with you once, said plainly ("LUME AI can't carry on from here"). A lead in the run's goal
  stage is Ready once for each move into it, so one sent back talks on instead of bouncing. Migration 0099.
- **LUME AI's follow-up reminders are kept:** a time LUME AI wrote with seconds or its zone
  ("2026-11-02T10:00:00+05:30") was thrown away, so no reminder it suggested on a reply was ever set; such a time is
  now that time, and LUME AI is told the format it should use.
- **The Ready and Needs you card on the LUME AI page:** the reply box has the card's whole width under the lead's words,
  with Let LUME AI carry on beside the words, where the box was squeezed into a corner beside the button and pushed the
  words past the card's edge.

- **WhatsApp, live:** a message a lead sends, and the ticks on one LUME sent, show in their open chat as they happen,
  in the lead's drawer and on the LUME AI page alike; nobody closes and reopens a chat to see a reply. Migration 0098
  says each message on the live stream as its lead and kind only, never its words.
- **A notice for each message in:** when one of your leads writes on WhatsApp, a notice slides into the bottom-right
  corner (the top on a phone) with their name, what they wrote and when; press it to open their chat. One per lead (a
  second message updates it), at most three, none for the chat already on screen, none with reply alerts off in
  Settings → My account. Swipe it away or let it go. Never a phone number, and it never counts as opening the lead.
- **LUME AI answers a lead who already wrote:** a lead added to a run with a message unanswered inside WhatsApp's 24
  hours gets a reply to it, not the opening template ("thanks for your interest" to someone who had just written).
  Past the 24 hours, the template as before.
- **The LUME AI page:** the two panes fill the window on a computer, so the page never scrolls along with them and each
  list or conversation scrolls on its own (a long conversation was cut off at the foot of the card); a lead ready for
  you, or needing you, has the reply box right there under their words; the leads list has a search (any
  part of a name, case and accents aside); New run chooses its leads in a sheet right there (search, No reply 3+ days,
  New today, All) and goes on to the start sheet, never a trip to Leads.
- **Let LUME AI handle this:** on a lead, in their chat and on each Who replied group that fits (never no, stop or wrong
  number). One press opens the start sheet for those leads with the business's own choices; a lead already in a run
  instead offers Let LUME AI carry on (ready or waiting on you), Hand back (taken over), or says LUME AI is on it.
- **The sidebar's scrollbar** is a slim rounded thumb with no track or arrows, shown only while the pointer is over the
  sidebar, as on a Mac (Windows drew its own grey bar).
- **WhatsApp chat in its own window:** a lead's WhatsApp opens over the whole of LUME (dimmed and blurred behind it),
  the messages scrolling between a header (name and number) and the reply box pinned at the foot, as WhatsApp lays a
  chat out. Full screen on a phone. The lead's WhatsApp tab keeps the latest message and Open chat.
- **Photos, videos and PDFs from a chat open in LUME's viewer:** a photo zooms (click, wheel, pinch), a video plays
  with LUME's controls, a PDF pages; every file has Download. The Media tab's viewer gains Download too.
- **Recommended by LUME AI:** outside WhatsApp's 24 hours, LUME AI picks the approved template that fits this lead
  best and says why in one line; Send, Other templates, or Dismiss (remembered for that lead in the session). Only
  ever a template the person could send; with LUME AI off, the template list as before. One LUME AI read, counted
  against the month.
- **Write with LUME AI (Templates):** say what a template is for and LUME AI writes two or three to choose from, in
  the business's voice, using only LUME's variables and the business's own prices; anything WhatsApp would turn down,
  any price not in the price list and any discount are left out. Use this opens it in the editor; it's saved and
  submitted for WhatsApp's approval as any template is. One read, counted against the month. Migration 0097 lets
  this read alone belong to no lead.
- **LUME AI keeps more of its answers:** an explanation a few characters over its limit is shortened at a word
  instead of the whole answer being dropped (a message to a lead never is), and LUME AI is told each limit. In the
  October eval this took unread answers from 24 in 165 to none.
- **Autopilot may say the business's own hours:** a reply that repeats the days and times the business wrote in
  Settings → LUME AI is no longer held for a person; a time neither the lead nor the business gave still is, now
  matched whole (a lead's "11 pm" never lets "1 pm" through).
- **Try again sends one copy:** retrying a WhatsApp message that didn't go sends it again and takes the failed one off
  the thread; a second tap, or the same message open in another tab, is refused instead of sending twice. Every
  check runs again (do not contact, the 24 hours, the limits).
- **Smaller fixes:** the sidebar scrolls instead of squeezing its rows in a short window; the WhatsApp tab's icon
  sits beside its word; Fix it opens WhatsApp's card on Integrations (an address that isn't a page now says so);
  onboarding's Calendar Connect goes to Google and comes back to onboarding (it went to the Calendar, which sent it
  straight back), and its Sheets card says it's set up on Integrations after onboarding; the LUME AI card says what it reads and that it messages leads only in a run someone starts;
  the notification centre closes on a press outside it, and its full screen dims and blurs the window behind; the
  bell shows how many are unread (9+ past nine); page titles in the top bar are larger; Analytics' Sources lists
  only sources with leads or wins in the range (a source whose only activity was a loss, meeting or task was listed
  at nothing, and a tag filter then disagreed).
- **Update notes:** migrations 0097, 0098, 0099 and 0100 (additive). No `.env` changes.

## 1.1.0 — 2026-10-29

- **Security updates:** Next.js 16.4.3 (the licence panel and the web app) and Zod 4.6.7, for published denial-of-service
  advisories. No data or permission changes from these.
- **Product keys (2026-10-15):** a client's LUME asks for its product key at the first step of setup and goes on
  once license.lumecrm.in approves it ("your LUME is online", with the new online chime). A key works on one
  server: another server is refused and the owner's bell says so. The owner changes the key in Settings → About.
  On license.lumecrm.in, New licence ends on Ready to send (Copy message, Send on WhatsApp); each client's
  Licence key card shows where the key is active, and offers Rotate (decommissions the old key), Release, and
  Hold to decommission key. `provision.sh` no longer needs a key in `.env`. Licence server: back up, then update
  (migration 0004); installations: migration 0065.

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
