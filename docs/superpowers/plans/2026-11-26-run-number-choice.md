# Run number choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** every run asks which WhatsApp number it sends from; LUME shows which number reached which leads.
**Spec:** docs/superpowers/specs/2026-11-26-run-number-choice-design.md
**Architecture:** one helper lists the numbers a person may send from; the focus run stores `send_queues.number_id`
and both senders take a `from` number; LUME AI's readiness takes the chosen number; the leads list filters on
`activities` (`whatsapp_sent`, `payload->>'numberId'`) through a partial index; the thread view adds each message's
number when the business has more than one.

## Global Constraints

- Copy speaks as LUME, no em dashes, no "we", no guessed pronouns; possessive names ("Priya's"), "the business's".
- Nothing preselected with 2+ numbers; Start off until chosen. One number: stated, stored.
- Scale: the filter is one EXISTS on an index; 500-lead runs; no per-lead number queries in the plan (one query).

## Edge-case sheet

| Input | Expected |
|---|---|
| 0 usable numbers | focus run: old way, no question; LUME AI: NO_NUMBER as today |
| 1 usable | stated, stored on start without a choice |
| 2+ usable, none sent on start | focus run (through LUME on): 400 NUMBER_REQUIRED; LUME AI: 400 NUMBER_REQUIRED |
| numberId of a teammate's own number | 403 NUMBER_NOT_YOURS (LUME AI: allowed if it's the speaker's) |
| numberId disconnected / needs attention | 409 NUMBER_NOT_READY with the number in words |
| Lead wrote to A, run on B | B's 24 hours closed: template from B; Message refused |
| Lead wrote to B 2 h ago and A 1 h ago, run on B | open on B; the message goes from B (not A) |
| Run's number disconnected mid-run | channel: WhatsApp's way, "+91 … isn't connected any more." |
| Old runs (no number) | as before (lead owner's number) |
| Reply from LUME off | no Send from row |
| LUME AI: number rated red | shown, not pickable, why beside it |
| Filter on a number with no sends | empty list |
| Filter: a failed send only | not listed |
| Filter: a sent-from-phone message (coexistence) | listed |
| Filter id not a connected-ever number (stale link) | dropped from the filters |
| Thread with one number ever | no number labels |
| Long display / names at 375px | wraps, never overflows |

## Review Focus

1. A direct message must go from the run's number, never the lead's latest-written number.
2. A run must never start on a number the person didn't choose when they had 2+.
3. The filter's cost on a million-lead list (EXPLAIN uses the partial index).
4. A stale numberId in a link or a disconnected number must never break the list or the run.
5. LUME AI's start estimate and the start itself must check the same number.

---

### Task 1: The numbers a person may send from; the run stores one
Files: `apps/api/src/modules/whatsapp/send-from.ts` (new: `sendableNumbers(req, alsoUserId?)`, `pickNumber(req, id,
alsoUserId?)`), migration `0136_run_number.sql` (`send_queues.number_id`, partial index
`activities_wa_sent_number ON activities ((payload->>'numberId'), lead_id) WHERE type = 'whatsapp_sent'`; built
without CONCURRENTLY as 0072/0133 were: writes to activities wait while it builds during the update's migrate step),
schema, `queues/service.ts` (plan/start/view), `queues/in-lume.ts` (channel/send/plan on the run's number),
`whatsapp/send.ts` (`lastInbound(req, leadId, numberId?)`, `sendReply(..., from?)`), `template-send.ts`
(`sendTemplate(..., from?)`). Tests: `queues/run-number.test.ts`.

### Task 2: LUME AI asks too
Files: `autopilot/setup.ts` (`readiness(req, d, speakerId, numberId?)`, setup lists `numbers`), `autopilot/start.ts`
(`runBody.numberId`), run views carry the number. Tests: `autopilot/run-number.test.ts`.

### Task 3: Send from, on both Start screens
Files: `components/whatsapp/SendFrom.tsx` (new), `queue/StartRun.tsx`, `autopilot/StartSheet.tsx`, clients, run
headers. Tests: `SendFrom.test.tsx`, StartRun/StartSheet additions.

### Task 4: Messaged from (filter) and numbers in the chat
Files: leads list API filter `messagedFrom`, catalog `waNumbers`, web `filters.ts`, More filters menu, chip; thread
`number` per message; bubble time line. Tests: leads filter test, filters.test, thread test, bubble test.
