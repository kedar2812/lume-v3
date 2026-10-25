# WhatsApp W2: what replies mean, stop everywhere, Who replied, the live Replies tile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every WhatsApp reply on a lead is understood (its meaning, a line, a date the lead named, a suggested next
step one tap applies); a stop in any words marks the lead do not contact at once, for every lead, not only Autopilot's;
a Who replied board groups replies by meaning with a bulk action per group (and Undo); Today's Replies tile says how
many replied since your send and opens the board.

**Architecture:** (1) Stop: LUME's own stop list (`isStop`) on every live reply to a matched lead, in the event
transaction: do not contact with reason "Said stop on WhatsApp", the lead's owner told, undoable by a person; Autopilot's
leads keep their run's path (it already does this, plus the one apology). (2) Meaning: after a live reply commits, a
`whatsapp.meaning` job reads it (AI on, allowance left, the lead not in an active Autopilot run, the reply has words): a
new core task `reply_meaning` with a fixed schema and LUME's cleaner (ids only from the business's lists, a follow-up only
after now, a lost reason only with a lost stage); kept in `whatsapp_reply_reads` (one per received message, RLS like
activities); a stop the model hears and the list didn't is applied the same way. Apply / Dismiss as the next-step
suggestion does. (3) Board: `GET /api/v1/whatsapp/replies` (since, run) → the latest reply per visible lead in the
window, grouped by meaning; per group a bulk action through the Phase 7 engine, which gains `follow_up` and
`do_not_contact` (each undoable). (4) Today: the Replies tile adds "N replied since your send" (the person's newest
send-queue run, or their newest LUME message send) and opens `/replies?since=…`.

**Tech Stack:** Fastify, Drizzle, Postgres (FORCE RLS), pg-boss, Next.js, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-18-whatsapp-replies-ai-design.md` §4.2, §5.1, §5.4, §6.4.

## Global Constraints

- AI never writes to a lead; nothing but do not contact is applied without a tap (§5.4).
- Every suggestion says where it came from ("From Sneha's reply at 4:12 pm").
- A failed or limited read shows no suggestion and says so once (§5.4); the reply itself is always on the thread.
- No client names; copy speaks as LUME; no em dashes in UI copy; Porcelain and Obsidian; 375 px.
- Groups and their words (§4.2): Interested, Asked the price, Wants a visit or call, Later, Not interested, Stop
  messaging, Wrong number, Not sure.

## Review Focus (the edge-case sheet)

- People: a rep sees only their leads' replies on the board; bulk actions check each lead (the engine does); a viewer
  without leads.edit sees suggestions but no Apply.
- Time: "since your send" on the business's clock; a date the lead named resolved on the business's clock and never in
  the past; the 24-hour window is not this plan's (sending is W3).
- Concurrency: a burst of replies from one lead: one read per message, the board shows the latest; a read finishing
  after the person already applied a step; the same event processed twice (one read, keyed by the activity).
- Outside world: AI off, not in the plan, at the hour or month limit, the provider down or unreadable answer: no
  suggestion, the reply still shows, said once; Meta delivering the same message twice (deduped before this).
- Data: voice notes and photos without words (no read, group Not sure); Hinglish, Devanagari, Arabic stops; a stop
  inside a longer message ("not interested, please stop"); "can you stop by Saturday?" is not a stop; a lead later
  deleted or merged; do not contact lifted by a person, then the lead says stop again.
- Screens: empty board, loading, error; phone width; both themes; keyboard; every control named.

---

### Task 1: a stop in any reply marks the lead do not contact

**Files:** `apps/api/src/modules/whatsapp/process.ts`, `apps/api/src/modules/whatsapp/stop.test.ts`.

- [ ] Tests: a matched lead's live reply "please stop" → do not contact, reason "Said stop on WhatsApp", by nobody (no
  person set it), one owner notice "{First} asked not to be messaged"; "can you stop by Saturday?" changes nothing; a
  stop from history (past chats) changes nothing; a lead in an active Autopilot run keeps its run's path (one apology,
  once); an already do-not-contact lead isn't touched again; a person lifts it, the lead says stop again → set again.
- [ ] Implement in the event transaction; mutation-check each guard.

### Task 2: `reply_meaning`, the read and its record

**Files:** `packages/core/src/ai/tasks.ts` (+ test), `packages/db/migrations/0092_whatsapp_reply_reads.sql`,
`packages/db/src/schema/whatsapp.ts`, `apps/api/src/modules/whatsapp/meaning.ts` (+ test), queue wiring,
`apps/api/src/ai/fake.ts` (scripted answers), `evals/ai/reply-meaning.jsonl` + runner `--only reply-meaning`.

- [ ] Core: `replyMeaningOutput` (meaning enum, summary ≤ 140, when `YYYY-MM-DDTHH:mm` or null, stop, step: stageId,
  followUp {at, title}, lostReasonId), instructions in the business's terms, `cleanReplyMeaning` (unknown ids dropped,
  a follow-up before now dropped, a lost reason only with a lost stage, a stop forces group Stop messaging).
- [ ] API: one read per received activity (unique), skipped when AI is off or limited, the lead is in an active run, or
  the reply has no words; a model stop applies do not contact like Task 1; `GET` on the lead's thread carries each
  reply's read; `POST …/apply` and `…/dismiss` (leads.edit), applied once.
- [ ] Eval: 40 replies in the languages of the Autopilot set; marks: group ≥ 85%, every stop caught, no invented id.

### Task 3: the meaning under each reply on the lead

**Files:** `apps/web/src/components/leads/drawer/WhatsAppThread.tsx`, a `ReplyMeaning` component (+ tests).

- [ ] Under a reply: the group chip, the line, where it came from, and the suggestion with Apply / Dismiss (or "LUME AI
  couldn't read this one" once); nothing when AI is off.

### Task 4: Who replied (board) and the two new bulk actions

**Files:** `apps/api/src/modules/leads/bulk-config.ts`, `bulk-engine.ts` (+ tests), `apps/api/src/modules/whatsapp/
replies.ts` (+ test), `apps/web/src/app/(app)/replies/page.tsx`, `apps/web/src/components/replies/*` (+ tests),
`apps/web/e2e/replies.spec.ts`.

- [ ] Bulk `follow_up` (a task on each lead at one moment; undo deletes the tasks it made) and `do_not_contact` (undo
  lifts only what this run set).
- [ ] `GET /api/v1/whatsapp/replies?since&run` (leads.view, RLS): groups in the fixed order with counts and each lead's
  latest reply, its line and when; replies without a read are Not sure.
- [ ] The board: groups as columns on a computer and a list on a phone; each group's action (Interested: move stage;
  Asked the price, Wants a visit or call, Later: set follow-up; Not interested: mark lost with a reason; Stop
  messaging: already do not contact, shown; Wrong number: do not contact), with the run's Undo.

### Task 5: the live Replies tile and the way in from a send

**Files:** `apps/api/src/modules/today/*`, `apps/web/src/components/today/Tiles.tsx` (+ tests), the send-queue run's
done screen.

- [ ] "N replied since your send" (the person's newest send: a send-queue run or a LUME message), opening the board for
  that window; the run's done screen links to its board.
