# The focus run, inside LUME: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each lead of a focus run (the send queue) is sent from inside LUME through the business's connected
WhatsApp number: the approved template outside WhatsApp's 24 hours, a choice of message or template inside them, the
conversation shown in the card, no "Sent?"; LUME AI can take the leads still waiting.

**Architecture:** The API gains a per-item *channel* read (how this lead goes: through LUME, or WhatsApp as today, and
why) and a per-item *send* that reuses `sendReply` / `sendTemplate` and settles the item; a trigger turns a send
WhatsApp refuses later into Not sent. The web's `QueueCard` grows an in-LUME body built from the drawer's
`WhatsAppThread`; `QueueRun` sends through it and watches the message's status; `StartRun` says how the run will go.

**Tech Stack:** Fastify + Drizzle + Postgres (RLS), Next.js/React, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-26-focus-run-in-lume-design.md` (approved 2026-11-26).

## Global Constraints

- Copy speaks as LUME: no "we", no em dashes, no guessed pronouns; WhatsApp's refusals in WhatsApp's words as LUME
  already shows them (`refusalOf`, `problem`).
- Nothing hardcoded for a client; works with WhatsApp off (the run is today's).
- One send per lead per press; a request retried with its `clientKey` is the same message (`sendReply` /
  `sendTemplate` already dedupe by `(user, clientKey)`).
- Lucide icons from `components/ui/icons.tsx`; no overflow at 375 px with long names and messages; both themes.
- Every change: edge sheet, tests first, mutation check on every guard, full gate, fresh review (QUALITY_PROCESS).

## Review Focus

1. A lead who wrote 23 h 59 min ago, sent at 24 h 01 min: the card must not offer Message once the window has closed
   (the server refuses `WINDOW_CLOSED`; the card reloads its channel and shows the template).
2. A double Enter / a second tab on the same lead: one message, the second press finds the item done.
3. WhatsApp refuses a template a minute after the run moved on: the item becomes Not sent with the reason and stops
   counting toward the day's cap; Try again re-sends it.
4. The run's template edited after approval (approved words still go; the new words wait for approval): the card's
   preview is the approved words, not the draft.
5. A run mixing leads with and without a WhatsApp number, and Reply from LUME switched off mid-run: each card says how
   it goes; the switched-off lead opens WhatsApp as today.

---

### Task 1: The API: channel, send, failures later, hand-off to LUME AI, the plan's counts

**Files:**
- Create: `packages/db/migrations/0135_queue_in_lume.sql`
- Modify: `packages/db/src/schema/queues.ts` (`outboxId` on `sendQueueItems`)
- Modify: `apps/api/src/modules/queues/service.ts`, `apps/api/src/modules/queues/routes.ts`
- Modify: `apps/api/src/modules/whatsapp/template-send.ts` (export `numberFor`)
- Test: `apps/api/src/modules/queues/in-lume.test.ts` (new; harness + the WhatsApp fake as `whatsapp/send.test.ts`
  seeds a number and approved submissions)

**Interfaces:**
- Produces:
  - `GET /api/v1/queues/:id/items/:pos/channel` →
    `{ via: "lume"; window: { open: boolean; lastInAt: string | null; until: string | null };
       template: { submissionId: string; name: string; preview: string; missing: string[] } | null;
       text: string | null }`
    | `{ via: "whatsapp"; why: string }`
  - `POST /api/v1/queues/:id/items/:pos/send` body `{ mode: "template" | "message"; text?: string; clientKey: uuid }` →
    `{ message: ThreadMessage } & QueueStep` | `{ skipped: string } & QueueStep` | `{ refused: { code; message } }`
  - `POST /api/v1/queues/:id/handed` body `{ runId: uuid }` → `QueueView`
  - `QueuePlan.lume: { on: boolean; through: number; inWindow: number; approvedTemplateIds: string[] }`
  - `QueueItemStatus` unchanged; `sendQueueItems.outboxId: uuid | null`

- [ ] **Step 1: Write the failing tests** (`in-lume.test.ts`), each named for what it pins:
  - `channel: outside 24 hours, the run's approved template in this lead's words; inside, the window and the words`
    — expect `{ via: "lume", window: { open: false }, template: { name: "First hello", preview: "Hi Priya, …" } }`;
    after a `whatsapp_received` 3 h ago: `window: { open: true, lastInAt, until: lastIn + 24 h }`, `text` = the run's
    planned text.
  - `channel: WhatsApp's way when LUME can't send` — no number connected, Reply from LUME off, the lead has no valid
    phone, the person lacks `messages.send`: `{ via: "whatsapp", why: <the existing words> }`.
  - `channel: the run's template not approved: outside 24 hours WhatsApp's way, inside a message` — why
    `"First hello isn't approved by WhatsApp yet, so this lead opens in WhatsApp."`
  - `channel: the approved words, never an edit waiting for approval` (Review Focus 4).
  - `channel: a run in the person's own words: inside 24 hours a message only, outside WhatsApp's way` — `template:
    null`; outside: why `"They haven't written in 24 hours, and a message from LUME then needs an approved template."`
  - `send template: queued once, the item sent with its outbox, the next lead` — `outboxId` set, `status: "sent"`,
    `next` = the following position; the same `clientKey` again returns the same message, no second outbox row.
  - `send message: only inside the 24 hours; the words as written, else the run's` — outside →
    409 `WINDOW_CLOSED` "They haven't written in 24 hours, so only the template can go."; inside with `text` → that text.
  - `send: two at once on one lead send one` (two parallel injects; one 200, the other 409 `ITEM_DONE`).
  - `send: a refusal about the lead skips it with why` — `MARKETING_OFF`, `MISSING_VALUES`: item `skipped`, reason the
    refusal's message; `{ skipped, next }`.
  - `send: a refusal that stops every send pauses the run` — `PAID_LIMIT`, `NO_NUMBER`, `REPLY_OFF`: queue `paused`,
    `pausedReason` = the code's words, `{ refused }`; the item stays `pending`.
  - `send: the day's cap counts these sends; one refused later stops counting` — a send, then
    `UPDATE whatsapp_outbox SET status = 'failed', problem = 'X'` → item `not_sent`, reason `X`, `today.sent` down by 1;
    `retry` makes it pending again and a new send goes.
  - `send: do not contact, a lead gone or no longer theirs: skipped with why` (as `prepareItem`).
  - `plan: how the run will go` — `lume: { on: true, through: <leads with a valid phone>, inWindow: <wrote < 24 h>,
    approvedTemplateIds: [<the template with an approved submission on the number's account>] }`; off → `on: false`.
  - `handed: the leads LUME AI took leave the run; the rest stay; none left, it finishes` — a LUME AI run holding two of
    three pending leads: those two `skipped` reason "Handed to LUME AI", one `pending`; a run that isn't the person's →
    404; a lead `sending` (old way, Sent? open) is never marked.

- [ ] **Step 2: Run them, expect FAIL** — `npx vitest run apps/api/src/modules/queues/in-lume.test.ts` (on the box).

- [ ] **Step 3: Migration `0135_queue_in_lume.sql`** — `ALTER TABLE send_queue_items ADD COLUMN outbox_id uuid`;
  `CREATE INDEX send_queue_items_outbox ON send_queue_items (outbox_id) WHERE outbox_id IS NOT NULL`; function
  `lume_queue_send_failed()` (SECURITY DEFINER, search_path public) and trigger `AFTER UPDATE OF status ON
  whatsapp_outbox FOR EACH ROW WHEN (NEW.status = 'failed' AND OLD.status IS DISTINCT FROM 'failed')`:
  `UPDATE send_queue_items SET status = 'not_sent', reason = coalesce(NEW.problem, 'WhatsApp didn''t take it.'),
  done_at = now() WHERE outbox_id = NEW.id AND status = 'sent'`.

- [ ] **Step 4: Implement in `queues/service.ts`**
  - `itemChannel(req, d, id, position): Promise<Channel>`: the lead (`visibleLead`), `replyOn`, valid phone,
    `canOnRecord(actor, "messages.send", lead.ownerId)`, the number (`numberFor(req, lead)`), the window from
    `whatsapp_received` (newest, within 24 h of `d.clock()`), the run template's approved option: `approvedFor(req,
    number.waba, lead)` filtered to the run version's `templateId` (first by its order), with `preview` and `missing`
    as `templateState` builds them; `text` = `plannedText` (or the item's `textOverride`).
  - `sendItem(req, d, limiter, id, position, body)`: as `prepareItem` up to the lead checks (lock, `pending`, cap,
    `whyNot`); then the channel; `message` needs the window open; call `sendReply` / `sendTemplate`; map refusals:
    lead-level codes `MARKETING_OFF | MISSING_VALUES | NO_WHATSAPP` → `settle(..., "skipped", message)`; run-wide
    `PAID_LIMIT | NO_NUMBER | REPLY_OFF` → pause with `pausedReason = message` and `{ refused }`; `TOO_MANY`,
    `WINDOW_CLOSED` → thrown as they are. On success: item `sent`, `outbox_id` = the outbox row of the returned
    message's activity, `done_at`; return `{ message, ...step }`.
  - `markHanded(req, id, runId)`: the run's `started_by` is the person (else 404); items `pending` whose lead is in
    `autopilot_leads` (that run, `active`) → `skipped`, reason "Handed to LUME AI"; none pending left → finished.
  - `planQueue`: add `lume` (one query over the planned lead ids for the window; approved template ids from
    `whatsapp_template_submissions` approved on the active number's account).
  - Routes in `routes.ts` with the same `run` config as the others; the send passes the WhatsApp module's limiter
    (export it from `whatsapp/routes.ts` as `sendLimiter` is built there, or build one here with `sendLimiter`).

- [ ] **Step 5: Run the tests, expect PASS**; the whole `apps/api/src/modules/queues/` and `whatsapp/` suites still
  pass.

### Task 2: The web: the card, the run, the start, LUME AI

**Files:**
- Create: `apps/web/src/components/queue/LumeSend.tsx` (+ `LumeSend.test.tsx`)
- Modify: `apps/web/src/components/queue/QueueCard.tsx`, `QueueRun.tsx`, `StartRun.tsx`, `run.module.css`,
  `apps/web/src/lib/queues/client.ts`; tests `QueueRun.test.tsx`, `StartRun.test.tsx`

**Interfaces:**
- Consumes: Task 1's three endpoints and `QueuePlan.lume`; `WhatsAppThread` (bare), `whatsappClient.thread`,
  `useWhatsApp`, `StartSheet`.
- Produces: `queuesClient.channel(id, pos)`, `queuesClient.sendItem(id, pos, body)`, `queuesClient.handed(id, runId)`;
  `LumeSend` props `{ runId; item; channel: LumeChannel; phase; onSent(step); onSkip(); onSkipped(note, step) }`.

- [ ] **Step 1: Write the failing tests**
  - `LumeSend`: outside 24 h — the template's words read-only, "Sends your approved template First hello", one Send;
    missing values — "Needs their first name filled in", Send off, Skip on; inside — the line
    "Wrote 3 hours ago · you can text them directly", the choice Message | Template (Message picked, its words
    editable), M / T switch; Send posts `{ mode, text?, clientKey }` with one key per press (a second press while
    sending posts nothing).
  - `QueueRun`: a through-LUME lead never asks Sent? and opens no tab; after Send the card shows "Sending…", then on
    the thread's status `sent` shows "Sent" and the next lead comes; a `failed` status shows the problem with Try again
    and Skip; no status in 10 s says "Still sending, LUME will keep trying" and moves on; a lead whose channel is
    WhatsApp's keeps today's flow (tab, Sent?); `WINDOW_CLOSED` reloads the channel (Review Focus 1); a live reply
    (the `useWhatsApp` event for this lead) appears in the card; "Let LUME AI take the rest" (only with LUME AI on and
    `autopilot.run`) opens `StartSheet` with exactly the pending leads; on start, `handed` is called and the run
    reloads.
  - `StartRun`: with WhatsApp on: "Sends through LUME: 34 · Opens WhatsApp: 6"; the chosen template not approved:
    "First hello isn't approved by WhatsApp yet. Leads who haven't written in 24 hours will open in WhatsApp instead.";
    WhatsApp off: no line.

- [ ] **Step 2: Run them, expect FAIL.**

- [ ] **Step 3: Implement**: `LumeSend` (the thread bare, newest at the bottom, at most the last 30 messages, the
  window line with a green dot, `SegmentedControl` for the choice, the composer's text styles, Send/Skip with their
  keys); `QueueCard` renders `LumeSend` when the channel is `lume`, else today's body (+ "Opens WhatsApp" with why
  under the name); `QueueRun` loads the channel per current item, sends through it, watches status by
  `whatsappClient.thread(leadId)` on `useWhatsApp` events and every 2 s (until settled, at most 10 s), plays `sent` on
  Sent; the head's LUME AI button; `StartRun` reads `plan.lume` for its line.

- [ ] **Step 4: Run them, expect PASS**; the `queue/` and drawer WhatsApp suites still pass.

### Task 3: In a real browser

**Files:** Modify `apps/web/e2e/queue.spec.ts` (the WhatsApp fake from `whatsapp.spec.ts`: a connected number and an
approved submission).

- [ ] **Step 1: Write**: `a run sends through LUME: the template to one who never wrote, a message to one who just
  did, no WhatsApp tab, the conversation in the card` — two leads; first card shows the template preview, Send, the
  fake receives a template; the second card shows "you can text them directly", Message, Send, the fake receives the
  text; no popup opened (`page.on("popup")` never fires); the summary says 2 sent; both themes, 375 px, `fits(page)`,
  axe clean.
- [ ] **Step 2: Run** `pnpm exec playwright test e2e/queue.spec.ts` on the box; PASS.

### Finish

- [ ] Mutation check on every guard (`scratchpad/mut-queue.sh`): window check, lead-level vs run-wide refusals, the
  trigger's `status = 'sent'`, the cap, handed's `active` and `started_by`, the template filter to the run's template,
  the card's one-key-per-press, the 10 s move-on, the not-approved fallback.
- [ ] `dev.sh fmt`, full gate on the box, fresh reviewer, fixes, push; CHANGELOG entry.
