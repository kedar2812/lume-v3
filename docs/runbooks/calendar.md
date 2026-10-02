# Calendar

LUME's Calendar shows the meetings a business has with its leads. They come from two places, and each is an optional module:

- **Google Calendar.** Each person connects their own calendar. LUME reads it every 5 minutes and keeps only the meetings that are with leads.
- **Calendly.** Bookings arrive on their own (see [calendly.md](calendly.md)).

With both off, LUME works as before. The Calendar page then explains why it's empty, and Today has no calls.

**Privacy.** Personal events are never kept. The sync reads each event on the chosen calendars only to check whether it's a meeting with a lead; a meeting is kept only when one of the business's rules says it's with a lead (see *Calendar rules* below). What LUME keeps is the meeting's title, its time, its link and who it's with. It never keeps the description or the other attendees' details.

## Switching it on (the client's admin)

1. The client's LUME must be registered with the Connect-with-Google relay. That's the owner's step: see [connect-with-google.md](connect-with-google.md). Until it's done, **Settings → Integrations** shows Google Calendar as unavailable.
2. In **Settings → Integrations**, switch **Google Calendar** on.
3. Each person who should have meetings opens **Calendar** and presses **Continue with Google**. Google asks them to let LUME see their calendars and events (read only).
   - Someone whose role can't connect a calendar sees why, not a button that does nothing.
4. In **Calendar → ⚙ (Settings → Calendar)**, each person picks which of their calendars count.

## Calendar rules (Settings → Calendar rules)

The business decides what counts as a meeting with a lead. A meeting counts when any rule that's on matches:

| Rule | What it does |
|---|---|
| **An attendee is a lead** | Someone invited has the email of a lead. The meeting goes on that lead. |
| **The title has a word** | For example "Discovery call". Kept even before the person is a lead; attach it to one in a tap. |
| **This calendar counts** | Every event on the chosen calendars, put on a lead by its attendees when it can be. |

The page shows a sample week with each rule's effect before saving.

## Every day

- **The Calendar page** has two views:
  - **Agenda:** the next days that have meetings.
  - **Week:** 8 am – 8 pm.

  Both are on the business's clock. People who can see everyone's meetings can switch between **Everyone** and **Mine**, and filter by stage. On a phone, it's one list (the next call first, then Today and Tomorrow), and a tap opens the meeting from the bottom.
- **Refresh** (or **R**) reads Google now, rather than waiting up to 5 minutes. It says what changed, for example "1 new meeting · 1 moved".
- **Today** lists the day's calls, with their reminder and how they were found.
- **The lead's drawer** shows the lead's next meeting, and a **Meetings** tab lists every meeting with that lead.
- **Log outcome.** Once a meeting has ended, anyone who can see it records how it went: **Held**, **No-show** or **Rescheduled**, with a note.
  - **Held** can move the lead to its pipeline's next stage.
  - **No-show** can set a **Rebook** follow-up.
  - Either can set a next step.
  - If someone else logged the meeting first, LUME says who, and keeps the note that was typed.

## Pipeline settings that use meetings (Settings → Pipeline)

- **Calendly bookings:** the stage a booking moves its lead to, or "Leave it where it is".
- **Remind the lead before their call:** an automation on a stage. LUME gives the lead's owner a WhatsApp follow-up, a set number of hours before the call, using one of the business's templates. It needs a reminder message in **Templates** first. If a call is booked sooner than that, LUME skips the reminder.

## When something goes wrong

| What a person sees | What to do |
|---|---|
| Refresh says **Connect again** / Settings says **Needs reconnecting** | Google stopped letting LUME read that person's calendar (password changed, access removed, or the grant expired). The person presses **Connect again**. Meetings already in LUME stay meanwhile. |
| A meeting with a lead didn't appear | Check that the calendar it's on is chosen in **Settings → Calendar**, and that a rule matches it. The lead's email must match an attendee for "An attendee is a lead". Then **Refresh**. |
| Google Calendar shows as unavailable | The instance isn't registered with the relay. That's the owner's step (connect-with-google.md). |
| Refresh says it couldn't reach Google | Google didn't answer that time. LUME keeps trying on its own, waiting longer each time (up to 6 hours); press Refresh again later. Reconnecting starts afresh. |
| Refresh says "Still syncing" | The sync is taking longer than 30 seconds (a big calendar). Press Refresh again in a minute to see it. |

**Disconnecting** (Settings → Calendar) forgets that person's connection **and every meeting it brought into LUME**, outcomes included. Calendly's bookings stay, and so does the person's Google Calendar itself.
