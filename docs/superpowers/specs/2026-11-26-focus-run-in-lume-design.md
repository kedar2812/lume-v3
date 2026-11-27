# The focus run, inside LUME (design)

Status: proposed 2026-11-26. The owner: "now that we have the whatsapp permission, lets just make it so that the focus
window will open up the whatsapp chat inside lume window itself so that the user does not have to keep leaving lume
and come back just to send a message, we can also automate this with lume ai which already exists"; "if the lead has
not messaged in 24 hours, then the template goes out, if they have, then lume gives the indicator that they can be
texted directly so the user can get a choice instead"; "you decide, but the feature should feel refined and easy to
use, no complications and misunderstandings".

## 1. Why

The focus run (the send queue, `components/queue/QueueRun.tsx`, plan 4C) takes a person through chosen leads one at a
time. Today each Send opens WhatsApp in a new tab, and LUME asks "Sent?" when they come back: two windows, and an
answer LUME has to trust. With the business's number connected to LUME (WhatsApp Cloud API), LUME can send itself:
the person stays in one window, sees the conversation, and LUME knows the message went.

## 2. What the person sees

The run looks and moves as it does now (one card, the next sliding in, Pause, End run, Skip, the summary). The card
changes, for a lead on a connected number:

```
 Priya Shah · +91 98200 11122                     3 of 40
 New · Website form · added 2 days ago
 ┌──────────────────────────────────────────────┐
 │ (their WhatsApp messages with the business,   │
 │  newest at the bottom; empty: "No messages    │
 │  yet")                                        │
 └──────────────────────────────────────────────┘
 ● Wrote 3 hours ago · you can text them directly        (only inside the 24 hours)
 [ Message | Template ]                                  (only inside the 24 hours)
 ┌──────────────────────────────────────────────┐
 │ Hi Priya, thanks for your interest in ...     │  the run's template, filled in
 └──────────────────────────────────────────────┘
 [Send  ⏎]   Skip  S
```

- **They haven't written in 24 hours** (or never): the template goes out. The box shows the approved template's
  words filled in for this lead, read-only, with one line: "Sends your approved template First hello". Send.
- **They wrote in the last 24 hours**: a green dot line, "Wrote 3 hours ago · you can text them directly", and a
  choice, **Message** (the template's words as an ordinary message, editable for this lead; the default) or
  **Template** (the approved one, read-only). Send sends what's chosen.
- **After Send**: the message appears in the conversation with its status (Sending, Sent, Delivered, Read). The card
  says "Sent" with the tick and the sound, then the next lead comes (as now). No "Sent?": LUME knows. If WhatsApp
  refuses it, the card says why in WhatsApp's words with **Try again** and **Skip**, and the run waits there.
- **They reply while their card is open**: the reply appears in the conversation, live.
- Keys as now: Enter sends, S skips, P pauses, Esc leaves; M / T switch Message and Template when both are offered.

## 3. The rules

1. **Which leads go through LUME.** A lead goes through LUME when the business has a connected WhatsApp number and
   the person may send from LUME (`messages.send`). Otherwise the card is today's: Send opens WhatsApp, Sent? on the
   way back. A run can hold both kinds; each card says which it is by what it shows (a conversation, or "Opens
   WhatsApp").
2. **The template.** A run is started from one of LUME's message templates (as now). Outside the 24 hours LUME sends
   that template's version WhatsApp approved for this number, filled in from the lead (as the lead drawer's template
   picker does). The Start popover says, before Start, how it will go: "Sends through LUME: 34 · Opens WhatsApp: 6 (no
   number on WhatsApp in LUME)". When the chosen template has no approved version: "First hello isn't approved by
   WhatsApp yet. Leads who haven't written in 24 hours will open in WhatsApp instead." (approve it in Templates).
3. **Inside the 24 hours** the choice is the person's; Message is the default (the template's words, and they can
   change them for this lead). Outside, only the template; nothing to choose.
4. **What a send counts as.** A message WhatsApp takes counts exactly as "Sent? Yes" does today (logged, the lead's
   last message time, the follow-up done, the stage's move) through the same code that already counts a reply sent
   from LUME (`countSend`). The run's item is sent when LUME has queued it; refused by WhatsApp, the item goes back to
   pending with the reason shown, never counted.
5. **The day's cap** of the run (as now) counts these sends too. WhatsApp's own limits (the number's tier, its
   quality) are the WhatsApp sender's, as for any send from LUME; a refusal says so on the card.
6. **One send per lead** (double Enter, two tabs): the same idempotency key per run item; a second tab sees the item
   taken, as today.
7. **Do not contact, a lead gone, a lead no longer theirs**: skipped with why, as today.

## 3a. After Send, and refusals (my calls, from the builder check)

- **The card waits for WhatsApp's answer**, a few seconds at most: "Sending…" then "Sent" (WhatsApp took it) and the
  next lead, or the refusal in WhatsApp's words. After 10 seconds with no answer (WhatsApp slow; LUME keeps trying as
  it does for any send) the card says "Still sending, LUME will keep trying" and the next lead comes. The run's item
  is sent from the moment LUME queued it; if WhatsApp refuses it later, the item becomes **Not sent** with the reason,
  in the summary with Try again (today's Not sent and Try again), and it stops counting toward the day's cap.
- **Refusals that are about the lead** skip it with why, never "Opens WhatsApp" instead: they turned off marketing
  messages (their choice stands), the template needs a value the lead doesn't have ("Needs their first name filled
  in"). **Refusals that stop every send** pause the run with why, as the day's cap does: the month's paid messages
  used up, the number's tier or quality limit, the number disconnected.
- **The admin's "Reply from LUME" switch** (Settings) decides as it does everywhere: off, the run opens WhatsApp as
  today. No new setting.
- **A run started without a template** (the person's own words): inside the 24 hours, Message only; outside, the
  lead opens WhatsApp as today.

## 4. LUME AI

The run's head gains **Let LUME AI take the rest** (shown when LUME AI is on and the person may start a run): it opens
LUME AI's existing start sheet with the leads still waiting in this run. The leads LUME AI takes leave this run as
"Handed to LUME AI" (in the summary); the ones its start sheet leaves out (and says why, as it does today) stay, and
the run carries on with them, or finishes when none are left. A lead whose WhatsApp is open in the old way (waiting on
Sent?) isn't offered to LUME AI until it's answered. Nothing else changes in LUME AI.

## 5. Non-goals

- Sending to every lead with one button (a broadcast): LUME AI's runs are the hands-off way.
- Instagram in the focus run (its first messages can't be started by a business; Part E covers LUME AI there).
- Changing how templates are approved.

## 6. Approaches considered

- **A. The conversation inside the run's card** (chosen, owner: "you decide"): one place, the run's rhythm kept.
- B. The lead drawer's WhatsApp window over the run for each lead: a window over a window, the run loses its focus.
- C. One button for all: a broadcast; no tailoring; risks the number's quality rating; LUME AI covers it.

## 7. Left to the builder

The card's exact layout from LUME's existing chat parts (WhatsAppThread, the composer's styles) at desktop and phone
width, both themes, no overflow with long names and messages; how the card hears the live reply (the drawer's
WhatsApp stream); the API shape for a run's send (one call per item: `POST /api/v1/queues/:id/items/:pos/send`
`{ mode: "template" | "message", text?, clientKey }`, reusing `sendTemplate` and `sendReply`).

## 8. Tests that pin it (first, per QUALITY_PROCESS)

Outside 24 hours only the template goes (a message is refused); inside, both, Message by default; the approved
version is the one for this number and the newest approved words; no approved version → the lead opens WhatsApp
instead and the Start popover said so; a send counts once (double Enter, a retried request, two tabs); WhatsApp's
refusal leaves the item pending with the reason and Try again; the day's cap; a reply arriving shows in the card;
not connected → today's run unchanged; do-not-contact skipped; Let LUME AI take the rest hands exactly the waiting
leads and ends the run; keys; phone width and both themes; no em dashes or "we" in copy.
