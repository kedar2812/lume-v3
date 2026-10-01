# Phase 5D — Calendar, Calendly and meetings: the screens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native). Steps use checkbox (`- [ ]`) syntax for tracking. Tests are described in prose and written in full, first (standing ruling since 3B).

**Goal:** the Phase 5 screens, built to the owner's canvas: https://claude.ai/artifact/VezNudSBB8jf2Ap4Vhr7Un (v13). The canvas's boards are named in brackets.
- **Calendar page:**
  - agenda and week views;
  - Refresh;
  - a settings gear that opens Settings → Calendar with a zoom transition;
  - when you haven't connected, connecting right there.
- **Settings:**
  - Calendar (connect, which calendars, Refresh, Calendly);
  - Calendar rules;
  - Calendly in Integrations;
  - the pipeline's booking stage and its automations, simplified.
- **Elsewhere:**
  - Today's calls;
  - the lead drawer's next meeting and Meetings tab;
  - Log outcome;
  - the phone layout.

**Architecture:**
- **Data:** each screen reads the Phase 5 API built today, through `lib/calendar/client.ts`.
- **Motion and controls:** the existing UI kit and `lib/motion.ts` springs. The Refresh morph is generalised from the leads Refresh (`components/sheets/RefreshButton.tsx`).
- **The gear transition** uses the View Transitions API, with a plain cross-fade where it isn't available.
- **New server pieces, both small:**
  - the sync records what it changed, so Refresh can say "2 updated";
  - meeting words in messages read month first.

**Tech Stack:** Next.js (app router), React, motion/react, CSS modules, vitest + Testing Library, Playwright e2e, Fastify, Postgres.

**Spec:** `docs/superpowers/specs/2026-10-01-phase-5-calendar-design.md`. The owner's critique of 2026-10-01 is recorded in memory: no violet; switches green when on; dates month first; Refresh; the gear; connecting on the Calendar page; the simpler pipeline.

## Global Constraints

- **Colour:**
  - one meaning per colour (System board);
  - meetings use blue `#2A5BFF` with a sky touch `#5AB8FF`;
  - **no violet anywhere**;
  - a switch is green (`--ok`) when on and grey when off, never blue;
  - amber means "starting soon" or "needs you", red means "failed" or "can't be undone".
- **Dates:**
  - month first: "October 1, Thursday";
  - short: "Oct 1, Thu";
  - with a time: "Oct 1, Thu, 2:30 pm";
  - near dates are words: Today, Tomorrow, Yesterday.
  - All on the business's clock.
- **Third-party logos:** only the files in `apps/web/public/brand/`, unmodified:
  - `google-calendar.png` on a white tile;
  - `calendly.svg` as its own tile.
- **Copy and sound:** copy speaks as LUME. Sounds play only on achievements; nothing in this plan plays one.
- **Integrations are optional.** With Google Calendar off, or Connect with Google not set up, the Calendar page says so plainly and LUME works the same. Calendly appears only to `integrations.manage`.
- **Motion and accessibility:**
  - every control works by keyboard, with a visible focus ring;
  - hover effects only where there's a pointer;
  - Reduce Motion gets cross-fades;
  - nothing sends lead data anywhere new.
- **Process:** tests run on the dev box (`scripts/dev.sh run`). Each task ends with its tests green, a commit, a push, and CI read. Visual baselines change only where a screen changed. Review copies are unmasked (`reviewCopy`).

## Review Focus

1. **Time zones and dates.** A meeting at 11:30 pm on the business's clock sits on the right day, in agenda and week view, for a person whose browser is in another zone.
2. **Owner and permissions.**
   - A person with `calendar.view` scope own never sees "Everyone", nor another person's meeting.
   - A person without `calendar.connect` sees the Calendar page with an explanation, never a dead Connect button.
3. **Refresh against the sync.**
   - A sync already running returns "busy". Refresh then waits on that run instead of failing.
   - A connection needing a reconnect turns Refresh into "Connect again", never a spinner forever.
4. **Log outcome.** It is offered only after a meeting started. A second try after someone else logged it says so (`OUTCOME_RECORDED`) without losing the note typed.
5. **The gear and the back path.** The gear opens Settings → Calendar and "‹ Calendar" returns to the same view and date. Browser Back does the same. Deep links work cold.

---

### Task 1: The system, in code — colour, switches, dates

**Files:**
- `apps/web/src/styles/tokens.css`
- `apps/web/src/components/leads/leads.module.css`
- `apps/web/src/components/onboarding/onboarding.module.css` (its `--meet` uses)
- new `apps/web/src/lib/dates.ts` (+test)
- `packages/core/src/messaging/render.ts` (`meetingValue`, +tests)
- visual baselines where changed

- **Colour tokens:**
  - `--meet` becomes the accent; add `--sky` (`#5AB8FF` light, `#7CC8FF` dark), `--meet-soft` (`#EAF5FF` light, `rgba(90,184,255,.13)` dark) and `--meet-grad`;
  - onboarding's two `--meet` chips follow automatically.
- **Switches:** leads FilterBar `.switchRow input:checked` uses `--ok` (the switch rule).
- **`lib/dates.ts`:**
  - `longDate(d, tz)` gives "October 1, Thursday";
  - `shortDate` gives "Oct 1, Thu";
  - `dateTime` gives "Oct 1, Thu, 2:30 pm";
  - `nearDay(d, tz, now)` gives Today, Tomorrow or Yesterday, else `longDate`;
  - `dayKey(d, tz)` gives `YYYY-MM-DD` on the business's clock;
  - `weekOf(dayKey, weekStart)` gives the 7 day keys.
- **Messages:** `meetingValue` renders the date as "October 1, Thursday". Ruling: this supersedes 5C Task 7's "Thursday 1 October" by the owner's 2026-10-01 rule.
- **Tests (written first):**
  - each format, including midnight and noon ("12 pm", "12 am");
  - a 23:30 meeting in Asia/Dubai for a browser in America/New_York lands on the Dubai day;
  - week keys across a month boundary and with `weekStart` Sunday;
  - render's meeting date reads month first.

### Task 2: The sync says what changed (server)

**Files:**
- `packages/db/migrations/0040_calendar_last_sync.sql`
- `packages/db/src/schema` (calendar connections)
- `apps/api/src/modules/calendar/{sync,service}.ts`
- tests

- **Storage:** `calendar_connections.last_sync jsonb`, holding `{ at, added, moved, cancelled }`.
- **Counting:** `write()` counts a new meeting as `added`, a time change as `moved`, and a cancellation (or a removal) as `cancelled`, then stores them with the sync time.
- **View:** the connection view gains `lastSync` (null before the first sync). `POST …/sync` returns `{ queued: true, since: <iso> }`, so the screen can wait for a `lastSync.at` newer than `since`.
- **Tests (written first):**
  - a first sync of 3 lead events records added 3;
  - moving one records moved 1;
  - cancelling one records cancelled 1;
  - a sync with no changes records zeros and a new `at`;
  - the view never shows the grant.

### Task 3: The calendar client, and switching Calendar on

**Files:**
- `apps/web/src/lib/calendar/{client,types}.ts` (+test)
- `apps/api/src/capabilities.ts` (`calendar: true`)
- the onboarding and tour tests that read the flag

- **The client** wraps:
  - connection, connect, complete, choose calendars, sync, disconnect;
  - meetings (`from`, `to`, `ownerId`, `pipelineId`, `stageId`), a lead's meetings, `patchMeeting`;
  - Calendly view, connect, patch, disconnect;
  - calendar rules get and put;
  - the pipeline `bookingStageId` patch.
- **Types** mirror the server views. No `any`.
- **`CAPABILITIES.calendar = true`:** the onboarding Connect card and the tour's Calendar step appear, as their existing tests expect when it's on.
- **Tests:**
  - the client builds the right URLs and bodies (a fetch stub);
  - the capability flag reaches onboarding.

### Task 4: The Calendar page — agenda, week, drawer [Main]

**Files:**
- `apps/web/src/app/(app)/calendar/page.tsx`
- new `apps/web/src/components/calendar/` (`CalendarScreen`, `Agenda`, `WeekGrid`, `MiniMonth`, `MeetingDrawer`, `calendar.module.css`, tests)

- **The bar:**
  - ‹ Today ›, and a title in the date rule;
  - Everyone or Mine, shown only when the person's `calendar.view` scope reaches beyond their own;
  - "Any stage" menu;
  - Refresh (Task 6);
  - the Agenda/Week segmented control: icon and label on one line, never wrapping;
  - the gear (Task 7).
- **Under the bar:** the privacy line, then the source line ("Google Calendar · updated 2 min ago · Calendly bookings arrive on their own"), each source with its official mark.
- **Agenda:**
  - grouped by day ("Today · October 1, Thursday"), with up to three days that have meetings from the chosen day on;
  - each row shows the time, a 3px rule (the blue-to-sky gradient, grey for past, dashed for cancelled), the title, the lead, the stage pill, the source mark and the owner;
  - the meeting starting within 15 minutes gets an amber rule and a live dot, with Join as primary blue;
  - an ended meeting with no outcome gets an amber "Log outcome".
- **Week:**
  - 8 am–8 pm, with blocks in sky-soft with a 3px rule and the now line on today only;
  - other weeks show "No meetings with leads this week" when empty.
- **The rail:**
  - a mini month that jumps the agenda, with dots on days that have meetings;
  - this week's held, no-show and to come;
  - "needs its outcome";
  - "Reading from" with health dots.
- **The drawer:**
  - a glass panel from the right that leaves the way it came;
  - Join, Copy link (confirms "Copied"), "More" (open in Google Calendar, copy, open the lead), the lead card, whose meeting, why it's here (the source mark) and the reminder.
- **URL state:** `?view=week&d=2026-10-01&m=<meetingId>`, so a link reopens the same view.
- **Keyboard:** R refreshes, T goes to today, ← and → move, Esc closes the menu, then the drawer.
- **Tests (written first):**
  - agenda grouping and labels in the date rule;
  - the starting-soon state at 14:16 for a 14:30 meeting;
  - the Mine filter hides others;
  - "Everyone" is absent for an own-scope person;
  - the stage menu filters;
  - the week grid places a 23:30 meeting on the right day (Review Focus 1);
  - the URL round-trips;
  - Esc order;
  - the drawer's copy confirms.

### Task 5: Connecting, on the Calendar page and in Settings [CalendarEmpty, Connect]

**Files:**
- new `components/calendar/ConnectCalendar.tsx` (+css, tests)
- new `app/(app)/calendar/connected/page.tsx` (the relay's hand-back: `/calendar/connected?p=&s=`)

- **The connect card:**
  - the Google Calendar tile, a wire, and the LUME tile;
  - three promises (only lead meetings; personal events never leave Google; read-only);
  - "Continue with Google" in Google's own button style.
- **The motion, phase by phase:**
  - **wait:** the Google tile lifts and the wire runs;
  - **linked:** the wire draws solid blue, the tiles click together and a green tick pops;
  - **reading:** meeting glyphs drift into LUME and the count climbs;
  - **done:** the card fades and the agenda rises in.
  - Reduce Motion gets cross-fades only.
- **The hand-back:**
  - posts `complete`, then returns to where connecting began (the Calendar page or Settings, kept in `sessionStorage` under a key and verified as a same-origin path by `safe-next`);
  - errors (`CALENDAR_NO_ACCESS`, `GOOGLE_SETUP`, `GOOGLE_UNAVAILABLE`) are said on the card with "Try again".
- **The Calendar page states:**
  - not connected: the card over a faded ghost agenda, plus "Booking calls with Calendly? Set up Calendly" (admins only);
  - module off: "An admin can switch Google Calendar on in Settings → Integrations";
  - no `calendar.connect`: "Your role doesn't connect a calendar. Meetings others bring still show here".
- **Tests:**
  - each state by permission and module;
  - the hand-back posts once and returns to the stored path;
  - a foreign path is refused;
  - an error shows its words.

### Task 6: Refresh, for the calendar [Main, Connect]

**Files:**
- `components/sheets/RefreshButton.tsx`: extract its morph shell to `components/ui/RefreshMorph.tsx`, keeping the leads behaviour and tests green
- new `components/calendar/CalendarRefresh.tsx` (+test)

- **The motion:** the same as the leads Refresh. Button → "Syncing your calendar…" pill → a card (the Google Calendar mark → meetings → LUME, with a blue bar) → the result ("2 updated · 1 new meeting · 1 moved to 5:30 pm" or "Up to date") → back into the button ("✓ 2 updated").
- **Waiting for the result:** after `POST sync` it polls the connection every 1.2 s for `lastSync.at > since`, for up to 30 s, then says "Still syncing. LUME will update this page when it's done". The changed rows wash blue once.
- **Edge states:** busy is waited on (Review Focus 3); `CALENDAR_NEEDS_RECONNECT` turns the button into "Connect again".
- **Tests:**
  - the phases in order with a fake clock;
  - the counts' words;
  - the timeout words;
  - reconnect;
  - the leads Refresh tests still pass.

### Task 7: Settings → Calendar, and the gear [Main settings view, Connect, Rules]

**Files:**
- `lib/settings/areas.ts` (a personal "Calendar" area, `calendar.connect`; "Calendar rules" for `settings.manage`)
- new `app/(app)/settings/calendar/page.tsx`, `…/calendar/rules/page.tsx`
- new `components/settings/CalendarSettings.tsx`, `CalendarRules.tsx` (+tests)
- `components/calendar/CalendarScreen.tsx` (the gear)

- **The page:** Connected-as with its Google mark, last synced and every 5 minutes, and Refresh.
  - Calendars LUME reads, with **green switches** (`PATCH connection`).
  - Disconnect, with an inline red confirmation that says what goes.
  - The Calendly row (On, with its mark, linking to Integrations; admins only).
  - "Needs reconnecting" shows the amber bar with "Connect again".
- **Calendar rules (admin):** the two rules (an attendee is a lead; title words) and which calendars, with a sample week showing what's kept, as the Rules board.
- **The gear:**
  - **Transition:** `document.startViewTransition` with the settings page growing from the gear (`view-transition-name` on the gear's box and the settings content) and the gear turning 90°. Without the API, a 200 ms cross-fade.
  - **Arrival:** the "Calendar" nav item and heading glow once.
  - **Back:** "‹ Calendar" returns to the Calendar URL the gear left from (kept in history state), as browser Back does (Review Focus 5).
- **Tests:**
  - the area appears by permission;
  - the switches patch and roll back on failure;
  - the disconnect confirmation;
  - the rules round-trip;
  - the gear navigates with the return URL;
  - the back link uses it.

### Task 8: Calendly in Settings → Integrations [Calendly]

**Files:**
- new `components/integrations/CalendlyCard.tsx` (+test)
- `components/integrations/Integrations.tsx`

- **The card's header:** the official mark at 52 px and one line on what it does. Connected shows "Receiving", with a green pulse.
- **Not connected:**
  - the three-step story (someone books → lead found or made → moved to its stage);
  - the token field with where to make one (Integrations › API & webhooks › Personal access tokens);
  - "Kept sealed; never shown again".
- **Connecting** shows the three checks ticking in order: the token accepted (who), the organisation found, bookings now coming to LUME.
- **Connected:**
  - make a lead for someone new (green switch);
  - a Reschedule follow-up on cancellations (green switch);
  - the phone question (a menu);
  - "Booked leads move to" (links to the pipeline);
  - Disconnect.
  - "Needs attention" and the plan notice use the server's words.
- **Tests:**
  - each state;
  - the server's refusals shown, never the token;
  - the switches patch.

### Task 9: The pipeline, simplified [Pipeline]

**Files:**
- `components/settings/PipelineEditor.tsx`, `StageAutomations.tsx` (+tests)
- `lib/settings/pipelines.ts`

- **The booking sentence** at the top, shown only when Calendly is connected: "When someone books a call through Calendly, LUME moves their lead to [stage ▾]", open stages only. It links to Calendly settings.
- **The stage list:**
  - name and colour only, with a quiet "2 automations" when there are some;
  - Won and Lost in their own "Outcomes" group;
  - the booking stage carries a small Calendly mark.
- **The chosen stage:** "When a lead enters <stage>, LUME does this on its own".
  - Each automation is one line (icon, title, summary) and opens to edit it.
  - The "remind the lead before their call" editor: "Send it [− 2 hours +] before the meeting", "Message [template ▾]", a WhatsApp preview, and the one-line note ("If a call is booked sooner than this, LUME skips the reminder"). Remove and Done.
  - "Add an automation" opens a menu: Set a follow-up, Send a WhatsApp message, Remind the lead before their call (disabled when present).
- **Tests:**
  - the sentence patches `bookingStageId`;
  - outcomes are refused there;
  - an automation opens and closes;
  - the reminder edits save;
  - removing it has Undo;
  - the menu disables the present one.

### Task 10: Today's calls, and the booking notice [Today]

**Files:**
- `components/today/Today.tsx`, `today.module.css` (+tests)
- `components/notifications/*` (the booked kind's mark)

- **"Today's calls"** sits between the hero and Up next, built from `/today`'s meetings:
  - time with duration, the rule, the person and title, the source mark;
  - Held ✓, "Log outcome" (amber), "In 15 min" live with Join, "reminder at 2:00 pm";
  - Open lead and Join appear on hover;
  - it shows only when there are meetings today.
- **The brief line** mentions the next call ("Dana's discovery call is in 15 minutes").
- **The booking notice** (the existing toast and notification kind) shows the Calendly mark tile, and is bottom-centre with a timer bar, as the approved toasts are.
- **Tests:**
  - the card appears with meetings and not without;
  - each state's words;
  - the brief line;
  - the notice uses the mark.

### Task 11: The lead drawer's meetings, and Log outcome [LeadDrawer, LogOutcome]

**Files:**
- `components/leads/drawer/LeadDrawer.tsx`
- new `drawer/NextMeeting.tsx`, `drawer/MeetingsTab.tsx`
- new `components/calendar/LogOutcome.tsx` (+tests)

- **The next meeting card** is a clean sheet card with a blue-to-sky rule, a countdown ring, "In 15 min" (amber when soon), Join and "Open in Calendar".
- **The Meetings tab:** coming up and earlier, with outcome pills.
- **Log outcome:**
  - Held, No-show or Rescheduled (a segmented choice), with a note;
  - "Move <lead> to Call done" (a green switch, the pipeline's next open stage);
  - for a no-show, "Set a Rebook follow-up" (a green switch);
  - a next step from the follow-up presets.
  - Saving patches the meeting and makes the follow-up.
  - `OUTCOME_RECORDED` keeps the typed note and says who logged it (Review Focus 4).
- **Tests:**
  - the card's states;
  - the tab's lists;
  - each outcome's request;
  - the refusal keeps the note.

### Task 12: Phone [Phone]

**Files:** `components/calendar/*` (responsive rules), a tab bar entry where the shell already has one.

- **Under 700 px:**
  - the Calendar page is a list grouped Today and Tomorrow, with a white hero card for the next call (no colour fill, a blue-to-sky rule);
  - a tap opens a bottom sheet: dragged with velocity projection, rubber-banding upward, dismissed past 220 px projected;
  - Join, Log how it went, Open lead, WhatsApp and Copy link.
- **Tests:** the sheet's dismissal maths with velocity (`lib/motion` `project`), and the layout switch.

### Task 13: End to end, baselines, review copies, docs

**Files:**
- `apps/web/e2e/calendar.spec.ts` (with the Google and Calendly fakes)
- `visual.spec.ts`
- `docs/runbooks/calendar.md` (admin words)
- `docs/phase-5-screens-<date>.md` (rulings and deferred minors)

- **e2e:**
  - connect through the fake relay;
  - see the agenda;
  - Refresh shows counts;
  - the gear opens Settings and back returns;
  - Log outcome on an ended meeting;
  - a Calendly booking (fake post) shows the notice and Today's call;
  - the pipeline sentence moves the booking stage.
- **Visual baselines** for the new screens. Unmasked review copies to `e2e/__review__`.
- Then a final whole-branch review by a fresh Opus reviewer. Fix Critical and Important findings with RED→GREEN, and list deferred minors.
