# LUME AI on Calendly (option A) Implementation Plan

> **For agentic workers:** native execution (owner's standing workflow): implement task by task, fresh reviewer at the
> end. Steps use checkbox (`- [ ]`) syntax.

**Goal:** when the business chooses it, LUME AI shares LUME's Calendly booking link where it would offer times, so the
lead picks a time on Calendly's own page; it never books or claims a time itself.

**Architecture:** a choice on the call rules (`via: "times" | "calendly"`); the booking link's address saved with the
Calendly settings when an admin chooses it; LUME AI's read gets `bookingLink` instead of call times when the link is
ready; the model sets `bookingLink: true` and LUME adds the link under its message (as the Meet link); the guards hand
over a reply that books a time or says it's booked; Calendly's own post brings the booking in, as today.

**Spec:** docs/superpowers/specs/2026-11-28-lume-ai-calendly-design.md (APPROVED 2026-11-28, option A).

## Global Constraints

- Copy speaks as LUME; no em dashes; no "we"; no over-promising ("LUME AI never says a call is booked").
- Calendly stays optional: with it off or half set up, LUME AI uses the call times exactly as before.
- No client names, no hardcoded links: the link is the business's own, read from its Calendly settings.
- The model never writes a URL; LUME adds the exact link it read.

## Review Focus (edge-case sheet, QUALITY_PROCESS §1)

People and access: Book meetings set to Never (no link offered, as no times); Ask me (the reply with the link waits
for a tap). Time: n/a (Calendly's page owns times and zones). Concurrency: the link changed or turned off between the
draft and the send (checked again at send: gone, a person gets the lead, nothing half-sent); two replies in a row (the
lead already has a meeting booked: LUME AI is told and doesn't send the link again). Outside world: Calendly
disconnected, paused, not in the plan, booking link unset or no longer offered by Calendly (daily check marks it gone):
call times instead, and Settings → LUME AI says why; Instagram 1,000 bytes (room kept for the link line). Data: a link
up to 300 characters; the lead's words naming a time are never confirmed. Screens: the choice shows only with a
booking link chosen, says which link, and says when it's not working; phone width; both themes.

### Task 1: the choice and LUME AI's read (packages/core)

- `CallRules.via?: "times" | "calendly"` (absent: times), validated in profile.ts.
- `AutopilotCtx.bookingLink?: { name: string; booked: string | null } | null`; instructions: share the link (LUME adds
  it), never a time, never "booked"; `booked` says the lead already booked (don't send it again).
- `autopilotReplyOutput.bookingLink: boolean` (default false).
- `guardReply`: `GuardCtx.bookingLink?: boolean`; in link mode a `meeting` hands over ("LUME AI wanted to book a time
  itself; your Calendly link is how leads book"); `updates.bookingLink` true only in link mode; times still guarded
  (the lead's own words only).
- Tests: instructions with and without the link; guard cases above; `igReplyFits` room for the link line.

### Task 2: the link's address and readiness (apps/api calendly)

- `CalendlySettings.bookUrl?: string | null` and `bookGone?: boolean`: saved by `patchCalendly` with `bookWith` (from
  the link Calendly listed), cleared with it; the daily `checkCalendly` sets `bookGone` when Calendly no longer lists
  the link, clears it when it's back.
- `aiBookingLink(req, d)`: `{ url, name } | { why } ` (off / not in plan / paused / needs attention / no link /
  link gone).
- Tests: patch saves the address; health marks gone and back; each why.

### Task 3: the engine (apps/api autopilot)

- `aiCtx`: `rules.via === "calendly"` and the link ready and Book meetings not Never: `bookingLink` (and the lead's
  upcoming meeting label), `calls` null; otherwise as today.
- `availabilityOf.book_meetings`: ok with times or a ready link.
- Send: `updates.bookingLink` → the link read again; gone → a person gets the lead ("LUME's Calendly link stopped
  working"); else `draft + "\n\n" + url`.
- Tests (fake AI, calendly fake): a reply carries the exact link; Ask me waits; link gone at send; booked already.

### Task 4: Settings → LUME AI

- `CallTimes`: "How LUME AI books a call": At a time it offers / With your Calendly link ("<link name>"), shown only
  with a booking link chosen; the not-working note with why; the call times stay (they're the fallback).
- Tests: shown/hidden, saving `via`, the why.

## Built 2026-11-28

All four tasks, test first; 12 mutants killed (own meeting, link offered, Never, Ask me, booked words, no times with
the link, via only, the send's check, the daily check, gone's why, availability, the screen's gone note).
Rulings: `bookingLink` is optional in the model's answer (absent: false), so answers and fixtures from before stay
valid. Instagram's standing LUME AI run reads availability without the server's deps (ai-intake.ts), so there a
Calendly-only setup (no call times) leaves Book meetings off: deferred, call times still work there. The engine test
moves a week per case (a weekend holds the sends).

## Fresh review 2026-11-28

Fixed, each test first and its mutant killed:
- Important 1: with the link on offer, any time in LUME AI's words hands over, even one the lead named ("Tuesday 5pm
  works, I'll call you then" went out); only the call the lead already booked may be said (its words are given).
- Important 2: a booking link chosen before LUME kept its page shows "still reading … within a day, or save it again",
  and the daily check fills the page and name in from Calendly.
- Important 3: the daily check writes only over what it read (an admin's save meanwhile is kept), and keeps the page
  and name current (an address changed in Calendly).
- Copy: the screen never promises call times when there are none ("with none, a person confirms each call").

Deferred minors (rulings): no guard on a link the model writes itself (it never sees the real address; the prompt
forbids it); "pick on the link below" with bookingLink false goes out without a link (prompt-level, as files were
before their guard); the send re-checks the link but not that via is still "calendly" (an Ask me approved after the
switch still adds it); Instagram's 1,000 bytes is checked with the address at write time; ai-intake's availability
without deps (above); `bookingLink` stays optional in the schema (absent: false), kept for older answers' types.
