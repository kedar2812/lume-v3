# Instagram 1B: flows (comment-to-DM and DM automation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A business builds a flow (a vertical list of steps with branches) that a keyword comment, a keyword DM, a story
reply or mention, an ad click or a first message starts; LUME runs it on the conversation inside Meta's rules, once per
step, and shows what each flow and keyword brought.

**Architecture:** The flow is data: an immutable version (JSON steps, validated with Meta's limits) per publish. A pure
interpreter in core turns (version, run state, event) into actions; the API applies actions in one transaction per
step (outbox rows keyed by run + step, lead writes through the normal services) and a pg-boss queue advances runs.
Triggers are matched in `processInstagramEvent` after a delivery is kept. Screens are 1C.

**Tech stack:** as 1A. **Spec:** `docs/NEW_FEATURES_PLAN.md` §4.5, §4.7. **Builds on:** plan 1A (channel, outbox,
sender, window, keywords).

## Global constraints

- Everything from plan 1A's constraints.
- A flow never sends outside `open` (never the human agent tag); a comment-started run sends exactly one private
  reply, then waits for the person to write or tap (Meta: follow-ups only after they respond).
- "Stops a run": someone at the business writing (a send from LUME or an echo from the app), Take over, do not
  contact, the lead deleted, the account disconnected, the flow archived. The lead's own messages advance a run.
- At most one active run per conversation; a trigger never restarts a person inside the flow's cool-down (24 h).
- Every action is keyed `(run_id, step_key)`: a step's job run twice sends once and writes once.
- Base tier: every step except Hand to LUME AI (Phase 3; shown off with why).

## Review focus

1. **A comment flood:** 5,000 keyword comments in an hour on one reel: one private reply each, paced at the account's
   750/hour (default 600), none twice, none after its 7 days; the rest wait.
2. **Overlapping triggers:** a DM that matches two flows' keywords, and a person already in a run: the higher priority
   flow only; no second run.
3. **A Wait across the window:** a 23-hour Wait after the person's last message ends the run with words when the
   window would close first; a Wait never sends after `open`.
4. **A version published while runs are mid-way:** running conversations finish on their version; new ones start on
   the new one; archiving stops runs with words.
5. **Unexpected answers:** a question waiting for an email gets "hi": the fallback once, then hand to a person; within
   30 seconds (Meta's automated-experience rule).

---

### Task 1: Flow model and interpreter (core, pure)

**Files:** `packages/core/src/instagram/flows.ts`, `flows.test.ts`; export from `index.ts`.

**Interfaces (produces):**
- `FlowStep` (zod, discriminated on `type`, each with a stable `id`): `send {text, quickReplies?, buttons?, mediaUrl?}`,
  `ask {text, save: {field: string, kind: "text"|"email"|"phone"|"number"|"choice"}, choices?, fallback}`,
  `condition {when: {on: "field"|"answer"|"tag", key, op: "is"|"contains"|"empty"|"not_empty", value?}, then: FlowStep[],
  else: FlowStep[]}`, `tag {tagId, add: boolean}`, `stage {stageId}`, `assign {to: {mode:"user",userId}|{mode:"round_robin",
  userIds}|{mode:"source"}}`, `wait {minutes: 1..10080}`, `handoff {to: "person"|"ai", note?}`, `book {text, link: "calendly"|
  "url", url?}`.
- `validateFlow(steps): string[]` — words; checks every message with `messageProblems`, ids unique, depth ≤ 5, ≤ 50
  steps, at least one step, no `handoff ai` unless allowed, every `ask` field key given.
- `RunState = { at: string | null (step id next), waiting: null | {for: "answer", stepId} | {for: "any"} | {for: "until",
  until: ISO}, answers: Record<string,string>, sent: number }`.
- `FlowEvent = {kind:"start", via:"comment"|"dm"|"story"|"ad"|"welcome"} | {kind:"message", text, payload?} |
  {kind:"timer", now} `.
- `stepRun(steps, state, event, ctx: {now, window: IgWindow, privateReplyOnly: boolean, lead: {tags, fields}}):
  {state, actions: FlowAction[], done?: {reason}}` where `FlowAction` = `send {stepKey, message, asPrivateReply}` |
  `saveField` | `tag` | `stage` | `assign` | `handoff` | `wait {until}`.

- [ ] Tests first (`flows.test.ts`): linear send→ask→condition→book; the answer saved typed (an email lower-cased, a bad
  email → fallback once, then handoff); a comment start sends only the first send as a private reply and waits `any`;
  a tap payload `step:<id>:<choice>` picks the branch; a Wait inside the window → `wait` action; a Wait past the window
  → done "Instagram's time to reply would run out first"; condition on tag/field/answer, each op; nested branches to
  depth 5; a step id missing after a version change → done with words; never more than 20 sends in one run (a loop
  can't exist, but a long flow is capped); `validateFlow` on each Meta limit and on duplicates.
- [ ] Mutation: remove the window check before a send action → red; let a comment start send two messages → red.

### Task 2: Tables (migration 0123)

`instagram_flows (id, name, status draft|live|paused|archived, live_version_id, priority, created_by, timestamps)`,
`instagram_flow_versions (flow_id, version, steps jsonb, created_by, created_at; UNIQUE(flow_id, version); a trigger
refuses UPDATE)`, `instagram_triggers (flow_id, account_id null, kind comment|dm|story_reply|story_mention|ad|welcome,
keywords text[], mode word|exact|any, media_ids text[], ad_ids text[], public_replies text[], cooldown_hours, enabled)`,
`instagram_flow_runs (version_id, thread_id, lead_id, status running|waiting|done|stopped|handed|failed, state jsonb,
next_at, reason, started_by, timestamps; partial UNIQUE(thread_id) WHERE status IN ('running','waiting'))`,
`instagram_flow_events (bigserial, flow_id, version_id, trigger_id, keyword, kind triggered|private_reply|dm_sent|
replied|lead_created|call_booked, lead_id, at)`; `instagram_accounts.automated_note text` (default "You're chatting
with an automated assistant. Reply PERSON to reach the team."). RLS: flows/versions/triggers configuration (exempt,
reached by `instagram.flows.manage` routes); runs and events by their lead. Permission `instagram.flows.manage` in the
catalog (Admin gets it; Sales doesn't).

### Task 3: Flows API

CRUD + publish (validate, new version, `live_version_id`), pause, archive (stops runs with words), duplicate, the four
templates (generic fictional copy), triggers CRUD with conflicts reported (the same keyword on two live flows for one
account: refused with which flow has it), all audited. Tests per route, permission matrix, two admins publishing at
once (one version each, both kept, the later live).

### Task 4: Starting runs

In `processInstagramEvent`, after a message/comment/referral is kept: `matchTrigger` (priority, then oldest; keyword via
`matchKeyword`; media/ad filters) → if the thread has no active run, isn't taken over, the lead isn't do not contact and
the cool-down allows: create the lead if needed (comment), insert the run (`ON CONFLICT` on the partial unique → no
second run), the public reply (random from the list, via the Graph, best effort, once per comment), and queue the
first step. A message from the person in an active run advances it instead. Echo / LUME send / Take over / DNC stop
runs (status stopped, reason). Tests: each trigger kind; two flows matching; a person in a run; take over mid-run; the
comment flood (5,000 comments, scale bar) with the private-reply pace.

### Task 5: Running steps

`instagram.flow.step` queue + minute sweep for due Waits: load run (FOR UPDATE), `stepRun`, apply actions in one
transaction: outbox rows `(flow_run_id, step_key)` with user = the account's `run_as`, lead writes via `updateLead`,
`addTag`, stage move, assign, notify for handoff; events rows for analytics. Tests: a worker running a step twice → one
send; a Wait due while the window closed → done with words; a version archived mid-run → stopped; DNC between steps.

### Task 6: Analytics and the gate

Per flow and per keyword: triggered, private replies, DMs, replies, leads, calls booked (meetings on the lead after the
run), won (stage history) — nightly rollup into `instagram_flow_daily`; `GET /api/v1/instagram/flows/:id/stats?from&to`
(business time zone). Then the full gate, a fresh reviewer, fixes, push.


## Addendum (owner, 2026-11-22): Instagram profile photos on leads

- Read `profile_pic` with the existing profile read (graph.ts `profile`: fields `name,username,is_user_follow_business`
  + `profile_pic`). Meta returns it only for people who have messaged the business; comment, mention and story-only
  people get none until they write. Some people's privacy settings return none too.
- The URL is a signed CDN link that expires: fetch it once through the existing Meta-host-only, no-token media fetch,
  store the image on this server (size cap, image types only), serve LUME's own copy. Never hotlink Meta's URL.
- Refresh when the person writes again and the stored copy is older than 7 days; drop it when Meta returns none.
- Deleted with the lead, and by `lume_instagram_forget` (Meta's data deletion request).
- Shown wherever a lead's initials show today (drawer, lists, Pipeline cards, Who replied); initials stay the
  fallback. Same visibility as the lead's name. WhatsApp's API has no profile photos.
- Tests first: photo stored and served; expired/foreign-host URL refused; none returned -> initials; refresh after 7
  days only; deleted with the lead and by forget; masked users see the photo exactly when they see the name.
