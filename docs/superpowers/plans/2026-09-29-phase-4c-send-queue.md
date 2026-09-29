# Phase 4C — The send queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Messaging forty leads is one focused run, not forty drawers: pick a view (or a selection) and a template, then Send, Sent?, next — resumable, capped, and safe for a masked rep.

**Architecture:**
- A queue is planned on the server from a saved view's filters (4B) or a selection, under the person's own row-level security: who's in, in what order, and who's left out and why. It records the template **version** it planned with (4A), so an edit mid-run never changes what was planned.
- Each item is sent through 4A's own path: `prepare` (the server renders, builds the wa.me link) and `confirm` (logs, completes, moves). The queue adds only its bookkeeping: one send per item (an atomic claim), a re-check at send time, and the caps.
- Caps: the run size (Settings → Messages, default 50, 1–200) and a daily cap per person on queued sends only (default 150, 1–500), counted in the person's own timezone.

**Tech Stack:** as 4A and 4B.

**Spec:** `docs/superpowers/specs/2026-09-29-phase-4-whatsapp-templates-design.md` (§2 4C, §3 Queue size, Daily cap, Queue safety, §4 `send_queues`, `send_queue_items`, `settings.messaging`, §5 queues and settings routes, §6 The send queue and Settings → Messages, §7 Queue).

## Global Constraints

- **Design bar (owner, 2026-09-29):** "a really clean UI, it should stand up to the design we have built so far, clean animations and proper placement of components". The apple-design skill applies; motion is interruptible springs with reduced-motion cross-fades; every new screen has full, unmasked review copies in both themes, shown to the owner.
- A masked rep can run a queue and the lead's number never reaches their browser, except in the wa.me link `prepare` returns (as 4A).
- Nothing about one lead ever stops the run: a lead that can't be sent is skipped with its reason.
- No client names or stages; copy speaks as LUME; one accent blue; WhatsApp green only on Send.
- Sound only on achievements: `sent` on a confirmed send (as 4A), `cleared` when a run finishes. Skipping is silent.
- The gate, TDD with RED watched, CI read after every push, the live chain.

## Interaction and motion (apple-design, binding for Tasks 4–5)

- **The run is a focused mode**, full screen over the app (a modal task: it gets the scrim-less full sheet, the app dimmed and pushed back behind it).
- **One card at a time.** The next lead slides in from the right with `SPRINGS.default`, the done one leaves to the left along the same axis; a skipped one leaves the same way, faded. Reduced motion: 150 ms cross-fades, no slides.
- **Sent?** appears over the card (the 4A prompt, inline in the card) when LUME has focus again; Yes plays `sent` with the tick, then the next card comes.
- **Keyboard:** Enter sends (opens WhatsApp), S skips, Y / N answer Sent?, P pauses, Esc leaves (paused, resumable). Every key is shown once, quietly, under the card.
- **Progress** is a thin bar under the header that grows with a spring; "12 of 40" and "Today 37 / 150" use tabular numerals.
- **Finishing:** the `cleared` sound, a short summary (sent, not sent, skipped with reasons) and one primary action, "Done".
- **Placement:** one primary action per surface (Send in the run; Start in the start sheet; Save in Settings → Messages).

## Review Focus

1. **Two tabs on one queue.** Both show the same item; only one can send it (the claim is atomic), the other moves on.
2. **The daily cap across midnight in the person's timezone** (not the server's, not the business's): 150 sent before midnight in Kolkata, then the next day starts at 0.
3. **A lead lost mid-run** (reassigned away, deleted, its number removed, or the rep's rights changed): skipped at send time with its reason; the run goes on.
4. **A masked rep's run:** no response, error or log line carries the lead's number, except the wa.me link.
5. **A template edited or archived mid-run:** every remaining item still sends the version the queue planned with.

---

### Task 1: Queues in the database, and Settings → Messages

**Files:**
- Create: `packages/db/migrations/0029_send_queue.sql`, `packages/db/src/schema/queues.ts`
- Modify: `packages/db/src/schema/index.ts`, `packages/db/src/schema/config.ts` (`settings.messaging`), `apps/api/src/modules/settings/{routes,service}.ts` (+ `messaging.ts`, test), `apps/web/src/lib/settings/audit.ts` (+ test), `apps/api/test/probes.ts`
- Create (web): `apps/web/src/app/(app)/settings/messages/page.tsx`, `apps/web/src/components/settings/MessagingSettings.tsx` (+ test); Modify: `apps/web/src/lib/settings/areas.ts` (+ test)

**Interfaces:**
- Produces: `send_queues` (`id`, `user_id`, `template_version_id` null for freeform, `source` (`view:<id>` | `selection`), `source_name`, `status` `active|paused|finished|cancelled`, `created_at`, `finished_at`) with row-level security `user_id = lume_user()`; `send_queue_items` (`queue_id`, `position`, `lead_id`, `status` `pending|sent|not_sent|skipped`, `reason`, `text_override`, `done_at`; PK `(queue_id, position)`, unique `(queue_id, lead_id)`) readable only with its queue; both with the backup role's read policy; `settings.messaging jsonb` `{ queueSize: 50, dailyCap: 150 }`.
- Produces: `GET/PUT /api/v1/settings/messaging` (`settings.manage`) → `{ queueSize, dailyCap }`; the web page Settings → Messages (the 16th settings page).

- [ ] Failing tests: RLS probes (a queue and its items are only their person's; backups read all); settings read over defaults, saved in range (1–200, 1–500) and refused outside in words; the audit words; the Settings page saves each and the area list has Messages.
- [ ] RED, implement, GREEN.
- [ ] Commit: `feat: queues in the database, and Settings → Messages for their size and the daily cap`.

### Task 2: The queue API

**Files:**
- Create: `apps/api/src/modules/queues/{service,routes}.ts`, `apps/api/src/modules/queues/queues.test.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/modules/leads/{messages,sending}.ts` (`prepare` takes `queueItem`), `apps/web/src/lib/settings/audit.ts`, `apps/api/test/probes.ts`

**Interfaces:**
- Produces (all `messages.send_queue`, scoped as the lead's own):
  - `POST /api/v1/queues` `{ viewId } | { leadIds }` + `{ templateId? }` → `{ queue: QueueView, leftOut: { name, reason }[] }` (201). Plans under the caller's row-level security, in the view's sort; caps at the run size; leaves out, with reasons, leads without a valid WhatsApp number and leads the caller can't message. One active or paused queue per person: starting another says so (409, "Finish or end your current run first").
  - `GET /api/v1/queues/current` → the person's active or paused queue, or `null`.
  - `GET /api/v1/queues/:id` → `QueueView = { id, status, templateName, sourceName, total, done: { sent, notSent, skipped }, today: { sent, cap }, items: { position, leadId, name, stageName, status, reason }[] }`.
  - `POST /api/v1/queues/:id/items/:pos/prepare` `{ text? }` → `{ url, text }`: claims the item (atomic `UPDATE … WHERE status = 'pending'`), re-checks the lead (visible, may message, valid number), renders the planned version (or `text`), and goes through 4A's prepare. A lead that fails the re-check is skipped with its reason and the answer says so (200 `{ skipped: reason }`). The daily cap refuses with 409 "You've sent today's 150; the run is paused until tomorrow" and pauses the queue.
  - `POST /api/v1/queues/:id/items/:pos/{sent,not-sent,skip}` → `{ next: position | null, moved? }`: `sent` goes through 4A's confirm (logs, completes a follow-up, moves the stage); each is once per item.
  - `POST /api/v1/queues/:id/{pause,resume,cancel}`.
- Daily cap: queued sends (`whatsapp_confirmed_sent` with a `queueId`) since midnight in the person's timezone (their own, else the business's).

- [ ] Failing tests: planning from a view and from a selection, capped, with the left-out reasons; one current queue per person; **Review Focus 1** (two prepares of one item: one wins, the other gets the next); **Review Focus 2** (Kolkata midnight); **Review Focus 3** (reassigned, deleted, number removed → skipped with reason, the run goes on); **Review Focus 4** (a masked rep's every queue response); **Review Focus 5** (the template edited and archived mid-run still sends the planned version); sent/not-sent/skip each once; pause, resume, cancel; audit words.
- [ ] RED, implement, GREEN.
- [ ] Commit: `feat(api): the send queue — planned from a view, one send per lead, capped, and nothing stops the run`.

### Task 3: Starting a run

**Files:**
- Create: `apps/web/src/lib/queues/client.ts`, `apps/web/src/components/queue/StartRun.tsx` (+ test)
- Modify: `apps/web/src/components/leads/LeadsScreen.tsx` (an open view's header gains "Message these"), `apps/web/src/components/leads/BulkBar.tsx` ("Message" for a selection), `apps/web/src/components/today/Today.tsx` and the top bar (a paused run: "Resume · 12 of 40")

**Behaviour:** a sheet anchored to its trigger: the template (the queue's kind first: a lost-leads view suggests Re-engagement), "40 leads · 3 left out" with the reasons one tap away, today's count against the cap, and **Start** (the one primary). Start opens the run.

- [ ] Failing tests: the sheet's template order and counts; left-out reasons; Start creates the queue from the view or the selection and opens the run; "Finish or end your current run first" when one is open; Resume on Today and the top bar for a paused run.
- [ ] RED, implement with the apple-design skill, GREEN.
- [ ] Commit: `feat(web): start a run from a view or a selection, and pick it up again later`.

### Task 4: The run

**Files:**
- Create: `apps/web/src/app/(app)/queue/[id]/page.tsx`, `apps/web/src/components/queue/{QueueRun,QueueCard,QueueSummary}.tsx`, `apps/web/src/components/queue/queue.module.css` (+ `QueueRun.test.tsx`)

**Behaviour:** the Interaction and motion section above, exactly. Each lead's card: name, stage, why they're here (the view's name), the message rendered for them (editable for this lead only), **Send** (green, Enter) and Skip (S). Send claims and opens WhatsApp (4A's blank-tab hand-off); coming back asks Sent?; the answer moves on. A skipped-at-send lead shows its reason for a moment and moves on. The daily cap pauses with its words. Finishing plays `cleared` and shows the summary.

- [ ] Failing tests: Send → Sent? Yes → next; Not sent; Skip; a lead skipped at send time says why; the cap pauses; pause and leave, then resume where it was; keyboard (Enter, S, Y, N, P, Esc); the summary and `cleared`; reduced motion.
- [ ] RED, implement with the apple-design skill, GREEN.
- [ ] Commit: `feat(web): the run — one lead at a time, Send, Sent?, next, and a summary at the end`.

### Task 5: End to end and acceptance

- **e2e (`queue.spec.ts`):** a masked rep runs a three-lead queue from "Lost — re-engage" with one skip (the number never on the page); pause and resume; the cap reached in a test install with `dailyCap: 2`; screenshots (full review copies) of the start sheet, the run (card, Sent?, a skip) and the summary, both themes; axe.
- **The live script `acceptance-4c.mjs`** (unmasked screenshots in `docs/runbooks/screenshots-4c/`): a two-lead run as the rep on a fresh install; the chain gains it after 4B.
- **Runbook:** a "Phase 4C" section.
- **Show the owner** the review copies of every new screen before calling 4C (and Phase 4) done — then remind the owner about licensing.
- Commit: `test(e2e): the send queue, end to end`.

## Self-review

- **Coverage:** spec §2 4C (queue, resumable, caps, Settings → Messages; Reopen and `reopened` shipped in 4A) → Tasks 1–5; §3 Queue size, Daily cap, Queue safety → Tasks 1–2; §4 queues, items, `settings.messaging` → Task 1; §5 → Tasks 1–2; §6 The send queue, Settings → Messages → Tasks 1, 3, 4; §7 Queue → Tasks 2, 4, 5.
- **Placeholders:** none; tests named by what they prove (the standing ruling).
- **Type consistency:** `QueueView` (Task 2) is what Tasks 3–4 read; 4A's `prepareMessage`/`confirmSend` are reused, with `queueItem` added.
- **Rulings** (the owner's to overturn):
  - R1. One active or paused run per person: a second one would split the daily cap and the "Resume" entry. Ending the current run (Cancel) frees them.
  - R2. The run's lead list is fixed when it starts (a snapshot), not a live view: leads that join the view later wait for the next run; leads that leave it are re-checked and skipped with a reason.
  - R3. "Why they're here" is the view's name (or "Your selection").
  - R4. The run is a route (`/queue/:id`), so a reload or a second tab opens the same run where it is.
