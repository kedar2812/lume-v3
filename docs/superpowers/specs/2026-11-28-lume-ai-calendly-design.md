# LUME AI and Calendly: design (for the owner's approval)

**Status:** proposed 2026-11-28; not built. The owner asked (2026-11-27) to "allow lume to schedule calls in calendly".
Schedule a meeting now books on Calendly (89e3a84b). This is the other half: LUME AI, when it agrees a call with a
lead in WhatsApp or Instagram.

## How LUME AI books a call today

LUME AI offers times from the business's own call times (Settings → LUME AI → Call times), checks the speaker's
meetings for a clash, and when the lead says yes it books the call in the same step as its reply ("Done, 5 pm"), with
a Google Meet link when the speaker's Google Calendar allows it.

## The two ways it could use Calendly

| | A. LUME AI sends LUME's booking link | B. LUME AI books the time in Calendly itself |
|---|---|---|
| What the lead sees | "Pick a time that suits you: calendly.com/…" | "Done, 5 pm" (as today) |
| Needs the lead's email | No | Yes (Calendly's Scheduling API needs one; most WhatsApp leads have none) |
| Times offered | Calendly's own page, always current | Calendly's free times, read during every reply |
| Calendly limits | None | Free plan: 5 bookings a day per person; every reply that offers times calls Calendly |
| Booking lands in LUME | Calendly's post (already handled: lead found, meeting kept, stage moved, owner told) | At once |
| What can go wrong | The lead doesn't book (LUME AI follows up as with any open question) | A time taken between offer and yes; Calendly down mid-reply; payment or required questions |

**Recommendation: A.** It works for every lead (no email needed), keeps Calendly's own page as the one truth about
times, and reuses what already works (Calendly's post brings the booking into LUME). B can follow later for leads with
an email, if the owner wants the "Done, 5 pm" feel on Calendly.

## A, in detail

- **Settings → LUME AI → Call times:** "How LUME AI books a call": *At a time it offers (your call times, Google
  Calendar)* or *With your Calendly link (the lead picks the time)*. The Calendly choice shows only when LUME's booking
  link is set in Settings → Integrations → Calendly; it names the link.
- **In the conversation:** where LUME AI would offer times, it shares the link instead, in its own words, the link on
  its own line (as the Meet link is today). It never claims a time is booked.
- **When the lead books:** Calendly's post brings it in (the meeting on the lead, the booking stage, the owner told);
  LUME AI's run sees the meeting and doesn't ask again.
- **If the link stops working** (turned off in Calendly, Calendly disconnected): LUME AI falls back to the business's
  call times, and the LUME AI page says so.

## Not in this

- B (booking times in Calendly from the chat).
- Changing how LUME AI decides a lead is ready for a call.
