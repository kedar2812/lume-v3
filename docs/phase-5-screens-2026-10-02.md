# Phase 5 screens (5D), 1–2 Oct 2026: the Calendar, everywhere a meeting shows

Built from the plan `docs/superpowers/plans/2026-10-01-phase-5d-screens.md`, the Phase 5 spec and the owner's approved canvas (Main, Connect, Calendar empty, Lead drawer, Log outcome, Today, Pipeline, Rules, Calendly, Phone, System). Thirteen tasks, each test watched failing before it passed, then one fresh review of the whole phase. **The privacy wording changed after the review** (see below): the canvas said personal events "never leave Google"; the sync does read them to find meetings with leads, so the screens now say they are read only for that and never kept, matching lumecrm.in/privacy.

## What a person gets

- **Calendar** (sidebar): an agenda of the next days that have meetings and a week of 8 am – 8 pm, on the business's clock; Everyone/Mine and a stage filter; a rail with the month, how the week went, and the meetings still waiting for their outcome; a drawer per meeting. The address bar keeps the view, the day and the open meeting. On a phone: the next call as a hero card, Today and Tomorrow, and a bottom sheet.
- **Connecting Google Calendar** right on the Calendar page (or Settings → Calendar), through Connect with Google; an honest explanation for anyone who can't.
- **Refresh** says what changed ("1 new meeting · 1 moved"), waits on a sync already running, and turns into "Connect again" when Google withdrew access.
- **The gear** opens Settings → Calendar (calendars, disconnect) and Calendar rules (what counts as a meeting with a lead, with a sample week); "‹ Calendar" and browser Back return to the same view and day.
- **Calendly** settings (new leads, reschedule follow-up, phone question) and its booking stage in Settings → Pipeline.
- **Settings → Pipeline** simplified: stages beside the chosen stage's settings and what LUME does when a lead enters it, including "Remind the lead before their call".
- **Today's calls** and a booking notice with Calendly's mark.
- **Log outcome** (Held, No-show, Rescheduled, a note; move the lead on, a Rebook follow-up, a next step) from the Calendar, its rail, the meeting drawer, Today and the lead's drawer — once, and race-safe.
- **The lead's drawer**: the next meeting and a Meetings tab.

## Every decision made for the owner

Each with what it costs if it was wrong.

- **Global:** spec is the Phase 5 spec plus the owner's 2026-10-01 critique (memory lume-meeting-colour); the canvas v13 is the design authority — cost if wrong: screens redone to a changed canvas
- **Task 1:** --meet becomes the sky tone (#3d93f0 / #6db8ff), not the accent — tags can be coloured "meet", and a copy of the accent would erase that tag colour; meeting rules use --meet-grad (sky → blue) — cost if wrong: one token value
- **Task 1:** the switch-rule test covers switches and toggles only; picked menu items, segments and cards are selections, which are blue by the System board — cost if wrong: none
- **Task 1:** meeting words in messages read "October 1, Thursday", superseding 5C Task 7 by the owner's 2026-10-01 rule — cost if wrong: one format line
- **Task 2:** last_sync also counts `changed` (a rename or other edit, same time), beyond the brief's added/moved/cancelled — the spec says a renamed event updates its meeting and the plan's Refresh says "2 updated", which must count renames — cost if wrong: one unused field
- **Task 2:** the two red tests were test faults, as the pause note said — times captured once (at() follows the moving clock); sync_requested_at written as Rafa via asPerson (RLS matched no row for the owner pool) — cost if wrong: none, code unchanged
- **Task 3:** web IntegrationsView gains googleCalendar/calendly and web Pipeline gains bookingStageId (the server already sends them); test fixtures follow the real shape — cost if wrong: none
- **Task 4:** a meeting outside 8 am–8 pm is pinned to the week grid's edge with its real time on it (dashed), never hidden — the brief's grid is 8–20 and Review Focus 1 needs an 11:30 pm meeting on its day — cost if wrong: a CSS tweak
- **Task 4:** the address leaves today's date out (`?view=week&m=b`), so a link opens on today tomorrow too; any other day is written (`d=`) — cost if wrong: one line
- **Task 4:** the drawer's "reminder" line is left out: LUME has no per-meeting reminder to name honestly (only the stage rule), and the owner's rule is no over-promising — cost if wrong: one line later
- **Task 4:** the agenda reads ~2 months around the chosen day (38 days back, 60 on; API cap 100) and reads again when the day leaves it — cost if wrong: a range constant
- **Task 5:** not connected but with meetings already (Calendly's), the card does not cover them: one connect row sits above the agenda; the card over the ghost only when there's nothing to show — cost if wrong: a condition
- **Task 5:** safeNext allows plain paths only, so the hand-back returns to /calendar or /settings/calendar (no query) — cost if wrong: the view resets to agenda/today after connecting
- **Task 6:** the result says "1 new meeting · 1 moved · 2 updated" without the moved-to time (the sync stores counts, not which meeting moved where) — cost if wrong: a field on last_sync
- **Task 6:** refresh.module.css moved to components/ui (both Refresh buttons use it, via the extracted RefreshMorph) — cost if wrong: none
- **Task 7:** the gear's return URL is kept in the tab's sessionStorage, not history state (Next's router owns history state); browser Back works as the gear pushes a navigation — cost if wrong: a storage key
- **Task 7:** Calendar rules' sample week is fictional; when rule 3 has any calendar chosen, the sample's "Sales team" calendar stands for it — cost if wrong: preview wording
- **Task 7:** onboarding's Connect card goes to /calendar (connect right there, canvas) rather than /settings/integrations/calendar, which never existed — cost if wrong: one href
- **Task 8:** the phone question is a text field for the question's exact wording, not a menu: the API lists no Calendly event-type questions — cost if wrong: a Calendly read + a menu
- **Task 8:** Integrations also gets the Google Calendar module switch (canvas Calendly board): without it no admin could switch Calendar on — cost if wrong: none
- **Task 9:** kept the stage rows (rename, reorder, archive) with colour, kind, needs and hours moved to the chosen stage's pane — cost if wrong: a layout pass
- **Task 9:** "Send a WhatsApp message" is not in Add an automation: LUME can't send on its own; the reminder is the owner's WhatsApp follow-up, and says so — cost if wrong: a menu item
- **Task 10:** /today's meetings gain matchedBy and reminder {at, sent} (the board shows the source and the reminder) — cost if wrong: two fields
- **Task 11:** Today's "Log outcome" opens the dialog right on Today (it was a link to the Calendar), as the brief's "wire Today/Calendar/rail" says — cost if wrong: none
- **Task 11:** a no-show's Rebook follow-up uses the first follow-up preset, a next step the preset chosen; titles "Rebook <title>" / "Next step after <title>" — cost if wrong: two strings
- **Task 11:** the drawer's meetings drop a late answer for the lead before J/K (as its activity feed does) — found while wiring, test added — cost if wrong: none
- **Task 12:** no phone tab bar: the shell has none (the brief: "where the shell already has one"); the shell's own top bar stays — cost if wrong: a shell feature for every page
- **Task 12:** the sheet has Join / Log how it went, Open lead and Copy link, not WhatsApp: a meeting carries no phone, and LUME's WhatsApp goes through the lead (masking, audit, templates); Open lead is one tap from it — cost if wrong: a tile
- **Task 12:** the hero's Join shows only when the call is soon (as the desktop drawer); otherwise "See the meeting" opens the sheet — cost if wrong: a condition
- **Task 12:** on a phone the list starts today (up to three days that have meetings, Today/Tomorrow by name) and keeps the desktop's whose-meetings default; the stage filter, Week and the chosen day are desktop only — cost if wrong: a filter row on the phone
- **Task 13:** e2e does not run the relay: with GOOGLE_OAUTH_RELAY_URL set, Sheets offers Connect with Google and every Sheets e2e flow and picture would change; the relay's connect is covered end to end by the API's connect.test (the real relay code against the Google fake) and ConnectCalendar's component tests — cost if wrong: an e2e relay + Sheets e2e rework
- **Task 13:** e2e writes meetings straight into the database (seedMeetings); Refresh's counts, the Calendly booking notice and the booking-stage sentence (needs Calendly connected) stay with their component and API tests — cost if wrong: an e2e Calendly fake
- **Task 13:** the pictures are of a fixed week (Mon Sep 14 2026); Log outcome's real save uses a call that ended 90 min ago (skipped before 2 am Dubai) — cost if wrong: none
- **Task 13:** each picture's window gets its own clock, starting at 2:16 pm Dubai on Sep 14 and ticking in real time — a stopped clock stops motion's own animations (the page never settles), and setting a running clock back strands them — cost if wrong: none
- **Task 12:** under 700 px the shell's top bar keeps its title, search as its icon (the words stay for screen readers) and the bell; the theme toggle steps out (it is also in Settings → My account) — the bar overflowed at 390 px (search wrapped to three lines, Obsidian cut off) — cost if wrong: a CSS block
- **Task 12:** on a phone the "connect Google Calendar" notice sits under the page title, not above it (test added, RED then GREEN) — cost if wrong: none

## Found by the end-to-end tests, and fixed

- The rail's mini month was a grid with no rows (axe): now a labelled group.
- The "about to start" row's end time was 4.2:1 in Obsidian: now 4.7:1.
- The send queue's token chips on the chosen template were 4.3:1 in Obsidian (failing only sometimes, during a 0.12 s fade): now 5.0:1.
- The Sheets "needs attention" test left a lead and a bell alert behind, which later pictures caught depending on timing: it now cleans up.
- The shell's top bar overflowed a 390 px phone: search is now its icon there, and the theme toggle is left to Settings → My account.

## The final review

A fresh reviewer (Opus) read the whole phase: no Critical issues, six Important, eighteen Minor; "ready with fixes". Every Important one is fixed, and three Minors were re-graded Important by what a person would meet and fixed too, each with a test that failed first. The whole suite then ran green (2292 tests), with lint, typecheck and every end-to-end test.

- the meeting drawer took focus every 30 seconds (out of an open Log outcome too), and keys typed in a dialog moved the day.
- Log outcome closed as if the lead had moved when the pipeline refused the move (or a follow-up failed).
- Refresh promised to update the page later (it never did) and waited out a sync that had already failed; the runbook described behaviour that didn't exist.
- the week view stacked overlapping meetings one on another.
- privacy copy said personal events 'never leave Google' / 'never come into LUME', but the sync reads them to find matches (now: read only to find meetings with leads, never kept — as lumecrm.in/privacy already says).
- a manager's phone hero could be a colleague's call.
- (Minor re-graded Important) the lead drawer offered Log outcome on a colleague's meeting the server would refuse.
- (Minor re-graded Important) Today's brief bent real event titles into the sentence ('Dana's dana whitfield and kedar').
- (Minor re-graded Important) Log outcome promised 'analytics' (Phase 7, not built) and lower-cased month names.

What the reviewer set aside, and the ruling on each:

- the lead drawer shows every meeting with a lead to anyone who can see the lead (calendar.view own included): the Phase 5 backend's documented design (spec §2.5) — stands; worth the owner's confirmation — cost if wrong: a scope filter on /leads/:id/meetings
- Refresh counts, the Calendly notice and the booking-stage sentence aren't end to end: covered by component and API tests (Task 13 ruling) — stands — cost if wrong: an e2e Calendly fake
- the hand-back returns to /calendar without the view (Task 5 ruling) — stands — cost if wrong: a query through safeNext
- the sample week's place names are fictional and generic — stands — cost: none
- Calendly's three connect checks tick on a timer after the server already succeeded — true by then, cosmetic — stands — cost: none
- canvas faithfulness not judged by the reviewer: every new picture was reviewed against the canvas by the executor (Porcelain and Obsidian) — cost if wrong: a polish pass

## Deferred minors (the owner decides)

- Log outcome is offered once a meeting has ended, not from its start (the server allows from start)
- the lead drawer's 'Open in Calendar' for a colleague's meeting opens nothing for an own-scope person
- reconnecting shows the old last-sync count briefly (last_sync isn't cleared on reconnect)
- a busy-resent sync job may read Google again right after a sync finished (no de-duplication)
- the phone sheet doesn't return focus to its row on close, nor trap Tab while open
- the sheet's release velocity counts a fast drag followed by a pause as a flick
- the week grid adds a fixed 8 h to the day's start: an hour off on a DST-change day in the business's zone
- a meeting starting before 8 am but ending after it shows at the grid top as a 30-minute block without the 'before' hint
- the gear's return path (sessionStorage) is never cleared, so Settings → Calendar reached from the settings nav later may return to an old view
- the phone's Refresh card may cross the 16 px gutter at 390 px (no connected-calendar picture covers it)
- the e2e Back test starts from a cold deep link; a client-side switch to Week, then gear, then Back is not covered
- a meeting cancelled by the sync, then logged in a race, is refused as 'Someone already logged this meeting: Cancelled'
- Today's brief replaces the overdue line when there are calls
