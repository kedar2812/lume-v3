# Phase 5 — Calendar and Calendly: design

**Status:** draft for the owner's review (written 2026-10-01 under the overnight authority; every decision taken
on the owner's behalf is marked **Decided:** with what it costs if wrong). Source: `docs/LUME_PROJECT_REPORT.md`
§9 (Calendar integrations), §10.2 (meeting-relative reminders), §17 Phase 5.

**Goal (report §17):** a connected calendar holding 50 personal events and 5 lead events shows exactly the 5, and
the personal events are never in the database. A Calendly booking moves the lead to its "on booking" stage
within 30 s.

## 0. What already exists

- Permissions `calendar.view` ("Calendar with lead calls only") and `calendar.connect` ("Connect their own
  Google Calendar"), in every role's defaults.
- A Calendar item in the sidebar, a placeholder page, a Calendar card in onboarding's Connect step and a tour
  step — hidden behind `CAPABILITIES.calendar = false`.
- Connect with Google (2B-2): the one relay (`apps/connect`, `connect.lumecrm.in`) that runs Google's consent
  for every client and hands each instance its grant sealed with its own token. It refreshes access tokens.
- Templates show meeting variables (`{{meeting.date}}`, `{{meeting.time}}`, `{{meeting.link}}`) as
  "needs Calendar".
- CLAUDE.md: every integration is optional; LUME works with all of them off. Lead data leaves an instance
  only to integrations the client enabled.

## 1. Split

Three plans, like Phases 3 and 4, each shippable on its own:

| Plan | What | Depends on |
|---|---|---|
| **5A Google Calendar** | Connect (per person, through the relay), sync lead meetings only, `meetings`, the Calendar screen, a lead's meetings in its drawer, "Log outcome" after a meeting | — |
| **5B Calendly** | An admin connects the business's Calendly; bookings and cancellations arrive by webhook; a booking makes (or finds) the lead, records the meeting, moves it to the pipeline's "on booking" stage, tells the owner | 5A's `meetings` |
| **5C Meetings in messages** | Meeting variables render; "remind the lead N hours before" as a stage automation; Today shows today's calls | 5A (and 5B for Calendly meetings) |

## 2. 5A — Google Calendar

### 2.1 Connecting

- **Decided:** connecting goes through the existing relay, as Connect with Google does: `GET /start?…&kind=calendar`
  asks Google for `calendar.events.readonly` and `calendar.calendarlist.readonly` only (read-only; LUME never
  writes to anyone's calendar in this phase). There is no Picker: the relay hands the sealed grant straight back
  to `/calendar/connected` on the instance. *Cost if wrong:* a second OAuth client per instance (rejected:
  every client would need their own Google verification).
- Per person (`calendar.connect`). Settings → My account → Calendar: Connect, the calendars LUME looks at
  (primary ticked; others from the person's calendar list), Disconnect (forgets the grant and every meeting it
  brought).
- **Google's verification:** calendar scopes are *sensitive*. Until the owner's Google Cloud project is
  verified, people see Google's "unverified app" screen and the project is capped at 100 people across all
  clients. The runbook (`docs/runbooks/connect-with-google.md`) gains the calendar scopes and the verification
  steps. The OAuth app must be **In production** (testing-mode grants expire after 7 days).
- A grant Google stops honouring → the connection shows "needs reconnecting" (as a sheet does), the person
  and admins hear it once, and meetings already kept stay.

### 2.2 Lead meetings only

- **Decided:** rules, in order, each switchable by an admin (Settings → Calendar):
  1. **attendee is a lead** (on): an attendee's email equals a lead's email (case-insensitive, live leads).
  2. **title has a word** (off; words set by the admin, e.g. "Discovery call"): kept as an *unlinked meeting*
     the person can attach to a lead in one tap, unless an attendee also matches.
  3. **this calendar counts** (off; the admin picks calendars by name): every event on it, matched to a lead by
     attendee when possible.
  The Calendly rule (report §9.2 rule 2) arrives with 5B; "LUME created it" waits for write access.
- An event that matches no rule is **never stored**: not its title, time, or attendees — only the sync token
  that says LUME has read past it.
- **Decided:** matching uses the lead's email only (not phone: calendar attendees carry emails). *Cost if
  wrong:* a lead with no email never matches by rule 1.

### 2.3 Sync

- `events.list` per chosen calendar with an incremental `syncToken`; a `410 Gone` resyncs the window
  (−30 to +90 days).
- **Decided:** every 5 minutes per connected person, in the API process (as sheets sync), plus "Sync now".
  Google's push (`events.watch`) is left out of 5A: each instance would need its own verified, public HTTPS
  endpoint and channel renewals; polling meets the goal. *Cost if wrong:* a meeting booked in the calendar
  shows in LUME up to 5 minutes later.
- The relay refreshes access tokens (as for sheets). An event moved, renamed or cancelled updates its meeting;
  one that no longer matches is removed.

### 2.4 Data

`meetings` (new): `id`, `lead_id` (nullable: an unlinked meeting), `owner_id` (whose calendar),
`source` (`google` | `calendly`), `external_id` (unique per source and owner), `title`, `starts_at`,
`ends_at`, `location` / `link`, `status` (`scheduled` | `cancelled` | `completed` | `no_show` |
`rescheduled`), `outcome_note`, timestamps. Row-level security follows the lead (as tasks do); an unlinked
meeting is its owner's alone. `calendar_connections` (new): the person, the sealed grant, the chosen
calendars, sync tokens, last sync, status. The grant is sealed with the instance key, as a sheet's is.

### 2.5 Screens

- **Calendar** (`calendar.view`): agenda (default) and week, lead meetings only, filters by owner (scoped by
  `calendar.view`'s scope), pipeline and stage. A meeting opens its lead's drawer.
- **The drawer:** the lead's next meeting at the top; its meetings in the history.
- **Log outcome:** after a meeting ends, its owner gets a follow-up "Log outcome" (completed / no-show /
  rescheduled, and a next step), which also feeds Phase 7's analytics.
- Design: the canvas gets a Calendar artboard set (agenda, week, the drawer's meeting card, Log outcome, the
  connect panel) for the owner's approval **before 5A's screens are built** — as Phase 4 and licensing were.

### 2.6 Review focus

1. Personal events never reach the database (a test reads every table after a sync of 50 personal + 5 lead
   events).
2. A person who disconnects leaves nothing of theirs behind but meetings already linked to leads? **Decided:**
   disconnect removes every meeting that connection brought, linked or not (the calendar was theirs).
   *Cost if wrong:* history loses past meetings when someone disconnects.
3. A rep sees only meetings with leads they may see.
4. Google down or a grant revoked never stops the others' syncs.
5. Times are the person's zone on screen, UTC in the database.

## 3. 5B — Calendly

- **Decided:** an admin connects with a Calendly **personal access token** (pasted once, sealed), not OAuth:
  Calendly OAuth needs an app registration per redirect domain, which a multi-client product can't do per
  instance. LUME then creates an organization-scoped webhook subscription for `invitee.created` and
  `invitee.canceled`, with its own signing key. *Cost if wrong:* a token tied to one Calendly user (if they
  leave, reconnect).
- Calendly webhooks need the client's **Standard plan or higher**; on a free plan, 5A's rules still find
  meetings in Google Calendar. Settings says so.
- `POST /webhooks/calendly/:id`: the `Calendly-Webhook-Signature` checked (HMAC, 5-minute tolerance), deduped
  by event id, processed in the queue (as 2C's webhooks).
- `invitee.created` → the lead by email, then phone (a mapped question), else a new lead (switch, default on,
  into the pipeline's first stage) → a meeting (`source = calendly`) → `meeting_booked` in history → the lead
  moves to the pipeline's **on booking** stage (set in Settings → Pipeline; none = no move) → its owner hears.
  The Calendly host is mapped to a LUME person by email, for whose meeting it is.
- `invitee.canceled` → the meeting `cancelled`, history, the owner hears, and (switch) a "Reschedule"
  follow-up.
- Goal: booking → stage moved in under 30 s (the webhook queue runs at once).

## 4. 5C — Meetings in messages

- Meeting variables render from the lead's next meeting (`{{meeting.date}}`, `{{meeting.time}}` in the
  business's zone, `{{meeting.link}}`); with none, they're "missing" as today.
- A stage automation "Remind the lead before their meeting" (N hours before; a follow-up for the owner with the
  chosen template, as 4A's reminder messages).
- Today: today's calls above the follow-ups.

## 5. Out of scope

Writing to calendars (creating events, invites), Outlook/Microsoft 365, Google push channels, Calendly
routing forms, round-robin across hosts. Each can follow as its own small plan.

## 6. What the owner decides before building

- The Calendar artboards (§2.5) — designs first, as before.
- Google Cloud: adding the calendar scopes to the consent screen and starting verification (it takes weeks;
  the runbook lists the steps). 5A can be built and tested against LUME's fake Google meanwhile.
