# Overnight build — 27→29 September 2026

You approved this before bed: finish phase 2, then phase 3, deciding things myself and recording each decision for you to review. This page is that record. It is updated as work lands.

## At a glance

| Piece | State |
|---|---|
| **2B-1: Google Sheets, Refresh, and the arrival glow** | ✅ Built, reviewed and fixed. Green in CI and on the dev box, except the steps that need a real Google key. |
| **2A: CSV import** | ✅ Now **fully** accepted live, including the steps that were waiting. |
| **2B-2: Connect with Google** (behind its switch) | ✅ Built, reviewed and fixed. It stays invisible until you set up the relay (`docs/runbooks/connect-with-google.md`). |
| **2C: Webhooks** (Website form, Zapier, Make; ManyChat hidden until verified) | ✅ Built, reviewed and fixed (1 Critical and 7 Important findings). Accepted live through Caddy. |
| **Phase 3A: follow-ups and the engine** | ✅ Built, reviewed (2 Critical, 6 Important, all fixed) and accepted live, including a reminder surviving an API restart. |
| **Phase 3B: notification centre, escalation, morning email** | ✅ Built, reviewed (8 Important, all fixed) and accepted live through Mailpit. |
| **Phase 3C: stage automations, leads gone quiet, working hours, time choices, System health** | ✅ Built, reviewed (6 Important, all fixed) and accepted live on a fresh install (29 Sep). |

**Phase 3 is done.** The whole live chain (1C-1 → 1C-2 → 1C-3 → 2A → 2B-1 → 2C → 3C → 3A → 3B) passes on a reset stack, except 2B-1's two steps that need a real Google key.

## What you can try

**Settings → Integrations** is a new area:
- Google Sheets is one card, off by default.
- Switch it on and share a sheet with the email shown. **Add a sheet** takes it through the same Columns → Rules → Preview steps as a CSV import.
- Choose "every row already there" or "only rows from now on", and how often LUME looks.
- Each sheet has its own page: health, recent syncs in words, problem rows (retry, dismiss, download), Pause, Edit columns, and Remove. Leads stay when a sheet is removed.

**On Leads (and the Board)**, once a sheet is connected, **Refresh** (or the **R** key) plays the approved v5 moment:
- the button lifts into a glass pill, then opens into the card;
- the card shows the official Sheets mark → rows drifting → the LUME mark, with the blue bar filling with real progress;
- the real count arrives ("3 new leads", or "1 new lead for you" for a rep);
- it settles back into the button, which says "✓ 3 new".

New rows slide in and glow for 5 seconds. Whatever arrived since your last visit glows the same way when you open Leads. When more than 20 arrived, a line says "37 new since yesterday · Show only these". No sound. Reduce Motion gets a still card.

## What's new since 2B-1

**Webhooks** (Settings → Integrations → Webhooks, off by default):
- **Add a webhook** → Website form, Zapier or Make. LUME shows the address and a secret **once**, with a copy-paste code sample.
- Send one test post, and LUME lists the fields it sent.
- The usual Columns → Rules → Preview steps, then **Turn it on**.
- From then on, every signed post is a lead within a second, merging with any duplicate.
- Each webhook has its own page: posts in words, problem posts (Retry and Dismiss), what was refused and why ("last for a bad signature"), New secret, Pause, Edit fields, Remove.
- Forged, unsigned, stale, oversized or flooding posts are refused, counted, and never stored.

**Follow-ups** (Phase 3A):
- The lead drawer has **Follow-up** (or **F**): two taps set one ("Tomorrow 10:00", "Remind me 1 hour before"), with an optional repeat that stops by itself once the lead replies, is won or is lost.
- Under the actions: the **next follow-up** in words ("Tomorrow, 10:00"), with a tick for done and a menu to snooze or cancel it.
- **Today** is real now:
  - a greeting, whom to start with, and "n / N cleared today";
  - Overdue, Due soon and Later today, each row with Done and Snooze;
  - **All clear** (the mark, and the `cleared` sound once a day);
  - for admins, what needs them.
- Reminders fire on the minute, in each person's own timezone (DST included), exactly once. A sweeper catches anything a restart or crash missed.
- The **bell** gets a live dot when one arrives. It's silent, per the sound policy.

**The notification centre** (Phase 3B): the bell, or **.** anywhere.
- It groups Overdue, Due now, Later today and Updates, with filters (All, Needs you, Updates).
- Each row has its action: Done and Snooze on a follow-up, Open on a lead, Remind them on an escalation, Open System health on an alert.
- Keys: J/K move, E done, S snooze, Enter opens the lead (and steps the centre aside), F full screen, Esc back.
- The window title says "(3) LUME" while three are unread.

**Escalation and the morning email** (Settings → Follow-ups, and My account → Notifications):
- A follow-up left overdue past N hours (24 by default) reaches the people who manage its assignee, once.
- Each person gets a morning email of their day ahead, at the time they choose, on their working days. It carries first names and times only; phone numbers and emails are taken out of titles. It can be switched off for everyone.

**Stages that act** (Settings → Pipeline & stages → **Does** on a stage):
- Up to five automations per stage, each written as a sentence while you shape it: set a follow-up for the lead's owner (or someone) in N hours or days; clear open follow-ups; tell someone.
- They run when a lead moves there, is added there, or arrives there from a webhook or a sheet. CSV imports don't run them.
- A new install's Won and Lost clear open follow-ups. Your existing install doesn't change until you set it.
- The lead's history says what LUME did, or why it couldn't.

**Settings → Follow-ups** also has:
- **Leads gone quiet** (off by default): a lead nobody has touched for N days comes back to its owner as a follow-up.
- **Working hours**: follow-ups LUME sets itself wait for the next working hour. The hours live in **Settings → Business → Working hours**.
- **Time choices**: the chips in the follow-up sheet. Rename, reorder, remove, and set when each lands ("in 30 minutes", "tomorrow at 10:00", "next Monday at 10:00").

**Settings → System health**: one look says whether every reminder, email and sync is running. When something isn't, admins hear about it once a business day, in the app and by email.

## What I need from you

1. **A Google service account**, to try Sheets for real:
   - Google Cloud → a project → enable the **Google Sheets API** and **Google Drive API** → create a service account → add a JSON key.
   - Put the file on the dev box at `/root/lume-dev/secrets/google-sa.json` (mode 600).
   - Share a test sheet with the service account's email, as a Viewer.

   With that, the live steps finish: `docs/runbooks/acceptance.md` → Phase 2B-1.
2. **Connect with Google** (optional): the Google Cloud and relay steps in `docs/runbooks/connect-with-google.md`.
3. **Official marks for Zapier, Make and ManyChat**, as unmodified files in `apps/web/public/brand/`. I didn't download them while you were away. Until then the presets show their names on a neutral tile (`public/brand/README.md` lists them).
4. **To verify ManyChat**: a ManyChat Pro account. The preset is built, and hidden behind `LUME_MANYCHAT_PRESET=on`.
5. **The dev DB was reset again on 29 Sep** for the live chain, as you OK'd. It now holds the acceptance workspace (fictional Brightpath Studio). To set up your own: `scripts/dev.sh reset-db`, then the setup token is in `scripts/dev.sh logs api`.

## Decisions I made for you (2B-1)

These are all in the spec's §14 amendments, or in the plan ledger:

- **A1. Setting up a sheet reuses the CSV import's draft** (Columns, Rules, Preview). Connecting a sheet therefore needs both Manage integrations and Import leads.
- **A2. A sheet runs as the person who last saved it.** If they lose access, the sheet pauses with a clear message until an admin saves it again.
- **A3. "Only rows from now on"** records what's already there on the first sync, recognised by content (not position), and creates nothing.
- **A4.** LUME notices rows moved or inserted anywhere (the header, the first row and the last row read), and re-reads the whole sheet at least hourly while it keeps changing.
- **A6. A row is recognised** by its date cell (time included) plus its phone, email and Instagram. Editing a name doesn't make it a new enquiry. Without a date column, a repeat enquiry from the same person can't be told apart, and the Columns step says so.
- **A8.** The "last seen Leads" marker uses the server's clock.
- **A9.** Pressing Refresh twice within 3 s is one refresh. Presses join syncs already running. A sync from the last 10 s is reused.
- **A10.** The Board gets Refresh; the glow is table-only.
- **A12. Remove archives the sheet;** its leads keep saying where they came from.
- **A13.** Integrations use the existing **Manage integrations** permission (not Settings).
- **After the review:**
  - A row typed into the sheet over two syncs (a name first, the phone a minute later) **fills in the same lead** ("Filled in from the sheet") instead of making a second one.
  - This happens only when it's clearly the same row: the row made its lead within the last 30 minutes, and its old version is gone from the whole sheet.
- **Webhooks-era rulings** (for 2C, not built yet): rate limits are kept in memory (one API per instance), and a paused webhook answers 503 so senders retry later.

## Found and fixed tonight

**End to end:**
- A brand-new form sheet with only its header couldn't be connected.
- Settings → Integrations kept saying "Checking now".
- The sheet list ran queries in parallel on one connection.

**The fresh reviewer's findings** (all fixed, each with a failing test first):
- **Critical:** editing which columns recognise a row would have re-imported the whole sheet (thousands of "Enquired again" entries).
- A lead typed into a gap in the middle of a sheet could be missed for ever.
- A paused, removed or restarted sync held its lock for 15 minutes.
- Pause and Remove didn't stop a sync already running.
- Google's rate limits looked like "LUME lost access".
- A row typed over two syncs made two leads.
- Changing how the date column looks made every row look new.
- The problem-rows download ignored contact masking.
- Editing columns reset the check interval to 2 minutes.

**Also:**
- CI's screenshot tests had been failing since Task 12: the sheets tests left leads behind that later screenshots saw. The sheets tests now clean up after themselves.
- Two old 2A acceptance checks were wrong, and are fixed.

## Deferred (small; your call)

- The "needs attention" link on the Refresh result card can't be reached by keyboard and is gone in 1.3 s. It belongs in the announcement or the banner.
- Every Refresh failure is titled "Couldn't reach Google", even when you're offline or Sheets is off. "Try again in 2 minutes" is fixed text.
- A failed action on a sheet's page replaces the page with one error line; a failed Remove says nothing.
- After a few failed syncs, the sheet's page blames Google even when the failure was LUME's.
- The row limit's final check also counts blank rows.
- A sheet's draft could be started as a one-off CSV import through the API (not the UI).
- A problem row dismissed at the very moment its retry fails can come back.
- A renamed tab keeps its old name on the sheet's page.
- One sync runs at a time across all sheets.
- Two multi-sheet Refreshes could, rarely, deadlock (sheets aren't locked in a fixed order).
- Reads are 5,000 rows at a time, where the spec said 1,000 (harmless).

## Decisions I made for you (2B-2, 2C, 3A)

All are in the plan ledgers (`.superpowers/sdd/*/progress.md`, `Ruling:` lines) with what each costs if wrong. The ones you'd notice:

- **2B-2: Connect again.** A sheet whose Google access was removed shows **Connect again**, and it accepts only the same file.
- **2C: receiving.**
  - A stranger can't tell an unknown address from a wrong secret, or from a paused webhook. All three take the same work.
  - Rate limits: 60 a minute per webhook and 600 for the instance, spent only by posts that proved themselves. Flooding junk is turned away before any database work.
- **2C: queueing.**
  - A post that can't be processed yet (the person it runs as lost access, or the queue dropped it) is queued again every minute.
  - After a day it becomes a problem post you can retry.
- **2C: setup.** Editing a webhook whose posts are older than their 30-day retention still works: its saved fields are the columns.
- **3A: who sees what.**
  - A follow-up is seen exactly when its lead is.
  - Giving one to someone who can't see the lead is refused.
  - Giving follow-ups to others follows **Manage others' follow-ups**: team reaches your teams, all reaches everyone.
- **3A: repeats and times.**
  - Repeats stop on won, lost, or a logged reply.
  - "Nag" repeats (firing again while still open) aren't in v1.
  - More than five reminders on one follow-up is refused, not cut.
  - With no timezone set, the web shows times in the browser's zone.
- **3A: Today.** Opening Today reads your notifications (the bell's dot goes), until 3B's notification centre gives them a place of their own.

## Found and fixed since

- **CI had been red since 2C Task 2, and I didn't notice overnight.** The cause was one Integrations screenshot whose mask matched only some rows, so the result depended on the machine's speed. It now masks every row.
- A tamper test that, about one run in 64, didn't tamper.
- Closing a webhook's setup deleted the webhook itself. The 2A discard removes a draft's source, which for a webhook is the webhook.
- **The 2C reviewer's findings**, all fixed with a failing test first:
  - **Critical:** the nightly draft purge deleted a live webhook, and every post, a week after an abandoned edit.
  - The rate limiter could be grown without limit by random addresses, and junk used up real senders' share.
  - A rotated secret was kept in plain text for idempotent replay.
  - A wrong secret took measurably longer than an unknown address.
  - Posts could stay queued for ever.
  - A quiet webhook couldn't be edited, and its edit sheet showed the new-webhook picker.
  - The "new fields seen" list could grow without end.

## Deferred (small; your call)

**2B-2:**
- The relay:
  - it never sweeps cancelled Pickers;
  - a cancelled Picker is a dead end;
  - `open()` shadows `window.open`;
  - `https` isn't enforced for the relay URL;
  - two security headers are missing.
- A removed Google-connected sheet keeps its sealed grant.
- The runbook should note Google's 100-refresh-token limit and the homepage and privacy URLs that verification needs.

**2C:**
- The event id isn't covered by the signature: a captured post could be replayed within 5 minutes under fresh ids.
- "Stale timestamp" is counted as "bad signature".
- The Website preset doesn't map `message` to notes.
- Repeated form keys keep only the last value.
- The test step doesn't stop polling after 10 minutes.
- On a webhook's page:
  - Pause is hidden while it needs attention;
  - Retry and Dismiss aren't disabled while busy;
  - Rotate and Remove failures show nothing in their dialogs.
- A backdrop click closes the secret step before the secret is copied (it's recoverable with New secret).
- There's no audit entry for creating a webhook or retrying a post.

## Decisions I made for you (3B, 3C)

All are in the plan ledgers (`.superpowers/sdd/2026-09-28-phase-3b-*/progress.md` and `…-phase-3c-*/progress.md`, `Ruling:` lines). The ones you'd notice:

- **3B: the morning email.**
  - It keeps a follow-up's title but takes phone numbers and emails out of it.
  - It can be switched off for everyone (Settings → Follow-ups → Morning emails). With no mail server it isn't attempted.
  - The day is claimed before sending: nothing is ever sent twice, but a crash between claim and send loses that day's email.
- **3B: escalation.** Switching it on starts from now, so long-overdue follow-ups don't flood managers. "Remind them" can't be muted by the person reminded.
- **3C: stage rules.**
  - They run inside the move, as its mover. The admin who set the rule decides who gets the follow-up, whatever the mover's own role allows.
  - When the named person can't take a follow-up, it goes to the lead's owner. With no owner, nothing, and the history says why.
  - Webhooks and a sheet's later syncs run them; CSV imports and a sheet's first sync don't.
  - Notices are gathered per request ("LUME set you 20 follow-ups").
- **3C: the rest.**
  - Working hours are the business's, not each person's.
  - "Leads gone quiet" is off by default (7 days when on). Finishing a follow-up or opening WhatsApp counts as contact.
  - System health's "morning emails aren't going out" needs more than one person failing, or nothing sent in a day.

## Found and fixed (Phase 3)

- **3A review:** a moved follow-up fired at its old time; backups held no follow-ups or notifications; the live stream lost or stopped notifications in five ways; Today said All clear too early.
- **3B review:**
  - two digest runs could both send;
  - a done follow-up's reminder stayed unread;
  - the centre covered the lead it opened and took the drawer's keys;
  - J/K could act on the wrong row;
  - titles could carry contacts into the email;
  - one bad account stopped everyone's digest;
  - there was no switch to turn the digest off.
- **3C review:**
  - a failing rule could fail the move (each rule now has its own savepoint);
  - a bulk move sent a notice per lead;
  - webhook leads never told the person the webhook runs as;
  - two API processes could both alert admins;
  - "leads gone quiet" ignored finished follow-ups and WhatsApp;
  - a rule naming someone no longer active trapped the admin.
- **Along the way:**
  - CI timeouts from tests that seeded hundreds of rows one at a time;
  - formatting that only existed on the build box;
  - a link that failed contrast;
  - two Settings pages whose panels sat outside their column;
  - the build box's toolbox image, pruned overnight and rebuilt.

## Deferred (small; your call)

**3B:**
- The digest has no per-item links, and new assignments are a count only.
- New arrivals in the centre have no highlight fade.
- A digest time in the last quarter hour of a day can be skipped.
- A delayed digest still says "Good morning".

**3C:**
- Reminders for follow-ups a webhook or sheet made wait for the sweeper (up to about 90 s).
- "Reminders late — restart the API" can fire right after a long outage's restart.
- Switching "leads gone quiet" on works through an old backlog at 500 an hour.
- History lines give a follow-up's time in the browser's zone rather than yours (this predates 3C).

