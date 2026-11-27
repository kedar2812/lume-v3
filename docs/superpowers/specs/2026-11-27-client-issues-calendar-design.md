# Client issues 2026-11-27: the log cards' stage, Calendly in LUME, only leads' calls: design

**Status:** written 2026-11-27 night under the owner's overnight authority ("work through the night ... it is your
duty to do in depth analysis and fix all issues/bugs properly to increase usability and understandability"). Every
call made on the owner's behalf is marked **Ruling:** with what it costs if wrong.

The owner's list, as clients put it:

1. "to do list issue, allow moving lead to any pipeline stage via the log cards"
2. "calendly link selection for lume, allow lume to schedule calls in calendly, also there has to be a clear proper
   indicator that differentiates calendly from google calendar ... and filter calls"
3. "calender issues still noticed that irrelevant data from calender ends up in lume, lume has to fetch data relevant
   to leads only, nothing else related to current clients or personal details"

## What LUME does today (the analysis)

**1. The log cards.** Today's to-do list (Up next) gives each call **Log outcome** (`LogOutcome`, also on the
Calendar, in a lead's Meetings and in the drawer). It offers one move: after **Held**, a switch "Move Asha to
<the next open stage>". Nothing for a no-show or a reschedule, no other stage, never Won or Lost. The drawer's
**Log a call** (`LogCall`) moves nothing at all. And `LogOutcome` moves with `leadsClient.move` directly, past
`useStageMove` (the one place every other move goes through), so a stage that needs a lost reason or required fields
is simply refused.

**2. Calendly.** An admin connects Calendly with a token; Calendly posts every booking and cancellation in the account
(the organization's, when the token's owner is an admin) to LUME. There is no choice of which links: every event type
counts. LUME never books in Calendly: Schedule a meeting and LUME AI's calls go on Google Calendar with a Meet link.
On the Calendar a meeting doesn't say where it came from; the only hint is the "Reading from" line.

**3. What comes in.**
- **Google Calendar**: an event is kept when (a) an attendee's or the organiser's email is a lead's, or (b) its title
  has one of the title words, or (c) it's on one of the chosen calendars. (b) and (c) keep events **with no lead at
  all** ("Not linked to a lead"; 8ca5c802 made that deliberate so they could be linked). That is where personal
  events and other clients' meetings come in: a "Call" in a title, a whole calendar. And (a) counts a lead that is
  already a **customer** (in a Won stage): a client's weekly sessions arrive as calls, ask for an outcome on Today and
  count in Analytics as calls booked and held.
- **Calendly**: every booking on every link makes a meeting, and (Create leads, on by default) a **lead**: a current
  client's session, a personal event type, an interview. Their names, emails, phones and answers are stored.
- The sync reads changed events only (Google's sync token), so a tighter rule alone would leave what's already in.

## The design

### A. The log cards move the lead to any stage

- **Log outcome** gets a **Stage** row (a select, like its Next step) whenever the meeting has a lead: the lead's
  pipeline's stages in order, the current one first as "Stays in <stage>". After **Held** it starts on the next open
  stage (today's behaviour, kept); after **No-show** or **Rescheduled** it starts on Stays.
- **Log a call** gets the same Stage row, starting on Stays.
- The move happens after the outcome or call is saved, through `useStageMove`: a Lost stage asks its reason, a stage
  with required fields asks for them, a refusal says why. Log outcome works where no catalog is loaded (Today), so it
  loads the catalog itself when it opens without one.
- **Ruling:** Won and Lost are offered too (any stage, as asked). Cost if wrong: one more option a rep can misuse; the
  lost reason is still asked.

### B. Only leads' calls come in (Google Calendar and Calendly)

- **Google**: an event comes in only when it is **with a lead**: an attendee's or the organiser's email is a live
  lead's. The title words and calendars become ways to **narrow** that (only events whose title has one of these
  words; only events on these calendars), never ways to bring in events without a lead. Settings → Calendar says so.
- **Customers stay out**: an event with a lead who was already won before it starts is a client's session, not a sales
  call. It isn't brought in. A call from before the win stays (its history).
- **Already in**: every connection reads in full once more on the next sync (the new rules decide every event in the
  window again), and meetings Google brought with no lead and no outcome are removed (they were never a lead's).
  Meetings with an outcome logged stay: they're history someone wrote.
- **Calendly: which links are for leads** (Settings → Integrations → Calendly): the account's links (event types),
  each with its name, length and owner, chosen by switch. A booking on a link not chosen is dropped on arrival: no
  lead, no meeting, and its body isn't kept.
- **Ruling:** a Calendly connected before this keeps taking every link until an admin chooses (the card and the
  Calendar say "LUME takes bookings from every Calendly link. Choose the ones for leads."), never a silent stop.
  Cost if wrong: irrelevant bookings keep coming until someone chooses; a stop would lose real leads' bookings.
- **Ruling:** a Calendly booking by a won lead on a chosen link still comes in (a client booking a sales call again).

### C. LUME schedules calls in Calendly

- **LUME's booking link** (Settings → Calendly): one of the chosen links, the one LUME books on. Only a link Calendly
  lets an app book is offered: not paid, its required questions ones LUME can answer.
- **Schedule a meeting** asks **Book with**: Google Calendar (a Meet link, as now) or Calendly (LUME's booking link).
  With Calendly, the times are Calendly's own free times for that link; LUME books with Calendly's Scheduling API
  (`POST /invitees`), so Calendly sends its own invite and reminders, and the meeting is on the lead at once (the
  webhook that follows finds it, never a second one). A lead without an email can't be booked in Calendly (Calendly
  needs one): it says so and offers to send the link instead.
- **LUME AI** may book on Calendly too (Settings → LUME AI → Call times: "Book calls on Google Calendar / Calendly"),
  the times it offers being Calendly's free ones. **Ruling:** built after the person's path, and only if the night
  allows; otherwise it's the next step. Cost: LUME AI keeps booking on Google until then.

### D. Where a call came from, at a glance, and a filter

- Every meeting shows its source with the company's official mark (`public/brand/`, unmodified): **Google Calendar**
  or **Calendly**; a call LUME booked shows LUME's own (LUME AI's Loop for LUME AI's). In the Calendar's agenda, week
  and phone views, the meeting drawer, a lead's Meetings and Today's Up next: the mark at 14 px beside the time, and
  in the drawer the words ("From Calendly").
- The Calendar's filter bar gets **From**: All, Google Calendar, Calendly, LUME.

## Not doing

- Reading Calendly's other features (routing forms, workflows, payments).
- Changing what a lead's own meetings are, or Analytics' definitions beyond what (B) removes from them.

## As built (2026-11-27 night)

- **Ruling:** the log cards ask a Lost stage's reason in the card itself, and a stage that needs fields is refused in
  words with Open lead (Log outcome works where no catalog is loaded, so it can't show the fields' editors). Log a call,
  inside the drawer, goes through the drawer's own move, which asks for the fields. Cost if wrong: one more tap, to the
  lead, on a stage with required fields.
- **Ruling:** a meeting a person linked to a lead by hand stays, whatever the rules (their choice); a lead found by an
  invitee's email follows the rules. Cost if wrong: a hand-linked customer's session stays until unlinked.
- **Ruling:** migration 0139 deletes Google meetings with no lead, no outcome and scheduled or cancelled (never a
  column, never a lead's meeting, never one with an outcome). Cost if wrong: an unlinked call someone meant to link
  later is gone; it was never a lead's.
- **Ruling:** when one email is on a customer and on a newer open lead, the event is the open lead's.
- **Ruling:** Calendly's "every link" notice is on the Calendly card only, not on the Calendar. Cost: someone who
  never opens Settings doesn't see it.
- **Ruling:** Calendly's own link choice is by switch per link; LUME's booking link is a select of the chosen links
  LUME can book, and the ones it can't are listed with why (a payment, a question LUME can't answer, "ask where").
- **Not built tonight:** LUME AI booking on Calendly (C, third bullet). LUME AI keeps booking on Google Calendar.

## Fresh review 2026-11-28, and what changed

- **Critical, fixed:** migration 0139 ran as the tables' owner under FORCEd row-level security and changed nothing
  (the test ran it as the superuser). It now lifts FORCE for meetings and calendar_connections inside its own
  transaction and puts it back; the test runs it as `lume_owner` and checks FORCE is back.
- **Important, fixed:** LUME's own Calendly booking and Calendly's post about it could race (two meetings, or a real
  booking cancelled). Both now take one lock per booking, and whichever comes second finds the other's meeting.
- **Important, fixed:** every drawer and the Calendar asked Calendly (event types, then free times) just to show the
  button. With no lead, readiness is LUME's own settings; Calendly is asked only once a lead is chosen.
- **Important, fixed:** title words and calendars saved under the old "bring these in too" would now silently narrow.
  0139 clears them; narrowing is an admin's choice in Settings → Calendar.
- **Fixed (minor):** a time-taken match no longer catches every "invalid"; no answer from Calendly says the booking
  may have gone through instead of "nothing was booked"; booking on Calendly needs what Google's Schedule a meeting
  needs (`maySchedule`); a saved link Calendly didn't list stays saved; Today's call title ends in an ellipsis;
  Calendly's mark is shown unrounded; the demo tour finds the marks by their source.
- **Ruling:** a call scheduled in LUME on Google shows Google Calendar's mark (it's on Google Calendar), and the From
  filter names "LUME AI" for LUME AI's calls. Cost: "scheduled in LUME" isn't a filter of its own.
- **Ruling:** a lead with no email is told Calendly needs one and offered Google Calendar, not "send the link".
  Cost: one more step for a phone-only lead who'd rather book themselves.
- **Ruling:** bookings, leads and posts that came in from links before they were un-chosen stay (they're leads now).
- **Deferred minors:** no notice to the lead's owner when someone else books them on Calendly; two quick POSTs on a
  group link can book twice (the button is disabled while one is on its way); a cancellation for an unchosen link is
  kept when LUME can't check its meetings (rather than lose a real cancellation).
- **Mutation check:** every new guard's mutant fails a test, but one: `ownBooking` matching any Calendly meeting for
  the invitee rather than only LUME's own is equivalent (a second Calendly delivery of one booking is already one
  `webhook_events` row), kept as the safer reading. `mayBook` duplicated the route's permission and was removed.
