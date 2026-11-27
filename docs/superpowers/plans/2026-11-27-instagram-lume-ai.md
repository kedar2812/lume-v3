# LUME AI on Instagram (Part E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** LUME AI answers Instagram DMs as it answers WhatsApp: when a flow hands a person to it, when an account's
"Who answers new DMs" is LUME AI, or when the team chooses "Let LUME AI handle these"; inside Instagram's 24 hours
only; one driver per conversation; a person always wins.

**Spec:** `docs/superpowers/specs/2026-11-22-instagram-lume-ai-design.md` (proposed under the owner's go-ahead
2026-11-22; the owner's "build all the remaining features too" 2026-11-26 covers it). Builds on the Autopilot engine
(`apps/api/src/modules/autopilot/engine.ts`) and the Instagram channel (`modules/instagram/*`).

**Architecture:** a LUME AI run gains a **channel**. WhatsApp runs are unchanged. An Instagram run belongs to one
connected account (`autopilot_runs.instagram_account_id`, `number_id` null), never starts a conversation and never
follows up: the engine's Instagram move is `reply` while the person's window is open and unanswered, and `handover`
once it closed unanswered (to a person, with the day and time the human agent's 7 days end). Each account has one
**standing run**, "New DMs on @account" (created on first need, pausable like any run), holding the leads that its
"Who answers new DMs" or a flow's Hand to LUME AI gave it; a lead can carry its own goal (a flow step's), else the
run's. Sends go through `sendInstagram` marked LUME AI's (`instagram_outbox.autopilot_run_id`), never with the human
agent tag. Inbound DMs follow the spec's rule table in `process.ts`.

**Tech:** as the repo (Fastify, Drizzle, Postgres RLS, Next.js). No new dependency.

## Global Constraints

- One driver: taken over by a person > a LUME AI run holds the lead > a flow running > a flow's trigger > "Who
  answers new DMs: LUME AI" with the window open > the team. Each row wins over those below (spec §2).
- LUME AI on Instagram: never the human_agent tag, never a private reply, never a first message, never after the
  window (24 h; 7 days after an ad's first message). Text at most 1,000 bytes; quick replies at most 13, titles at most
  20 characters (Instagram's limits, `IG_LIMITS`).
- Handover words: "Instagram's 24 hours ran out. A person can still answer until {weekday, Month day, h:mm am}."
- A person typing takes over at once: the lead leaves LUME AI's hands ("You took over"), nothing more is sent; Hand
  back returns it to LUME AI when its run still holds it, else to the team.
- Default "Who answers new DMs" is Your team. LUME AI off, the plan without replies, or the month's AI leads used up:
  the choice shows off with the reason, and the account falls back to the team.
- Counting: an Instagram conversation LUME AI takes counts toward the same monthly AI leads as WhatsApp.
- Copy speaks as LUME, no em dashes, no "we", no guessed pronouns. Icons from `components/ui/icons.tsx`.
- Nothing deployed without the owner's OK.

## Edge-case sheet

| Input | Expected |
|---|---|
| DM on a lead a person took over | nothing automated; LUME AI's run (if any) not woken |
| DM while LUME AI holds the lead, a flow's keyword in it | LUME AI answers (row 2 beats row 4) |
| Flow's Hand to LUME AI, lead already in a WhatsApp LUME AI run | the flow ends; the lead stays in its run (one run per lead), told in the flow's numbers as handed |
| Hand to LUME AI twice (event replayed) | one lead row, one start |
| Window closes while LUME AI is writing | the draft is dropped, the lead handed over with the reason |
| Ad referral: 7-day window | LUME AI may answer for 7 days from the first message |
| Account disconnected / needs attention | the standing run pauses ("number" reason words for Instagram) |
| Who answers = LUME AI, LUME AI switched off | falls back to the team, the card says why |
| Month's AI leads used up | new DMs to the team; leads already held go on (as WhatsApp) |
| Stop in any language | do not contact, out of the run, the one apology only inside the window |
| Two DMs in one second | one reply (the engine's lock per run) |
| A reply over 1,000 bytes from the model | rewritten shorter, or handed over; never cut mid-word or sent over |
| Person types while LUME AI's draft is revealing | the draft never goes |
| Hand back after the window closed | to the team, not LUME AI (it can't answer) |
| Many accounts | one standing run each |
| Scale: 5,000 DMs an hour on one account | the engine paces as WhatsApp's reply path; no per-DM full scans |

## Review Focus

1. LUME AI must never send on Instagram outside the window or with the human agent tag.
2. Two drivers must never answer the same DM (flow + AI, AI + person).
3. A hand-off replayed or raced must start exactly one AI conversation.
4. A WhatsApp run's behaviour must not change at all (the channel branch).
5. The standing run's goal and a lead's own goal: the right one decides "goal reached".

---

### Task 1: Data and core

**Files:** migration `0138_instagram_lume_ai.sql`: `autopilot_runs.channel text NOT NULL DEFAULT 'whatsapp'`
(check in 'whatsapp','instagram'), `instagram_account_id uuid`, `standing boolean NOT NULL DEFAULT false`, `number_id`
nullable with a check (whatsapp ⇒ number_id, instagram ⇒ instagram_account_id), unique standing run per account;
`autopilot_leads.goal jsonb` (a lead's own goal); `instagram_accounts.new_dms text NOT NULL DEFAULT 'team'`;
`instagram_outbox.autopilot_run_id uuid`. Schema files. Core `packages/core/src/ai/autopilot.ts`:
`nextMoveInstagram(l, { now, window }): { kind: "reply" } | { kind: "handover"; until: Date | null } | { kind: "wait" }`.
Tests: core unit tests for every branch; a migration test that WhatsApp runs read as before.

### Task 2: The engine's Instagram branch

**Files:** `autopilot/engine.ts` (`step` branches on `run.channel`: account check instead of number, no templates, no
pacing budget, `nextMoveInstagram`; `writeReply` passes the channel's limits to the writer; `sendStep` sends with
`sendInstagram(..., { auto: { runId } })`), `instagram/send.ts` (`auto` marks the outbox row, refuses the human agent
tag for it, refuses outside the window), the writer's prompt (`ai/` reply writer: channel limits), `lead-events.ts`
(`leadWrote` takes the channel's stop words reason).
Tests: `autopilot/instagram.test.ts`: answers inside the window; hands over after it with the words; never the tag;
1,000-byte limit; stop; paused account.

### Task 3: Who answers (inbound routing)

**Files:** `instagram/process.ts` (the rule table after the stop check), `instagram/ai-intake.ts` (new:
`standingRun(req, accountId)`, `giveToAi(req, d, { accountId, leadId, threadId, goal })`), `instagram/flow-run.ts`
(Hand to LUME AI calls `giveToAi` with the step's goal), `instagram/send.ts` (a person's send takes the lead out of
LUME AI's hands), take over / hand back.
Tests: the rule table row by row; replayed hand-off starts one; take over mid-AI sends nothing more; hand back.

### Task 4: Settings and starting

**Files:** Instagram card ("Who answers new DMs" per account, off with reasons), Settings → LUME AI (Instagram's
standing goal), `PATCH /api/v1/instagram/accounts/:id` (`newDms`), Who replied's "Let LUME AI handle these" for
Instagram leads (skips with why: window closed, held by a run), the flow builder offering Hand to LUME AI (goal
picker), the LUME AI page showing each run's channel and "New DMs on @account".
Tests: API (who may, plan without replies, fallback), web (card, builder, Who replied).

### Task 5: The drawer and Analytics

**Files:** Instagram tab's driver chip (Flow: name · LUME AI · You · Your team) with Take over / Hand back; LUME AI's
messages "LUME AI for {speaker}"; Analytics → Instagram "Who answered" card (flows, LUME AI, team: conversations,
leads, calls booked, won, median first answer).
Tests: chip in every state; analytics counts on fixtures; scale budget run for the card.

## Rulings (2026-11-27, while building)

- Row 2 ("a LUME AI run holds this lead") counts only a run working this conversation: an Instagram run on this
  account. A lead a WhatsApp run holds who DMs on Instagram is never answered from WhatsApp; flows still step aside
  for any run's lead (one run per lead). A person's send moves only the run in that app to With you.
- LUME AI's goal for new DMs is set on the Instagram card, beside Who answers new DMs, not in Settings → LUME AI:
  every Instagram choice in one place, still no second AI page. Cost if wrong: the block moves.
- An answered Instagram conversation is looked at when Instagram's 24 hours end and then let go (inactive), so the
  never-ending standing run never holds a lead for good (review C1). Needs you, Ready and With you stay held until a
  person acts, as on WhatsApp.
- The month's AI leads used up: an Instagram lead is handed to a person at once (waiting would let the 24 hours pass).
- A flow's Hand to LUME AI after its own message, or before they've written (a comment flow): LUME AI waits for them
  to write, never a second answer.
- The standing run speaks as the account's person (else whoever connected it); a lead that person may not message is
  the team's, and the speaker follows a change of the account's person.
- Layered guards (no separate mutant): the sender's takeover check for LUME AI rows (the claim statement repeats it);
  giveToAi's taken-over check on the inbound path (process.ts checks first). No files are offered to LUME AI on
  Instagram, so the files mutant is equivalent.

## Review minors, fixed after the push (2026-11-27 evening)

Edge cases, each with its test (and a mutant):

| Minor | The case | What happens now | Test |
|---|---|---|---|
| M4 | Standing run paused (account, a person, the speaker, the month) | The card says paused, why, the team answers meanwhile, and links the run; paused for the account ("number") carries on with the next message on the account (someone new, or someone it holds, a tap too) once the account is active, Instagram on, in the plan; two at once both count; any other pause stands | ai-routing "paused because the account", "still needs attention", "their choice stands"; ai-settings "as the card shows it"; InstagramCard "run paused"; words "names Instagram" |
| M3 | LUME AI's row passes the checks, then the run pauses or a person takes over before the claim | Looked at once more at once (no second slot of the account's pace): cancelled with why, the next row to them woken (no 2-minute wait for the sweep) | autopilot/instagram "being taken" |
| M5 | A yes near 1,000 bytes that books a call with a Meet link | Room kept for the Meet line (64 bytes): handed to a person before booking, never a failed send after | core limits "igReplyFits" |
| M6 | A tap on a button while LUME AI's run holds the conversation | LUME AI's run hears that they wrote (the button's words reach it from the conversation; a tap is never read as a stop), flows step aside, as for a DM | ai-routing "tap on a button" |
| M7 | Meta's answer to LUME AI's send was lost (IG_MAYBE_SENT), then its echo arrives | LUME AI's own lost DM on that thread, the same words, within a day: marked sent with Meta's id, never a person's reply; a flow's or a person's lost one, other words, or older than a day: a person's reply as ever | ai-routing "answer was lost" |

Rulings:
- M8 isn't a bug and stays as it was: a lead is in one run at a time, so someone an Instagram run holds who said stop on
  WhatsApp got no apology there (the WhatsApp run filter saw none); their stop on Instagram gets the one apology. A first
  fix took that one away; the second review caught it, and it was undone.
- M4's two at once (two messages after a reconnect both reading the run paused): the one whose resume takes no row reads
  the run again and carries on if it's running; not tested (a race).
- M6's held-before-flow guard is layered: the flow already refuses a lead any run holds (its mutant survives).
- M1 (the flow's hand-off to LUME AI after commit) stays: closing it moves giveToAi into the flow's transaction, a
  larger change for a crash window of milliseconds; a lost hand-off leaves the lead with the team, never unanswered by
  rule. Cost if wrong: a rare lead the team answers instead of LUME AI.
- M5's engine wiring (`c.calls?.meet && guarded.updates.meeting`) isn't exercised end to end (no Instagram Meet
  harness); the rule is core's, tested. Cost if wrong: today's behaviour (the lead to a person after booking).
- M7's echo leaves the send uncounted in Analytics (counting needs the sender's actor in the event job). Cost if
  wrong: one send missing from the numbers.
- Found while there: an Instagram run's "number" pause read "the WhatsApp number isn't connected"; it says the
  Instagram account now.

