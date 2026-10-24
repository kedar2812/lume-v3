# Autopilot A3: the Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person starts LUME AI on a selection of leads from a sheet that names their own setup, then watches the run
live on a new Autopilot page (the lead it's on, what it's thinking, the message typing itself, the send), pauses with
Esc, takes over any lead by starting to type, and picks up converted and stuck leads from Ready for you, as cleanly on a
phone as on a computer.

**Architecture:** Two small server additions (a sheet-setup read with each action's availability; the live fields a run
view needs: the draft being written and a one-line thought), then the web: a typed client and a `useRun` hook that
refetches under the person's own access whenever the existing stream says the run changed, the start sheet (reusing
Settings → LUME AI's permission rows), and the Autopilot page in three columns on a computer and two tabs on a phone.
The run lives on the server (A2): the screen only reads and asks; every rule is enforced by the API.

**Tech Stack:** Next.js 16, React, motion, lucide-react, CSS modules, Vitest + Testing Library, Playwright + axe;
Fastify, Drizzle, Postgres (RLS).

**Spec:** `docs/superpowers/specs/2026-10-19-lume-ai-autopilot-design.md` §1, §2, §3 (what the screens show), §4 (the
paused-by-month state), §7, §9 (approved 2026-10-20). Mockups: `.superpowers/brainstorm/881-1792422345/content/`
`autopilot-start-v4.html` (start sheet, phone run) and `autopilot-live-v3.html` (live page). A2's ledger rulings stand.

**Process:** `docs/QUALITY_PROCESS.md` governs every task (edge-case sheet, test first, mutation check on guards, full
gate on the box, review). UI work also follows the apple-design skill.

## Global Constraints

- Nothing client-specific (CLAUDE.md): every list (goals, stages, people, fields, templates, files) comes from the
  business's setup; test and e2e words are fictional.
- Copy speaks as LUME, plain words, no em dashes, no over-promising; numbers never "1 2 3" as step markers (icons).
- Porcelain and Obsidian, the one accent blue `#2A5BFF`; LUME AI's mark is The Loop (`AiGlyph`), never a gradient.
- Motion: LUME's spring tokens (`SPRINGS`, `toMotion`), interruptible, reduced-motion equivalents; popups dim and blur
  the whole window (full scrim); every data screen has a loading bar and skeletons.
- Sounds only on achievements (a lead reaching the goal may use the existing achievement sound; nothing else).
- Phone width 375 px: no horizontal scroll, controls in thumb reach, 44 px targets.
- Server is the authority: the screen never decides what LUME AI may do; it shows the API's refusals in words.
- New routes in `apps/api/test/probes.ts`; migrations from 0091; nothing deployed; nothing on the demo.

## Rulings made writing this plan (the owner can overrule)

- **The island's "Let LUME AI handle these" shows whenever LUME AI is on for the person and they may message many
  leads (`messages.send_queue`).** Anything else missing (WhatsApp not connected, replying from LUME off, no approved
  templates, the month used) is explained inside the sheet with a link to fix it, so a new user learns what Autopilot
  needs instead of wondering where it is. Cost if wrong: one condition.
- **"All that match" selections work up to 500 leads:** the start body accepts the bulk actions' selection and the
  server resolves it as bulk runs do; above 500 the sheet says "A run takes up to 500 leads. Narrow the filter." Cost if
  wrong: small.
- **An action the business can't use is forced to Never on the server** (not only shown off): Send files with no files
  chosen, Answer price questions with no price list, Mark a lead lost with no lost reasons, Book meetings (A2 ruling),
  Send first messages with no approved template (then the run can't start: the sheet says why). Cost if wrong: none.
- **The thought line is LUME AI's own one-line reason** (`why` / `reason` from the model, max 200), stored on the lead
  while it's being worked; LUME never makes one up. Before the model answers, the screen says "Reading <first name>'s
  messages" or "Choosing an approved template". Cost if wrong: one column.
- **Esc pauses only on the Autopilot page**, only for someone who may pause, and never while focus is in a text box or a
  dialog is open (Esc closes that first). Cost if wrong: none.
- **Take over by typing:** focusing the live composer of a lead LUME AI is working calls take-over first; the draft
  becomes the person's text in the ordinary WhatsApp composer. A person who may not message that lead sees no composer.
- **The Autopilot nav item** shows for people who may view leads while LUME AI is on for the business, or when any run
  exists; its "Live" pill shows while a run they can see is running.
- **E2E speed:** the fake AI's default reply reads the lead's latest words ("works for me" → converted with those words
  as evidence; "price" → handover); the e2e number is on Meta's unlimited tier and the business's hours cover the whole
  day, so a two-lead run finishes inside a test without any test-only pacing knob.

## Review Focus

1. Pause pressed while a message is visibly typing: the typing freezes where it is, the veil says "Paused. Nothing is
   sent until you resume.", and the message never appears in the thread. Test: Task 6 e2e "pause mid-typing".
2. The person clicks into a lead's composer while LUME AI is typing to that lead: the half-typed text is theirs to edit,
   the lead shows With you, other leads carry on. Test: Task 6 "take over by typing".
3. Two tabs (or a phone and a computer) on the same run: pausing in one shows Paused in the other within the stream's
   reach, and a dropped stream reconnects and refetches. Test: Task 3 `useRun` "refetches on reconnect" + Task 9 e2e
   "two pages".
4. A rep who can see only some of the run's leads opens the run: counts and leads are only theirs, no draft or thought
   of a lead they can't see leaks, and Pause/End aren't offered. Test: Task 2 "a rep sees only their leads' live
   fields", Task 6 "rep sees no controls".
5. The run reaches its end, or every lead is waiting on a person: the page says so in words ("Waiting for replies",
   "Done: 12 messaged, 3 ready for you") instead of a mark drawing forever. Test: Task 6 "states in words".

---

### Task 1: What the start sheet needs, from the server

**Files:**
- Create: `apps/api/src/modules/autopilot/setup.ts`, `apps/api/src/modules/autopilot/setup.test.ts`
- Modify: `apps/api/src/modules/autopilot/routes.ts`, `apps/api/src/modules/autopilot/start.ts`,
  `apps/api/src/modules/leads/bulk-runs.ts` (export `resolveSelection`), `apps/api/test/probes.ts`

**Interfaces:**
- Produces: `GET /api/v1/autopilot/setup` (`messages.send_queue`) →
  ```ts
  type AutopilotSetup = {
    ready: { ok: true } | { ok: false; code: "AI_OFF" | "AI_MONTH" | "REPLY_OFF" | "NO_NUMBER" | "NUMBER_QUALITY" | "NO_TEMPLATES"; message: string; fixHref: string | null };
    goals: { kind: "stage"; stageId: string; name: string }[];   // the business's goal stages, in pipeline order
    speakers: { id: string; name: string }[];
    standing: { permissions: Record<AutopilotAction, Allow>; followUpDays: number[]; dailyCap: number | null; speaker: string | null };
    available: Record<AutopilotAction, { ok: true } | { ok: false; why: string; fixHref: string | null }>;
    hours: { line: string };            // "Monday to Saturday, 10 am to 7 pm" from Settings → Follow-ups
    number: { display: string; tierLimit: number | "unlimited" | null } | null;
    canRemember: boolean;               // settings.manage
  };
  ```
- Produces: `runBody` gains `selection?: { filters: Record<string,string>; except: string[]; expected: number }` (exactly
  one of `leadIds` / `selection`); resolved to at most 500 ids, else 400 `TOO_MANY` "A run takes up to 500 leads.
  Narrow the filter."
- Produces: start and estimate force unavailable actions to `never` (from the same `available`).

- [ ] **Step 1: Write the failing tests** in `setup.test.ts`: setup for an admin with everything connected (`ready.ok`,
  goals named from stages, speakers only people who may send); each `ready` refusal in its own test with its exact
  words and `fixHref` (`/settings/integrations`, `/settings/integrations/whatsapp`, `/templates`); availability rows
  (no files → `send_files` off "Choose the files LUME AI may send in Settings → LUME AI"; empty price list →
  `answer_prices` off "Add your price list in Settings → LUME AI"; no lost reasons → `mark_lost` off; `book_meetings`
  off "Needs a calendar LUME can book into"); a rep gets 403 without `messages.send_queue`; start with
  `send_files: "go"` and no files stores `never`; a filter selection of 3 matching starts 3; 501 matching → 400.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/autopilot/setup.test.ts'`.
  Expected: FAIL (route 404, `setup` not defined).
- [ ] **Step 3: Implement `autopilotSetup(req, d): Promise<AutopilotSetup>`** in `setup.ts`, reusing `check`'s readiness
  checks (refactor them out of `start.ts` into one `readiness(req, d)` both call) and `openStages`, `speakers`,
  `filesOf`, the profile, `tierLimitOf`; `hoursLine(wh)` in core words (`packages/core/src/words/`) with its own test.
- [ ] **Step 4: Run** the step 2 command, then `npx vitest run apps/api/src/modules/autopilot apps/api/test/probes`.
  Expected: PASS.
- [ ] **Step 5: Commit** `feat(autopilot): what the start sheet needs, and actions the business can't use stay off`.

### Task 2: The live fields a run view needs

**Files:**
- Create: `packages/db/migrations/0091_autopilot_thought.sql`
- Modify: `packages/db/src/schema/autopilot.ts`, `apps/api/src/modules/autopilot/engine.ts`,
  `apps/api/src/modules/autopilot/read.ts`, tests `read.test.ts` (create), `engine.test.ts`

**Interfaces:**
- Produces: `autopilot_leads.thought text` (≤200, null when not being worked); the engine sets it from the model's
  `why`/`reason` at each write, and clears it when the lead leaves the active states.
- Produces: `getRun` leads gain `phone` (masked as the leads list masks it), `thought: string | null`,
  `draft: { text: string; kind: "template" | "reply"; templateName: string | null; revealedBy: string } | null`
  (only while `writing`; `revealedBy` = the lead's `nextAt`), and `run.canControl: boolean` (starter or
  `settings.manage`). `listRuns` adds `running: number` (runs with status running this person can see).

- [ ] **Step 1: Failing tests** (`read.test.ts`): a writing lead returns its draft, kind, template name and thought; a
  sent lead returns `draft: null`; a rep who can't see a lead gets neither its row nor its draft (RLS); `canControl`
  true for the starter and an admin, false for a rep; the engine stores the model's reason as `thought` and clears it on
  Ready. Migration under `rls-coverage` (no new table; column only) and schema drift test.
- [ ] **Step 2: Run** `npx vitest run apps/api/src/modules/autopilot/read.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the column, the engine writes (`writeTemplate`: `why`; `writeReply`: `reason`), and the
  read fields.
- [ ] **Step 4: Run** autopilot + db schema tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(autopilot): the live view's fields: the message being written, and why`.

### Task 3: The web client and `useRun`

**Files:**
- Create: `apps/web/src/lib/autopilot/types.ts`, `client.ts`, `use-run.ts`, `use-run.test.tsx`, `reveal.ts`,
  `reveal.test.ts`
- Modify: `apps/web/src/lib/notifications/stream.ts` (export `onAutopilot(listener)` if not yet exported)

**Interfaces:**
- Produces: `autopilotClient = { setup, estimate(body), start(body), runs(), run(id), pause(id), resume(id), end(id),
  takeOver(id, leadId), handBack(id, leadId), carryOn(id, leadId), approve(askId), decline(askId) }`, each returning the
  app's `ApiResult<T>`.
- Produces: `useRun(id): { data: RunDetail | null; loading: boolean; problem: string | null; refresh(): void }`: fetches
  once, refetches on any autopilot event for this run (coalesced: at most one request in flight, one queued), on the
  stream reconnecting, and when the tab becomes visible again; ignores answers that arrive out of order.
- Produces: `useLiveRuns(): number` (runs running) for the nav pill, refreshed on autopilot events.
- Produces: `revealed(text, startedAt, revealedBy, now): string`: how much of a draft shows now, by word boundary,
  whole once `now >= revealedBy`; frozen text when paused is the caller's (pass the pause time as `now`).

- [ ] **Step 1: Failing tests:** `useRun` coalesces 10 events into at most 2 requests; drops a stale answer that lands
  after a newer one; refetches on reconnect and on `visibilitychange`; `revealed` at 0%, half (never mid-word), 100%,
  and when `revealedBy` is already past.
- [ ] **Step 2: Run** `npx vitest run apps/web/src/lib/autopilot`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Autopilot's client, and a run that follows the stream`.

### Task 4: Permission rows shared by Settings and the sheet

**Files:**
- Create: `apps/web/src/components/autopilot/PermissionRows.tsx`, `PermissionRows.test.tsx`
- Modify: `apps/web/src/components/settings/ai/StandingSection.tsx` (uses it), its tests stay green

**Interfaces:**
- Produces: `<PermissionRows value onChange stages available? />`: the three groups (Messages, Pipeline, Careful), the
  presets (Careful, Balanced, Hands-off; unpressed when a row is changed by hand), each row a three-way control (Go
  ahead, Ask me, Never), full width under its action below 640 px; an unavailable row is shown off with its `why` and a
  link, its control disabled at Never. The "Always on" line (Stop means stop; never invents a price, date or promise).

- [ ] **Step 1: Failing tests:** presets set every row; a hand change unpresses; an unavailable row is disabled with
  its words and link; keyboard: arrow keys move within a three-way control (radio group semantics).
- [ ] **Step 2: Run** the web tests for `components/autopilot` and `components/settings/ai`. Expected: FAIL (new file).
- [ ] **Step 3: Implement** by moving the rows out of `StandingSection` (behaviour unchanged there).
- [ ] **Step 4: Run** both. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(web): LUME AI's permission rows, one component for Settings and the start sheet`.

### Task 5: The start sheet, from the island

**Files:**
- Create: `apps/web/src/components/autopilot/StartSheet.tsx`, `StartSheet.test.tsx`, `GoalPicker.tsx`,
  `GoalPicker.test.tsx`, `autopilot.module.css`
- Modify: `apps/web/src/components/leads/island/Island.tsx` (+ test)

**Interfaces:**
- Consumes: Task 1 `AutopilotSetup`, Task 3 client, Task 4 `PermissionRows`.
- Produces: `<StartSheet selection onClose onStarted(run) />`, a right sheet on a computer and a bottom sheet on a
  phone (the app's sheet pattern, full scrim, focus trapped, Esc closes).

Contents, top to bottom (spec §1, mockup `autopilot-start-v4.html`): title "Let LUME AI handle N leads"; when
`ready.ok` is false, a single explaining card in place of the form ("LUME AI needs a connected WhatsApp number to
work. Connect one in Settings → Integrations." with the link) and nothing else; the goal (ready-made goals as chips,
"Get a reply", "+ Write your own": 600-character box, hint "A good brief says the outcome, the offer and the tone",
"Use an example", Confirm off under 15 characters, the locked card "Your goal is locked in. LUME AI writes from this."
with Edit); Speaks as (people from `speakers`, default the standing speaker or the person); When (the hours line and
"Up to N a day", editable); the permission rows; "Use these every time" (admins only); the estimate line ("50 first
messages · about ₹43 to Meta · uses about 6% of this month's LUME AI", refreshed 400 ms after a change, skeleton while
it loads) and "N skipped" which opens the list with each reason; Start the run (off with its reason in words:
"Confirm your goal to start the run"). On Start: the LUME AI mark draws once, the sheet closes, the island says "LUME
AI is on 1 of N. Watch it live." linking to `/autopilot?run=<id>`. An API refusal shows in the sheet in its words.

- [ ] **Step 1: Failing tests:** each state above (not ready; goal confirm gating; locked card and Edit; estimate debounce
  and skipped reasons; Start sends exactly the body the API takes, `selection` for a filter selection; refusal shown;
  remember only for admins); Island shows the action only with `messages.send_queue` and LUME AI on.
- [ ] **Step 2: Run** the component tests. Expected: FAIL.
- [ ] **Step 3: Implement** (apple-design: the sheet rises from the island's button side; three-way controls slide
  their thumb with a spring; the mark's stroke draws with `pathLength`; reduced motion fades).
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): start LUME AI on a selection, with the goal, the voice and what it may do`.

### Task 6: The Autopilot page on a computer

**Files:**
- Create: `apps/web/src/app/(app)/autopilot/page.tsx`, `apps/web/src/components/autopilot/AutopilotScreen.tsx`,
  `RunBar.tsx`, `LeadList.tsx`, `LiveConversation.tsx`, `TypingComposer.tsx`, tests for each, `live.module.css`
- Modify: `apps/web/src/components/shell/nav.ts`, `icons.tsx`, `Sidebar.tsx` (+ tests) for the nav item and "Live" pill

**Interfaces:**
- Consumes: Task 2 fields, Task 3 `useRun`/`revealed`, the existing `WhatsAppThread` and `WhatsAppComposer`.
- Produces: `/autopilot` (newest running run, else the newest; `?run=` picks one; a run switcher lists the 50 newest).

Layout (spec §2, mockup `autopilot-live-v3.html`): the run bar (the mark drawing like a pen while working, resting when
paused or done; name; status in words: "LUME AI is working" / "Paused" / "Paused: this month's allowance is used" with
Ask for a top-up for admins / "Waiting for replies" / "Done"; goal, voice, hours and cap in one line; a progress ring;
counts Messaged, Replied, Ready for you, Stopped with `Odometer` bumps; "N waiting for you" opening the Ask queue;
Pause (Esc) / Resume and End run with a confirm dialog "End this run? Nothing more is sent. Every lead keeps its
conversation."; controls only when `canControl`); the leads column (every lead with its state chip, the current one on
the blue rail, skipped ones folded at the end with their reasons); the live conversation (the thread, the thought line,
the typing composer revealing the draft with template variables highlighted and "Approved template · <name>", the
bubble lifting into the thread on send, ticks following; "Back to LUME AI's lead" when viewing another lead; for a
lead With you, the person's own composer and "Hand back to LUME AI"); the Paused
veil. Empty page (no runs): what Autopilot does in three short lines with icons and "Select leads, then Let LUME AI
handle these" linking to Leads. Loading bar and skeletons.

- [ ] **Step 1: Failing tests:** each status in words (Review Focus 5); Esc pauses only when allowed and not in a text
  box; Pause freezes the reveal (Review Focus 1); focusing the composer of the current lead calls take-over and the draft
  becomes editable (Review Focus 2); viewing another lead keeps following the run; a rep sees no controls (Review
  Focus 4); End asks first; the nav pill shows with a running run.
- [ ] **Step 2: Run** the component tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Autopilot, watch LUME AI work live, pause with Esc, take over by typing`.

### Task 7: Ready for you, and Ask me

**Files:**
- Create: `apps/web/src/components/autopilot/ReadyColumn.tsx`, `ReadyCard.tsx`, `AskQueue.tsx`, tests
- Modify: `AutopilotScreen.tsx`

**Interfaces:**
- Consumes: run leads in `ready` / `needs_you` with `card`, `asks` from `getRun`, Task 3 client.

Converted and Needs you groups with counts and a badge on the heading; each card: the lead, the deal in one large line
(the card's headline), the lead's own words as a quote, Take over and Let LUME AI carry on (full width); a new card
arrives with a short ring of its colour and a dark-glass toast ("<Name> reached <goal>. Want to take over?" from the
card, never invented); the run's rules folded below. The Ask queue: each waiting item says what LUME AI wants to do in
words (the message, the files by name, the stage move) with Send / Do it and Hand to me; approving sends at once.

- [ ] **Step 1: Failing tests:** grouping and counts; Take over / Carry on call the API and the card leaves; the toast
  only for a card that arrived while watching (not on first load); an Ask shows its action in words and approving it
  calls approve once (double click safe).
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): Ready for you, with the deal and the lead's own words, and Ask me in one tap`.

### Task 8: On a phone

**Files:**
- Create: `apps/web/src/components/autopilot/PhoneRun.tsx`, test
- Modify: `AutopilotScreen.tsx`, `live.module.css`

Below 768 px (spec §2.3): the run card (mark, name, "LUME AI is on 7 of 50", Pause), the four counts, the current
lead's conversation with LUME AI typing, a bottom bar with Live and Ready (with its count); a converted lead drops in as
a banner from the top with Take over; the start sheet is a bottom sheet with presets as three compact buttons and
Confirm and Start within thumb reach.

- [ ] **Step 1: Failing tests:** tabs switch; the banner shows for a new Ready card and Take over works from it; Pause
  reachable.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(web): Autopilot on a phone, one lead at a time, Pause always in reach`.

### Task 9: End to end, and the gate

**Files:**
- Create: `apps/web/e2e/autopilot.spec.ts`
- Modify: `apps/api/src/ai/fake.ts` (the keyword replies, with a unit test), e2e setup as needed (fake Meta tier
  unlimited, hours all day)

- [ ] **Step 1: Write the spec** (desktop and phone projects, Porcelain and Obsidian, axe on every state): start a run on
  three leads from the island (one skipped with its reason); watch the first message type and send; a lead replies
  "Saturday works for me" through the fake Meta webhook → Ready for you card with that quote and a toast; Pause while a
  reply is typing → veil, nothing sent after; Resume; take over by clicking the composer → With you, text editable;
  Hand back; End run asks first; two pages on the same run: Pause in one shows in the other; a rep's view has no
  controls; screenshots reviewed (`reviewCopy`, unmasked).
- [ ] **Step 2: Run** the spec alone, then prove each person-path test fails without its code (mutation check: remove
  the pause freeze, the take-over call, the canControl check, one at a time).
- [ ] **Step 3: Full gate** per `docs/QUALITY_PROCESS.md` §4 (typecheck, lint, prettier, names, copy, unit, full e2e with
  baselines refreshed only in the full run and every changed image looked at).
- [ ] **Step 4: Walk it** on the dev stack at 375 px and desktop in both themes, Esc, keyboard only, reduced motion.
- [ ] **Step 5: Commit** `test(autopilot): every screen flow end to end, on a computer and a phone` and push.
