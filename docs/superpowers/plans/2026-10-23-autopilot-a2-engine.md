# Autopilot A2: the Run Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LUME AI works a selection of leads on WhatsApp on the server: first messages and follow-ups as approved
templates, replies inside the 24 hours, toward the business's goal, within its hours, caps and Meta's tier, stopping for
good when a lead says stop, handing converted and stuck leads to a person, and never sending anything after Pause.

**Architecture:** A run is rows (`autopilot_runs`, `autopilot_leads`, `autopilot_asks`, `autopilot_events`) and a
pg-boss queue (`autopilot.step`) in the API process beside WhatsApp's. Each message is two steps: *write* (one LUME AI
call as the speaker, guarded, kept as the lead's draft for the screen to reveal) and *send* (one transaction that locks
the run, checks it's still running and the lead still LUME AI's, and queues the existing W3a/W3b outbox message as the
speaker). Every send goes through `sendReply`/`sendTemplate`'s checks inside `withJobRequest`, so a run can never do what
its speaker couldn't. The live view is id-only events on the existing stream; the screen (A3) refetches under its own
access.

**Tech Stack:** Fastify, Drizzle, Postgres (RLS), pg-boss, zod, Vitest; the fake Meta (`apps/api/test/meta-fake.ts`) and
the fake AI provider (`apps/api/src/ai/fake.ts`).

**Spec:** `docs/superpowers/specs/2026-10-19-lume-ai-autopilot-design.md` §1–§3, §6, §9 (approved 2026-10-20); A1's
`packages/core/src/ai/profile.ts` (standing choices, presets) and the monthly allowance (`apps/api/src/modules/ai/service.ts`).

## Global Constraints

- Nothing client-specific (CLAUDE.md): stages, fields, templates, files, people, hours and wording are read from the
  business's own setup; test words are fictional.
- Anti-goals (§0): no message the person didn't allow or after Pause; nothing that risks the number (§6); no invented
  price, discount, date or promise; a lead who said stop never hears from the business again.
- WhatsApp's rules (§6): templates outside the 24 hours, free text only inside; opt-outs for good; pacing within the
  business's hours and under the number's Meta tier; quality drop to yellow pauses every run on that number.
- Every LUME AI call goes through `runRead` (counts against the month; refused at a limit) as the run's speaker.
- Every message goes through the W3a/W3b outbox as the speaker (`via: "ai_autopilot"`, the run id), so it counts as a
  send (last message, first contact, stage's move) and shows in the thread.
- Copy speaks as LUME, plain words, no em dashes (`scripts/check-copy.mjs`); refusals in words.
- New tables under `apps/api/test/rls-coverage.test.ts`; new routes in `apps/api/test/probes.ts`; migrations from 0084.
- TDD for every task; the API's own e2e (Task 10) runs every flow against the fakes; no real model, no real Meta.

## Rulings made writing this plan (the owner can overrule)

- **Book meetings is off in this release:** LUME's Google Calendar connection reads only, and LUME has no free/busy, so
  LUME AI can't book without risking a clash. A lead who wants to meet goes to *Needs you* with the time they asked for
  as the deal line. The permission row says "Needs a calendar LUME can book into". Cost if wrong: the row and one move.
- **Starting a run needs `messages.send_queue`** (LUME's permission for messaging many leads at once) and
  `messages.send`; pausing, ending and approving need the starter or `settings.manage`. Cost if wrong: one key.
- **Do not contact is built here** (W2 not yet built): Stop must hold for every sender, so it lives on the lead and in
  every send path. An admin lifts it. Cost if wrong: none (W2 reuses it).
- **A run uses one number:** the speaker's own, else the business's first (W3b-2 `numberFor`). Cost if wrong: small.

## Review Focus

1. Pause pressed after a message's send step committed but before the outbox job calls Meta: Meta is never called and
   the thread doesn't show it as sent. Test: Task 6 "pause between commit and the job: nothing reaches Meta".
2. A lead writes "please don't message me again" or "band karo" (not the word "stop"): do not contact, one short
   apology, and no later run or person can message them until an admin lifts it. Test: Task 7 "stop in other words".
3. Two runs started at the same moment with overlapping leads: each lead is in one run only; the second says which were
   skipped and why. Test: Task 5 "one run per lead, at once".
4. A run started at 6:55 pm on the business's clock with hours ending at 7 pm: at most what spacing allows before 7,
   then nothing until the next working day's start. Test: Task 1 "the evening edge".
5. The model's message quotes an amount that isn't in the price list, names a file nobody chose, or proposes a date the
   lead didn't: it is never sent; the lead goes to Needs you with the reason in words. Test: Task 2 "guards hold".

---

### Task 1: The run's rules, in core

**Files:**
- Create: `packages/core/src/ai/autopilot.ts`, `packages/core/src/ai/autopilot.test.ts`
- Modify: `packages/core/src/ai/index.ts`

**Interfaces:**
- Produces: `RunStatus = "running" | "paused" | "ended"`; `PauseReason = "person" | "month" | "quality" | "speaker" |
  "number"`; `LeadState = "up_next" | "writing" | "sent" | "replied" | "talking" | "ready" | "needs_you" | "stopped" |
  "with_you" | "skipped"`; `ACTIVE_STATES` (up_next, writing, sent, replied, talking); `Move = { kind: "first" } |
  { kind: "follow_up"; n: number } | { kind: "reply" } | { kind: "wait"; until: Date | null } | { kind: "done" }`;
  `nextMove(l: { state; lastInboundAt: Date | null; lastSentAt: Date | null; followUpsSent: number }, o: { now: Date;
  followUpDays: number[] }): Move` (a reply is possible only inside 24 hours of `lastInboundAt`; follow-up n is due
  `followUpDays[n]` days after the first message; after the last, `done`); `windowOpen(lastInboundAt, now)`;
  `dailyBudget({ tierLimit: number | null; cap: number | null; sentToday: number }): number` (the lower of tier and cap,
  minus today; a new number with no tier read yet counts as 250); `nextSendAt({ now, wh, tz, budgetLeft, lastSentAt }):
  Date | null` (inside working hours, at least `MIN_GAP_MS = 20_000` after the last send and spread over the hours left:
  `max(MIN_GAP_MS, msLeftToday / budgetLeft)`; outside hours, the next working start; null when the budget is 0 today,
  meaning the next working day's start); `revealMs(text): number` (reading speed for the screen: `clamp(text.length * 28,
  1_500, 9_000)`); `isStop(text): boolean` (a conservative multilingual phrase list, lower-cased, punctuation stripped:
  stop, unsubscribe, not interested, don't message me, do not contact, no more messages, remove me, band karo, mat
  bhejo, nahi chahiye, توقف, no me escribas, ne m'écrivez plus; the model also judges, Task 2); `amountsIn(text):
  number[]` (₹/Rs/INR/AED/$/€/£ prefixed or suffixed amounts and grouped numbers of 4+ digits, Indian or western
  grouping, `k`/`lakh`/`L` multipliers); `unbackedAmounts(text, prices: number[]): number[]`.

- [ ] **Step 1: Write the failing tests** (`autopilot.test.ts`): `a first message, then follow-ups on their days, then
  done`; `a reply only inside the 24 hours`; `the daily budget is the lower of tier and cap, less today`; `spacing
  spreads the budget over the hours left`; **`the evening edge`** (Asia/Dubai, hours 09:00–19:00, now 18:55, budget 40:
  sends at most at 18:55:20-ish spacing then null until 09:00 next working day; Friday-to-Monday when the week is
  Mon–Fri); `stop in many words, never a false stop on "stop by tomorrow?"` (isStop("Can you stop by tomorrow?") is
  false; isStop("Please don't message me again") true; isStop("band karo") true); `amounts read as people write them`
  (`"₹3,80,000"` → 380000, `"Rs 1.2 lakh"` → 120000, `"AED 1,150.50"` → 1150.5, `"15k"` → 15000, phone numbers and
  years like "2026" ignored); `unbacked amounts are the ones not in the price list`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run packages/core/src/ai/autopilot.test.ts'`.
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement** in `autopilot.ts` (working hours via `packages/core/src/tasks/time.ts`
  `shiftToWorkingHours`).
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): Autopilot's rules: moves, the 24 hours, pacing, stop words, amounts`.

### Task 2: What LUME AI is asked, and the guards on what it answers

**Files:**
- Create: `packages/core/src/ai/autopilot-tasks.ts` (+ test), `packages/db/migrations/0084_autopilot_ai_tasks.sql`
- Modify: `packages/core/src/ai/tasks.ts` (`AiTask` gains `"autopilot_first" | "autopilot_reply"`), `apps/api/src/ai/fake.ts`
  (scripted answers), `packages/db/src/schema/ai.ts`

**Interfaces:**
- Consumes: Task 1 `amountsIn`/`unbackedAmounts`/`isStop`; A1 `AiProfile`.
- Produces: `autopilotFirstOutput = z.object({ templateId: z.uuid(), why: z.string().max(200) })`;
  `autopilotReplyOutput = z.object({ kind: z.enum(["reply", "handover", "stop", "converted"]), message:
  z.string().max(1000).nullable(), reason: z.string().max(200), evidence: z.string().max(300).nullable(), fileIds:
  z.array(z.uuid()).max(3), stageId: z.uuid().nullable(), fields: z.record(z.string(), z.string().max(200)),
  followUp: z.object({ at: z.string(), title: z.string().max(80) }).nullable(), lostReasonId: z.uuid().nullable() })`;
  `autopilotInstructions(task, ctx)` (the profile's knows, voice, bot question, never-say lines, the speaker's name and
  business name, the goal; stop and anything risky → stop/handover; never deny being AI); `autopilotInput(task, ctx)`;
  `guardReply(out, ctx: { prices: number[]; fileIds: string[]; leadWords: string; permissions; goalStageIds: string[];
  openStageIds: string[]; lostReasonIds: string[]; fieldKeys: string[] }): GuardedReply` where `GuardedReply =
  { kind: "send"; message; fileIds; updates } | { kind: "ask"; action: AutopilotAction; message; fileIds; updates } |
  { kind: "handover"; reason: string; evidence: string | null } | { kind: "stop" } | { kind: "converted"; reason;
  evidence }`: an unbacked amount → handover "LUME AI wanted to quote a price that isn't in your price list"; a file not
  chosen → dropped; a date or time the lead's own words don't mention → handover "LUME AI wanted to offer a time you
  haven't given it"; an action set to Never → handover naming it; one set to Ask me → `ask`; an update naming a stage,
  field or lost reason that isn't the business's → that update dropped; `isStop` on the lead's words wins over any
  model answer. `FakeProvider.script(task, outputs[])` answers the next calls of that task in order.
- DB: `0084` widens `ai_reads.task`'s check to the two new tasks.

- [ ] **Step 1: Write the failing tests** (`autopilot-tasks.test.ts`): `the instructions carry the business's own
  words and never offer denying it's AI`; **`guards hold`** (a message with "₹15,000" and a list of [380000] →
  handover with those words; a fileId not chosen → dropped; "Shall we say Saturday 4 pm?" when the lead never named
  a day → handover; replies set to Never → handover naming "Reply and keep the conversation going"; mark_lost Ask me
  → ask); `the lead's stop beats the model`; `updates to things the business doesn't have are dropped`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run packages/core/src/ai packages/db/src/schema.test.ts apps/api/src/ai'`. Expected: FAIL.
- [ ] **Step 3: Implement**; the fake's scripted answers sit beside its existing next-step/catch-up ones.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): what LUME AI is asked in a run, and the guards on every answer`.

### Task 3: Do not contact

**Files:**
- Create: `packages/db/migrations/0085_do_not_contact.sql`, `apps/api/src/modules/leads/dnc.ts` (+ test)
- Modify: `packages/db/src/schema/leads.ts`, `apps/api/src/modules/whatsapp/send.ts` (`mayReply`),
  `apps/api/src/modules/whatsapp/template-send.ts` (`sendTemplate`), `apps/api/src/modules/whatsapp/sender.ts`
  (`sendOutbox`: last check before Meta), lead view type and routes, `apps/api/test/probes.ts`

**Interfaces:**
- Produces: `leads.dnc_at timestamptz`, `leads.dnc_by uuid null` (null: LUME AI), `leads.dnc_reason text` (≤ 200);
  `setDoNotContact(req, leadId, { reason, byAi?: { runId } })`, `liftDoNotContact(req, leadId)`; routes
  `POST /api/v1/leads/:id/do-not-contact` (`leads.edit`, `{ reason }`) and `DELETE` (`settings.manage`); activities
  `dnc_set` / `dnc_lifted`; the lead view gains `doNotContact: { at, by, reason } | null`; every send refuses with
  409 `DO_NOT_CONTACT` "{First name} asked not to be messaged. An admin can lift this on the lead."
- [ ] **Step 1: Write the failing tests:** `a reply, a template and a queued message all stop at do not contact`
  (the outbox job marks a queued one failed with those words, Meta never called); `a rep sets it; only an admin lifts
  it`; `it's on the lead's timeline, saying who and why`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/leads/dnc.test.ts apps/api/src/modules/whatsapp packages/db/src/schema.test.ts apps/api/test/matrix.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(leads): do not contact, held by every way LUME sends`.

### Task 4: The number's quality and Meta's tier

**Files:**
- Create: `packages/db/migrations/0086_number_health.sql`
- Modify: `packages/core/src/whatsapp/webhook.ts` (+ test), `apps/api/src/modules/whatsapp/meta.ts` (+ test),
  `apps/api/src/modules/whatsapp/queue.ts` (daily refresh), `apps/api/test/meta-fake.ts`, `packages/db/src/schema/whatsapp.ts`

**Interfaces:**
- Produces: `whatsapp_numbers.quality text check (quality in ('green','yellow','red'))`, `messaging_tier integer null`
  (unique contacts a day: 250, 1000, 10000, 100000; null = unlimited or not read yet), `health_at timestamptz`;
  `readNumberEvents(raw): { phoneNumberId?: string; display: string; quality?: "green" | "yellow" | "red"; tier?:
  number | null }[]` (`phone_number_quality_update`: `event` FLAGGED/UNFLAGGED/DOWNGRADE/UPGRADE, `current_limit`
  TIER_250/TIER_1K/TIER_10K/TIER_100K/TIER_UNLIMITED); `numberHealth(graph, phoneNumberId): Promise<{ quality; tier }>`
  (Graph `GET /{id}?fields=quality_rating,messaging_limit_tier`); `onNumberHealth(pool, numberId, health)` (stores it;
  a drop to yellow or red calls Task 6's `pauseRunsOnNumber(pool, numberId, "quality")` and tells admins once:
  "WhatsApp rated {number} {yellow}. LUME paused LUME AI's runs on it to protect it.").
- [ ] **Step 1: Write the failing tests:** `quality and tier read from Meta's webhook`; `a daily refresh keeps them
  current`; `a drop to yellow pauses the number's runs and tells admins once`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run packages/core/src/whatsapp apps/api/src/modules/whatsapp'`. Expected: FAIL.
- [ ] **Step 3: Implement** (the pause hook is a no-op until Task 6 exports it; Task 6's test covers the call).
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(whatsapp): the number's quality and Meta's tier, kept current`.

### Task 5: Runs: start, estimate, read

**Files:**
- Create: `packages/db/migrations/0087_autopilot.sql`, `packages/db/src/schema/autopilot.ts`,
  `apps/api/src/modules/autopilot/{routes,start,read}.ts` (+ `start.test.ts`, `read.test.ts`)
- Modify: `packages/db/src/schema/index.ts`, `apps/api/src/app.ts` (routes), `apps/api/test/probes.ts`,
  `apps/api/test/rls-coverage.test.ts`

**Interfaces:**
- Consumes: Task 1 states; A1 `mergeAiProfile` (standing choices, permissions, follow-up days); W3b-2 `numberFor`,
  `approvedFor`; A1 `aiStatus` (allowance).
- Produces (DB): `autopilot_runs (id, name, started_by, speaker_id, number_id, goal jsonb, permissions jsonb,
  follow_up_days int[], daily_cap int null, outside_hours text, status, pause_reason, created_at, ended_at)`;
  `autopilot_leads (run_id, lead_id, state, reason text null, active boolean, next_at, first_sent_at, last_sent_at,
  follow_ups_sent int, draft text null, draft_kind text null, fails int, updated_at, PRIMARY KEY (run_id, lead_id))` with
  `UNIQUE (lead_id) WHERE active` (one run per lead); `autopilot_asks (id, run_id, lead_id, action, payload jsonb,
  status waiting/approved/declined/gone, created_at, decided_by, decided_at)`; `autopilot_events (id bigserial, run_id,
  lead_id null, kind, data jsonb, at)` (kept 90 days, by the existing `notifications.retention` job). RLS: lead rows, asks and events with a lead by the lead's visibility (as
  `whatsapp_outbox`); runs visible to every signed-in person who can view leads; written by routes and the job only.
- Produces (API): `POST /api/v1/autopilot/estimate` and `POST /api/v1/autopilot/runs` (both `messages.send_queue`),
  body `{ leadIds (1–500), goal: { kind: "stage"; stageId } | { kind: "reply" } | { kind: "brief"; text (15–600) },
  speakerId | null, permissions, followUpDays, dailyCap | null, remember: boolean }`; estimate returns `{ eligible: n,
  skipped: { leadId, why }[], firstMessages: n, metaCost: { amount, currency } | null, monthShare: number | null }`;
  start refuses in words when LUME AI is off or at its month, WhatsApp isn't connected, the number is yellow/red, or the
  speaker may not message; skips (with why) leads with no WhatsApp number, do not contact, already in a run, or
  marketing off; `remember` saves the standing choices (admins only, else ignored and said). `GET
  /api/v1/autopilot/runs`, `GET /api/v1/autopilot/runs/:id` → `{ run, counts: Record<LeadState, number>, leads: visible
  rows, asks: waiting }`.
- [ ] **Step 1: Write the failing tests:** `the estimate counts, skips with why, costs and shares the month`;
  `a run starts with the business's own goal and permissions`; **`one run per lead, at once`** (two starts in parallel
  over overlapping leads: each lead in one run; the second's skipped list names them); `refusals in words (off, month,
  number yellow, speaker can't message)`; `a rep sees only their leads' rows`; `remember saves standing choices for an
  admin only`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/autopilot packages/db/src/schema.test.ts apps/api/test/rls-coverage.test.ts apps/api/test/matrix.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autopilot): start a run on the business's own setup, one run per lead`.

### Task 6: The engine: write, then send, never after Pause

**Files:**
- Create: `apps/api/src/modules/autopilot/{engine,act,queue}.ts` (+ `engine.test.ts`)
- Modify: `packages/core/src/queues.ts` (`"autopilot.step"`), `apps/api/src/modules/whatsapp/send.ts` and
  `template-send.ts` (extract `queueReply(req, d, o)` / `queueTemplate(req, d, o)` used by both the routes and the run,
  taking `{ via: "lume" | "ai_autopilot"; runId?: string; skipPersonLimiter?: boolean }`),
  `apps/api/src/modules/whatsapp/sender.ts` (`sendOutbox`: an outbox row with `autopilot_run_id` whose run isn't
  running or whose lead isn't LUME AI's any more is marked `cancelled` and never sent), outbox migration in `0087`
  (`autopilot_run_id uuid null`, status `cancelled`), `apps/api/src/modules/whatsapp/thread.ts` (cancelled rows hidden)

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5; `withJobRequest`; `runRead`.
- Produces: `stepRun(deps, runId): Promise<void>` (under `pg_advisory_xact_lock(hashtext('autopilot:' || runId))`; picks
  the next due lead by `next_at`; respects hours, budget and spacing; *write*: one `runRead` as the speaker
  (`autopilot_first` chooses an approved template whose values `paramsFor` fills from the lead, never invented; a lead
  missing values gets another template or is skipped with why; `autopilot_reply` inside 24 hours), guarded by Task 2,
  kept as the lead's `draft`, state `writing`, send step at `now + revealMs(draft)`; *send*: `SELECT … FOR UPDATE` on the
  run, still `running` and the lead still `writing` → `queueTemplate`/`queueReply` as the speaker with `via:
  "ai_autopilot"`, state `sent`/`talking`, updates applied as the speaker; chosen files go as the real file, one
  message each, through W3b-1 `attachLibraryFile` then `queueReply` with its `mediaId`, as the speaker); `pauseRun(req|pool, runId, reason)`,
  `resumeRun`, `endRun`, `pauseRunsOnNumber(pool, numberId, reason)`; a 1-minute sweep queues steps for running runs
  with due leads; AI unavailable by `month` pauses the run (reason month) until the allowance grows; by `hour` waits;
  `failed` three times on a lead → Needs you "LUME AI couldn't write to this lead just now".
- [ ] **Step 1: Write the failing tests:** `first messages go as templates, paced, inside hours`; `a lead missing a
  template's value gets one that doesn't need it, or is skipped with why`; **`pause between commit and the job: nothing
  reaches Meta`** (pause after the send step commits, then run the outbox job: the fake Meta has no call, the row is
  cancelled, the thread doesn't show it); `pause during writing: the draft stays, nothing is sent; resume writes on`;
  `end: nothing more is sent, every lead keeps its state`; `at the month's allowance the run pauses; a top-up resumes
  it`; `the speaker loses messages.send: the run pauses and admins hear`; `a drop to yellow pauses the number's runs`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/autopilot apps/api/src/modules/whatsapp'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS (and the whole WhatsApp suite still green: the extraction
  changes no route's behaviour).
- [ ] **Step 5: Commit** `feat(autopilot): the engine writes, then sends, and nothing goes after Pause`.

### Task 7: Replies, stop, and taking over

**Files:**
- Create: `apps/api/src/modules/autopilot/inbound.ts` (+ `inbound.test.ts`)
- Modify: `apps/api/src/modules/whatsapp/process.ts` (after a lead's message or an echo is stored: `onLeadMessage`,
  `onPersonSent`), `send.ts`/`template-send.ts` (a person's send → `onPersonSent`), `apps/api/src/modules/autopilot/routes.ts`,
  the users disable/offboard path (the speaker leaves → `pauseRun(…, "speaker")`)

**Interfaces:**
- Produces: `onLeadMessage(pool, leadId, activityId)` (in an active run: the lead's words checked by `isStop` first, else
  state `replied`, `next_at` now, or the next working moment when the business chose `wait`; a stop → `setDoNotContact`
  by LUME AI, one short apology inside the window as the speaker ("Sorry for the messages. You won't hear from us again."
  in the profile's voice, the only message a stop allows), state `stopped`); `onPersonSent(pool, leadId, userId)` (a
  person messaging the lead, in LUME or from the phone, takes it: state `with_you`, a draft left as it was);
  routes `POST /api/v1/autopilot/runs/:id/{pause,resume,end}` and `POST /api/v1/autopilot/runs/:id/leads/:leadId/
  {take-over,hand-back}` (starter or `settings.manage`; take-over also for anyone who may message the lead), returning
  the lead's row with its draft.
- [ ] **Step 1: Write the failing tests:** `a reply inside the run is answered inside the 24 hours`; **`stop in other
  words`** ("please don't message me again", "band karo": do not contact, one apology, no later run or person can
  send; an admin lifts it); `outside hours, a reply waits when the business chose wait, and goes when it chose reply any
  time`; `a person's message from the phone takes the lead`; `take over mid-writing keeps the half-written text for
  them; hand back carries on`; `pause from any device pauses everywhere; only the starter or an admin`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/autopilot apps/api/src/modules/whatsapp'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autopilot): replies, stop for good, and taking a lead over`.

### Task 8: Ask me, and Ready for you

**Files:**
- Create: `apps/api/src/modules/autopilot/ready.ts` (+ `ready.test.ts`)
- Modify: `apps/api/src/modules/autopilot/{engine,routes}.ts`, `apps/api/src/modules/notifications/notify.ts` (kinds)

**Interfaces:**
- Produces: a guarded `ask` → `autopilot_asks` waiting, the lead `needs_you` with the ask, one bell notification to the
  starter (`autopilot_ask`: "LUME AI is waiting for you: {action} for {first name}"); `POST
  /api/v1/autopilot/asks/:id/{approve,decline}` (starter or admin; approve sends or applies at once as the speaker,
  decline hands the lead to the starter); `converted` (a move into a goal stage, or the model's judgement with the lead's
  words for a brief) → state `ready` with a card `{ headline, quote }` and a notification (`autopilot_ready`: "{First
  name} {did the goal}. Want to take over?"); handover → `needs_you` with `{ headline: reason, quote: evidence }`;
  `POST /api/v1/autopilot/runs/:id/leads/:leadId/carry-on` (Let LUME AI confirm/answer: back to `talking`, a step now).
  **Hand a lead to a rep** (LUME AI can read no assignment rules beyond the lead's owner): Go ahead, a handover also
  tells the lead's own rep (`autopilot_ready` to the owner as well as the starter); Ask me, the starter is asked first;
  Never, only the starter hears.
- [ ] **Step 1: Write the failing tests:** `an Ask me waits for one tap and then goes at once`; `declined hands the lead
  over`; `a move into the goal stage is converted, with the lead's words`; `a written goal converts on the model's
  judgement with evidence`; `carry on sends LUME AI back to it`; `one notification per ask, to the starter`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/autopilot apps/api/src/modules/notifications'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autopilot): Ask me, and Ready for you with the deal and the lead's own words`.

### Task 9: The live stream

**Files:**
- Modify: `apps/api/src/modules/notifications/hub.ts` (`LISTEN lume_autopilot`), the stream route, `apps/api/src/modules/autopilot/engine.ts`
  (`say(pool, runId, leadId, kind)` after each change: `pg_notify('lume_autopilot', …)`), `apps/web/src/lib/notifications/stream.ts`
  (`autopilot` events to listeners; no screen yet)
- Test: `apps/api/src/modules/autopilot/stream.test.ts`, `apps/web/src/lib/notifications/stream.test.ts`

**Interfaces:**
- Produces: SSE event `autopilot` with `{ run: string; lead: string | null; kind: "state" | "draft" | "sent" | "ask" |
  "ready" | "run" }` (ids and kinds only, never words) to every connected person who may view leads; the screen refetches
  `GET …/runs/:id` or the lead under its own access. `subscribeAutopilot(listener)` in the web stream.
- [ ] **Step 1: Write the failing tests:** `each change is said once on the stream, without words`; `a rep's stream
  never carries a lead's words` (it carries ids only, and the lead row read is refused by RLS for someone else's lead);
  `the web stream passes autopilot events to its listeners`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/autopilot apps/api/src/modules/notifications && cd apps/web && npx vitest run src/lib/notifications'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autopilot): the run, live on LUME's stream`.

### Task 10: End to end through the API, and the gate

**Files:**
- Create: `apps/api/src/modules/autopilot/flow.test.ts`, `docs/runbooks/autopilot.md`
- Modify: `apps/api/test/probes.ts` (every route above), `docs/runbooks/ai.md`

- [ ] **Step 1: Write the flow test** against the fake Meta and the scripted fake AI: an admin estimates and starts a
  run on five leads (one with no number, one in do not contact: skipped with why); first templates go paced inside
  hours; lead A replies "How much for a modular kitchen?" → LUME AI answers from the price list; lead B replies
  "Saturday 4 pm works" → Ready for you (converted) with the quote; lead C replies "please stop" → do not contact, one
  apology, nothing later; the person takes over lead D mid-writing (draft kept), hands back; Pause between commit and
  job sends nothing; the month's allowance pauses the run and a top-up resumes it; the number drops to yellow and the run
  pauses with admins told. Every message is on the lead's thread as sent by LUME AI for the speaker.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/autopilot/flow.test.ts'`.
  Expected: PASS (each piece is built; a failure here is a seam to fix with its own failing test first).
- [ ] **Step 3: Full suites:** typecheck, `pnpm lint` (with `social media/` excluded as the owner's), check-copy, unit
  (all packages, licence), the full web e2e (no screen changes expected: A2 has none). Expected: all green.
- [ ] **Step 4: Write** the runbook (what a run does, the rules it keeps, pausing, do not contact, quality, rulings).
- [ ] **Step 5: Commit** `test(autopilot): every flow end to end through the API; the runbook` and push.
