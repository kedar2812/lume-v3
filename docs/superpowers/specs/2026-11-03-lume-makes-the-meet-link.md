# LUME makes the Meet link (owner, 2026-11-02)

A call LUME AI books ([2026-11-02 LUME AI books calls](2026-11-02-lume-ai-books-calls.md)) lives only in LUME's own
Calendar today, and the lead is told the business's own "how" words. With this on, LUME also puts the call in the
speaker's Google Calendar with a new Google Meet link, and LUME AI's yes carries that link.

## The permission, asked only of people who switch it on

- Today's calendar connection reads only (`calendar.events.owned.readonly` + `calendar.calendarlist.readonly`). It stays
  exactly as it is for everyone who doesn't use this, Nupuur's included.
- **Decision 2026-11-03 (overnight authority):** adding calls uses `calendar.app.created`, not
  `calendar.events.owned`. Google lists app.created as **non-sensitive** (checked in the Cloud Console: no lock, and
  after saving it the Verification centre still says data access is verified), so it needs no verification, no
  unverified-app screen and no review wait. It lets LUME make calendars of its own and change events only on those:
  LUME makes one, "LUME calls", in the person's Google Calendar, and never touches their own calendars. Calls on the
  primary calendar would need `calendar.events.owned` and a full Google review (weeks), and Google asks for the
  narrowest scope that works: this one does.
- LUME asks for it, with the two read-only scopes, only on its own link (relay kind `calendar_write`, signed like the
  others) when a person presses **Let LUME add calls to your Google Calendar**.
- Back from Google: the relay hands back `calendarWrite: true` when the person left LUME's calendar ticked. Unticked,
  the calendar still connects read-only. With it, LUME makes "LUME calls" (or reuses the one it made, if the account
  still has it) and reads it like a chosen calendar, so a call moved or cancelled there follows into LUME. The
  connection keeps `adds_events` and `calls_calendar_id`.
- Connecting again the read-only way (Settings → Calendar → Connect) replaces the grant, so `adds_events` goes false
  (the calendar id is kept for next time).
- The person deleted "LUME calls" in Google Calendar: the booking is held ("its LUME calls calendar is gone"),
  `adds_events` goes false, and Settings shows the button again; allowing it makes a new one.

## Settings → LUME AI → Calls LUME AI may say yes to

- New switch under "How the call happens": **LUME makes a Google Meet link for each call** (`calls.meet`, default off).
- Shown only when Google Calendar is set up on this LUME (module on and Connect with Google configured).
- Under it, the person's own state: "LUME adds calls to your Google Calendar (name@…)" or the button **Let LUME add calls
  to your Google Calendar** (connects, or upgrades the connection they have).
- The speaker is whoever a run speaks as: each speaker needs their own permission. Without it, a booking is held.

## Booking (in the send transaction, under the speaker's calendar lock, as today)

1. The slot is checked again (as today).
2. `calls.meet` on: the speaker's connection must be active with `adds_events`. LUME adds an event to its LUME calls
   calendar: id `lume` + the meeting's id in hex (Google's base32hex), "Call with <lead>", the call's start and end in the
   business's time zone, a Meet request (`conferenceDataVersion=1`, request id = the meeting id), `sendUpdates=none`, no
   attendees (the lead gets the link on WhatsApp, never a Google invite), private property `lumeMeeting=<id>`.
3. A retry after a lost answer finds the event (Google's 409 for the same id): LUME reads it back, never a second one.
4. The Meet link is kept on the meeting (`link`). LUME AI's message gets one line after it: `Google Meet: <link>`.
5. The reply fails after the event was added: the booking rolls back, and LUME removes the event (best effort, logged).

## When LUME can't make the link

Held for a person, nothing sent, nothing booked ("needs you" with words):

| Case | Words |
|---|---|
| The speaker has no calendar connection, or one without `adds_events` | "LUME couldn't make a Meet link: <name> hasn't let LUME add calls to their Google Calendar. Nothing was sent." |
| The connection needs reconnecting | "LUME couldn't make a Meet link: <name>'s Google Calendar needs connecting again. Nothing was sent." |
| Google refuses or is down after retries, or gives no Meet link | "LUME couldn't make a Meet link just now. Nothing was sent." |
| Google Calendar off or not set up on this LUME | The switch has no effect; the "how" words are used (as today) |

## Afterwards: Google is the place to move or cancel it

The sync reads an event carrying `lumeMeeting` onto LUME's own meeting, never as a second meeting: a new time moves it,
a cancellation cancels it (and its outcome follow-up), and a deleted event cancels it. Only a meeting of that owner with
source `lume` is touched.

## Prompt

With the switch on, the calls rule says: "LUME adds the Google Meet link under your message: never write a link." The
time guard and booked guard are unchanged.

## Edge-case sheet (QUALITY_PROCESS §1)

- **People and access**: speaker without the grant (held); speaker's connection belongs to them alone (a person can only
  upgrade their own); a speaker removed mid-run (existing pause); RLS: the connection is read as the run's actor.
- **Time**: event times sent with the business's zone (`timeZone`), Europe/London clock change, a call on the 1st.
- **Concurrency**: two runs one slot (existing lock; the second never reaches Google); a retried send step (same event
  id, 409 read back); rollback after the event was added (removed).
- **Outside world**: Google 401 (refresh once), 403 scope (held, words), 5xx/429 (retried, then held), 409 (read back),
  no `hangoutLink` (held). Module off / not configured: switch inert.
- **Data**: lead without a name ("your lead"), long names cut at 1000, emoji names.
- **Screens**: the switch and button in both themes, phone width; the button's loading state; copy speaks as LUME.
- **n/a**: licence (no plan gate), files, currencies, import data.

## Tests (first)

Relay: the write link's scopes; a read link can't become a write one; the hand-back says `calendarWrite` true or false.
API: connect with `addEvents` signs `calendar_write`; complete keeps `adds_events`; a read-only reconnect clears it;
booking with meet adds one event with the Meet request and no attendees, keeps the link, and the sent text ends with it;
no grant / Google error holds with words, nothing sent, no meeting; retry finds the event; a failed reply removes it;
sync moves/cancels the LUME meeting and never adds a Google one. Core: profile `meet` default false; prompt line. Web: the
switch, the button, the state line. Mutation checks: the `adds_events` guard, the 409 read-back, the sync's `lumeMeeting`
skip, the rollback removal.

## Mutation checks (2026-11-04, all caught)

Each guard broken on purpose, its tests run, then restored: the relay's write flag only when `calendar.app.created` was
granted; booking only into LUME's own calendar (never the primary); no calendar id on record counts as not allowed
(this one first survived; the "no calendar of LUME's own on record" case was added for it); reusing LUME's calendar on
reconnect; a gone calendar clearing the permission; the `adds_events` guard; removing the event when the reply rolls
back; the 409 read-back; the sync never keeping LUME's event as a second meeting; the sync touching only the owner's
meeting; the write link's signed kind; the prompt's Meet line; the eval scoring the call; and a lead's pop-up going when
their chat opens (the gate found it covering the chat's Close on a phone).
