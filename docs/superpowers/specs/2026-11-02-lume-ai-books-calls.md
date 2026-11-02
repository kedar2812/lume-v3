# LUME AI says yes to a call, inside the times you gave it (owner, 2026-11-02)

The owner: "if the user explicitly tells LUME AI 'say yes if the prospect agrees for a call in this time period or on
this day at this time', then it should work according to that on behalf of the user."

Today "Book meetings" is never available: LUME's calendar connection only reads events, with no free/busy, so LUME AI
couldn't know a slot is free. A lead who proposes a time is Ready for a person to confirm. The fix is the business saying
when LUME AI may say yes, and LUME keeping two leads from getting the same slot.

## Settings → LUME AI → Calls LUME AI may say yes to

- **Times**: one or more rows, each a set of days and a from–to on the business's clock ("Mon–Fri, 4–7 pm",
  "Sat, 11 am–1 pm"). Empty: LUME AI never says yes to a time (as today).
- **How long a call is**: 15, 30, 45 or 60 minutes (default 30).
- **Notice**: at least this many hours from now (default 2) and at most this many days ahead (default 14).
- **How the call happens**, in the business's words, said in the confirmation ("We'll call you on this number", a
  Meet link). Optional.

"Book meetings" becomes available once there's at least one row; Go ahead says yes itself, Ask me waits for a tap,
Never always hands a proposed time to a person (as today).

## What LUME AI does

| The lead | LUME AI |
|---|---|
| Proposes a time inside the times, with notice, free | Says yes in its reply ("Done, 5 pm tomorrow. We'll call you on this number."), the call is booked |
| Proposes a time outside them, too soon, too far, or taken | Offers up to two times inside them that are free; never books a time it wasn't given |
| Agrees to a time LUME AI offered | Books that one |
| Asks "when can we talk?" | Offers up to two free times inside them |
| Proposes a time and "Book meetings" is Ask me | Writes the yes, waits for a tap; the slot isn't held until the tap |
| Proposes a time and it's Never | Ready for a person to confirm (as today) |

The model proposes `meeting: { at }`; LUME checks it in code, never trusting the model: inside a row of times, the
call's whole length inside it, at least the notice ahead, within the days ahead, and no other meeting of the speaker's
overlapping it (meetings booked by LUME AI, from Calendly and from the connected Google Calendar, any status but
cancelled). A failed check holds the reply for a person, with words ("LUME AI wanted to say yes to a time outside the
ones you gave it"). Two runs booking at once: a lock on the speaker's meetings makes the second see the first.

## The booked call

- A meeting on the lead (source `lume`), owned by the run's speaker, "Call with <lead>", with the business's "how" as
  its location: in Calendar, on the lead's Meetings tab, and asked about afterwards like any meeting (outcome).
- The lead's activity: "LUME AI booked a call for Tue 3 Nov, 5 pm".
- The run: the lead goes to Ready ("Call booked for Tue 3 Nov, 5 pm"), its goal reached when the goal is the call's
  stage or a written goal about a call; otherwise LUME AI talks on.
- Cancelling or moving it is a person's (the meeting's own controls).

## Not in this

Writing to Google Calendar (LUME's connection reads only), reminders to the lead (WhatsApp templates would need
approval), several speakers' separate times (one set of times for the business; each speaker's own meetings checked).

## Edge cases

| Case | What happens |
|---|---|
| Start at the window's start, end at its end | Yes |
| A call running past the window's end, or starting before it | Outside: a person |
| A day not in the row; no rows at all | Outside |
| Less notice than asked (exactly the notice is fine) | Too soon |
| Past the last day ahead, on the business's calendar | Too far |
| Overlaps any meeting of the speaker's not cancelled (one ending as it starts is fine) | Taken |
| The model's time unreadable ("tomorrow 5pm") | A person |
| A clock change (Europe/London, 25 October) | Read on the business's own clock |
| Book meetings Never / Ask me | A person / waits for a tap, nothing held |
| The message names another time than the one booked | Held: a time not given |
| "Done, see you at 5 pm" with nothing booked | Held: a call promised, not booked |
| Two leads, one slot, written at once | The second finds it taken as it books: nothing sent to them, a person |
| Approved after the slot was taken | Nothing sent, a person |
| Times removed after an ask | Re-checked at booking: outside, nothing sent |
| The reply fails after booking | The booking is rolled back with it; no bell |
| A Google sync | Never touches it (no connection id) |

## Tests (first)

Core: the slot check (inside, edges, length crossing the end, notice, horizon, overlaps, the business's time zone and a
day change); times inside the rows count as given for the time guard; the prompt states the rows. API: a proposed free
time is booked and confirmed; a taken one offers others; two runs at once book one; Ask me waits; Never hands over;
the meeting shows in Calendar and the lead's Meetings. Web: Settings rows, both themes. Mutation check on each guard.
