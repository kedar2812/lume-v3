# Phase 3C — Stage automations, the no-touch alert, working hours, editable presets and System health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Follow-ups start themselves: when a lead enters a stage, or goes quiet, LUME sets the next step, inside working hours. An admin can see that the engine behind it is healthy.

**Architecture:**
- Stage rules live in `stages.on_enter` (already in the schema since 0008, unused). They run **in the same transaction as the stage change**, as the person who made it, through the 3A follow-up service. A rule's own changes never move a stage, so a rule can never trigger another rule.
- The no-touch alert is an API-process job on 3A's tick, like escalation and the digest (3B ruling R1).
- Working hours are the business's (`settings.working_hours`, already in the schema since 0005, unused), read in the business timezone (report §10.2). Shifting applies only to follow-ups LUME creates itself.
- System health reads what already exists (pg-boss tables, `digest_runs`, `source_syncs`, `ops_restore_tests`) plus one new append-only table, `ops_events`, for failures that otherwise leave no trace.

**Tech Stack:** as 3A/3B: Fastify, Drizzle, Postgres 17 with row-level security, pg-boss, Next.js, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-phase-3-follow-ups-design.md` (§2 3C, §3 "Due-time presets", §5 "sweep … System health, 3C, reads it"). Report §10.2 (editable presets, working-hours awareness), §10.4 item 7 (System health), §10.5 (automations). Frontend spec §8.10 ("automation summary line").

## Global Constraints

- The 3A/3B constraints hold: one accent blue; sound only on achievements; names only, never contacts, in anything a notification or email carries; each person's own timezone for times they see; the gate, TDD, CI; full unmasked review copies of every new screenshot (`reviewCopy`).
- LUME is a product for many clients: no stage names, rule texts or preset labels hardcoded as a client's. Seeds stay generic.
- **Every automation is off until an admin sets it**, except those the industry preset seeds for a *new* install (Task 3). An upgrade changes nobody's behaviour.
- A rule never blocks what a person did: a stage move succeeds even when a rule can't do its work. The rule records why in the lead's history.
- Business rules (working hours, the no-touch window) use the business timezone; times shown to a person use theirs.
- Copy speaks as LUME ("LUME set a follow-up…"), never a faceless "we"; no slugs or JSON in the UI.

## Review Focus

1. **A bulk move of 200 leads into a stage with a "set a follow-up" rule:** each lead gets exactly one follow-up; a move into the stage a lead is already in creates none; moving out and back in creates another only when that rule's last one is no longer open.
2. **Working hours across the week and DST:** a rule "in 2 hours" fired at 17:30 on a Friday lands on Monday at the start of the day; a due time inside hours is untouched; Europe/London across the autumn change keeps 09:00 local; saving working hours with no days is refused in words.
3. **A rule whose person can't take it:** "for Riya" when Riya is disabled, or can't see the lead, gives it to the lead's owner instead; with no owner either, nothing is created and the history says why. The move still succeeds.
4. **Editable presets while people are working:** a follow-up sheet opened before an admin removed a preset sends the old id and gets LUME's words back (not a 500); 3A's five preset ids keep working for as long as they're in the list.
5. **The no-touch alert at scale and twice at once:** 10,000 quiet leads are handled 500 per run; a lead with any open follow-up never gets one; two API processes running it at the same moment create one follow-up per lead (advisory lock).

---

### Task 1: Rules and times in `@lume/core`

**Files:**
- Create: `packages/core/src/tasks/rules.ts`, `packages/core/src/tasks/rules.test.ts`
- Modify: `packages/core/src/tasks/time.ts`, `packages/core/src/tasks/time.test.ts`, `packages/core/src/tasks/index.ts`, `packages/core/src/shared.ts` (export the schemas to the web)

**Produces:**
- `type WorkingHours = { days: number[]; start: "HH:MM"; end: "HH:MM" }` (0 = Sunday), and `DEFAULT_WORKING_HOURS = { days: [1,2,3,4,5], start: "09:00", end: "18:00" }`.
- `shiftToWorkingHours(at: Date, wh: WorkingHours, tz: string): Date`: `at` if it falls on a working day within `[start, end)` local; otherwise the next working day's `start` (the same day's `start` when `at` is before it). Uses `wallTime` so DST is right.
- `type DuePresetDef = { id: string; label: string; rule: { in: { n: number; unit: "minute" | "hour" | "day" } } | { at: { days: number; time: "HH:MM" } } | { weekday: { day: number; time: "HH:MM" } } }` (`at.days` 0 = today, 1 = tomorrow; `weekday` = the next such day, never today).
- `DEFAULT_DUE_PRESETS`: exactly 3A's five, with their ids (`in_1h`, `in_3h`, `tomorrow_10`, `in_2d`, `next_monday`) and labels ("In 1 hour", "In 3 hours", "Tomorrow 10:00", "In 2 days", "Next Monday").
- `dueFromPresetDef(def: DuePresetDef, now: Date, tz: string): Date`. `dueFromPreset(id, now, tz)` stays, as `dueFromPresetDef(DEFAULT_DUE_PRESETS[id])`, so nothing in 3A changes.
- `type StageRule = { id: string } & ({ type: "create_task"; title: string; dueIn: { n: number; unit: "hour" | "day" }; assignee: "lead_owner" | { userId: string } } | { type: "cancel_open_tasks" } | { type: "notify"; to: ("lead_owner" | { userId: string })[] })` and `type OnEnter = { rules: StageRule[] }`.
- Zod schemas: `workingHoursSchema` (days: 1–7 unique values 0–6; start < end), `duePresetsSchema` (1–8 presets, unique ids matching `^[a-z0-9_]{1,40}$`, labels 1–40 chars, `in.n` 1–999, `at.days` 0–30), `onEnterSchema` (0–5 rules, unique ids, title 1–200, `dueIn.n` 1–365, `notify.to` 1–10).
- `describeRule(rule, names: Map<string,string>): string` — the plain-language line the stage editor shows ("Sets a follow-up for the lead's owner in 2 days: Send the plan").

- [ ] Write the failing tests:
  - `shiftToWorkingHours`: Friday 17:30 Dubai with 09:00–18:00 Mon–Fri + 2 h → Monday 09:00; 10:00 Tuesday unchanged; 07:00 Tuesday → 09:00 Tuesday; exactly 18:00 → next day 09:00; London on 2026-10-24 (Sat) → Monday 2026-10-26 09:00 **GMT** (after the change); a zone at UTC+5:30.
  - `dueFromPresetDef` for each rule kind in Dubai, Kolkata and London, including `weekday` on the same weekday (a week ahead) and `at` across the spring gap.
  - `dueFromPreset` still returns exactly what 3A's tests expect (run 3A's `time.test.ts` unchanged).
  - the three schemas' refusals (empty days, start ≥ end, duplicate preset ids, six rules, a `notify` with nobody).
  - `describeRule` for each rule kind.
- [ ] Run: `scripts/dev.sh run pnpm vitest run packages/core/src/tasks` — expect FAIL (module not found).
- [ ] Implement; run again — PASS.
- [ ] Commit: `feat(core): working hours, presets you can edit, and stage rules — as data, with their times across DST`.

### Task 2: Data, settings and presets

**Files:**
- Create: `packages/db/migrations/0025_automations_health.sql`
- Modify: `packages/db/src/schema/*.ts` (the new table), `apps/api/src/modules/settings/routes.ts`, `apps/api/src/modules/settings/follow-ups.test.ts`, `apps/api/src/modules/tasks/routes.ts`, `apps/api/src/modules/tasks/service.ts`, the RLS/backup probes the 3A migration 0023 added for new tables

**Interfaces:**
- Consumes: Task 1's schemas and defaults.
- Produces:
  - `ops_events (id bigserial, kind text CHECK (kind ~ '^[a-z_.]{2,40}$'), ok boolean, detail jsonb, at timestamptz DEFAULT now())`, index `(kind, at DESC)`. No lead names or contacts ever go in `detail`. `lume_app` may INSERT and SELECT; the worker deletes rows older than 30 days (add to `packages/core/src/ops/retention.ts`). The backup role reads it (as 0023 did for follow-ups).
  - `readFollowUpSettings(db): Promise<FollowUpSettings>` where `FollowUpSettings = { escalation: { enabled; hours }, noTouch: { enabled: boolean; days: number }, shiftToWorkingHours: boolean, duePresets: DuePresetDef[] }`, merging stored JSON over the defaults (`noTouch: { enabled: false, days: 7 }`, `shiftToWorkingHours: true`, `duePresets: DEFAULT_DUE_PRESETS`).
  - `readWorkingHours(db): Promise<WorkingHours>` (stored `{}` → `DEFAULT_WORKING_HOURS`).
- `PUT /api/v1/settings/follow-ups` takes each section as **optional** and merges it into what's stored, so the 3B screen (which sends only `escalation`) keeps working. `noTouch.days` 1–90. `GET` returns the merged whole.
- `PATCH /api/v1/settings` also takes `workingHours` (`workingHoursSchema`), audited like the rest.
- `GET /api/v1/follow-ups/presets` (`auth.self`): `{ presets: { id, label }[] }` for the follow-up sheet.
- The task routes accept `{ preset: <any id> }` (a string, not 3A's enum). The service resolves it from `readFollowUpSettings`; an unknown id is `400 UNKNOWN_PRESET` "That time choice was just changed. Pick another."
- Tests:
  - the migration: `ops_events` rejects a bad kind; `lume_app` can't UPDATE or DELETE it; the backup role can read it;
  - settings: a PUT with only `escalation` leaves `noTouch` and presets as they were; each section's refusals; audited; `settings.manage` only;
  - working hours: set and read; `{}` reads as the default;
  - presets: `GET` for a rep; a task with `tomorrow_10` still works; a task with a removed id is refused in words; a task with a new custom preset (`{ id: "in_30m", rule: { in: { n: 30, unit: "minute" } } }`) lands 30 minutes out.
- Commit: `feat(api): working hours, presets you can edit, and a place to write down what failed`.

### Task 3: Stage automations

**Files:**
- Create: `apps/api/src/modules/tasks/automations.ts`, `apps/api/src/modules/tasks/automations.test.ts`
- Modify: `apps/api/src/modules/pipelines/routes.ts` + `service.ts` (accept `onEnter`), `apps/api/src/modules/leads/write.ts` (`moveStage`), `apps/api/src/modules/leads/bulk.ts`, the lead create path in `apps/api/src/modules/leads/service.ts`, the intake engine's commit (2A) for new leads, `apps/api/src/modules/pipelines/seed.ts`, `apps/api/src/modules/notifications/notify.ts` (a new kind)

**Interfaces:**
- Consumes: Task 1 (`StageRule`, `onEnterSchema`, `shiftToWorkingHours`), Task 2 (`readFollowUpSettings`, `readWorkingHours`), 3A's task service (`createTask` internals: `schedule`, `refreshNextDue`, the after-commit enqueue), 3B's `notify`.
- Produces: `runOnEnter(req: FastifyRequest, d: AppDeps, lead: { id; name; ownerId }, stage: { id; name; onEnter }, why: "moved" | "created"): Promise<void>`.

**Behaviour:**
- The stage body takes `onEnter: OnEnter` (`pipelines.manage`). Each `userId` in a rule must be an active user, or the save is refused (`400 UNKNOWN_USER`, in words). Audited as `stage.automations`.
- `runOnEnter` runs, in rule order, inside the caller's transaction:
  - `create_task`: the assignee is the lead's owner, or the named person. If the named person is disabled or can't see the lead (3A's `assigneeCanSee`), it goes to the owner. With no owner, nothing is made. The due time is `now + dueIn`, shifted by `shiftToWorkingHours` when the setting is on (business timezone). Reminders: "at the time". `auto_rule_id = rule.id`, `created_by` = the person who moved the lead (null for intake). **Skipped** when the lead already has an open follow-up with this `auto_rule_id` (Review Focus 1). The assignee hears about it through 3B's `follow_up_assigned` only when they aren't the mover.
  - `cancel_open_tasks`: every open follow-up on the lead is cancelled, reminders with them (3A's `cancelLeadTasks` less the lead removal).
  - `notify`: a new kind `lead_stage` ("Aisha Khan moved to Call booked"), to the owner and/or named active people who can see the lead, never to the mover. It follows no alert switch: an admin asked for it (like 3B's escalation ruling).
  - Each rule writes one activity, type `automation`, payload `{ ruleId, rule: <type>, result: "done" | "skipped", reason?, taskId? }`. The lead drawer's history words it: "LUME set a follow-up for Maya: Send the plan", "LUME cancelled 2 open follow-ups", "LUME couldn't set a follow-up: this lead has no owner".
- Where it runs:
  - `moveStage` (single and bulk) after the stage update, only when the stage actually changed;
  - a lead created by a person (`why: "created"`, its first stage);
  - intake (2A engine) for new leads from **webhooks and syncs after a source's first**. CSV imports and a sheet's first sync are history, and set nothing (ruling, cost: an admin who wants follow-ups on an imported batch moves them in bulk).
- Seeds: for **new** installs, each industry preset's Won and Lost stages get one `cancel_open_tasks` rule. Existing installs are untouched (no data migration).
- Tests (`automations.test.ts`, real database):
  - Review Focus 1: a bulk move of 200 leads makes 200 follow-ups in one request; the same move again makes none; out and back while the first is open makes none; after it's done, another;
  - Review Focus 3: disabled person → owner; can't-see → owner; no owner → nothing, history says why, the move still returns 200;
  - Review Focus 2's shift applied (Friday 17:30 → Monday 09:00) and not applied when the setting is off;
  - cancel on Won: open follow-ups and their pending reminders are cancelled; `next_task_due_at` is cleared;
  - notify: reaches the owner, never the mover, never someone who can't see the lead; the title carries no phone or email;
  - a rule never re-triggers: a rule-made follow-up done immediately moves nothing;
  - intake: a webhook lead gets its stage's rule; a CSV import's leads don't;
  - a stage save with an unknown person is refused; with six rules is refused;
  - a new install's Won and Lost stages carry the cancel rule.
- Commit: `feat(api): stages that act — set a follow-up, clear them on a win, tell someone — never in the way of the move`.

### Task 4: The no-touch alert

**Files:**
- Create: `apps/api/src/modules/tasks/no-touch.ts`, `apps/api/src/modules/tasks/no-touch.test.ts`
- Modify: `apps/api/src/modules/tasks/queue.ts`

**Interfaces:**
- Consumes: Task 2 (`readFollowUpSettings`, `readWorkingHours`, `ops_events`), 3A's `schedule` and the enqueue.
- Produces: `NO_TOUCH_RULE_ID` (a fixed uuid constant in `@lume/core`), `noTouch(o: EngineDeps, now?: Date): Promise<number>`.

**Behaviour:**
- Hourly (every 60th tick, and once at start-up after the sweep), under `pg_try_advisory_xact_lock(hashtext('lume.no_touch'))` — a second process skips the run (Review Focus 5).
- Picks up to 500 leads, oldest `last_activity_at` first: in an `open` stage, not deleted, with an active owner, `last_activity_at < now - days`, **no open follow-up at all**, and no follow-up with `auto_rule_id = NO_TOUCH_RULE_ID` created in the last `days` days.
- For each, a follow-up for the owner: title "No contact for {days} days", due now (shifted into working hours when on), "at the time" reminder, `auto_rule_id = NO_TOUCH_RULE_ID`, `created_by` null, and the history line "LUME set a follow-up: no contact for 7 days".
- Writes an `ops_events` row `tasks.no_touch` with `{ created }` when it created any, and `ok: false` with the error message when the run fails.
- Tests: off by default makes none; a quiet lead gets one, once (run twice); a lead with any open follow-up gets none; won/lost stages none; a disabled owner none; 600 quiet leads → 500 then 100; two concurrent runs → one each (two pools, `Promise.all`); the shift applies.
- Commit: `feat(api): a lead that's gone quiet comes back to its owner, inside working hours`.

### Task 5: System health (API) and ops alerts

**Files:**
- Create: `apps/api/src/modules/health/routes.ts`, `apps/api/src/modules/health/service.ts`, `apps/api/src/modules/health/health.test.ts`
- Modify: `apps/api/src/modules/tasks/queue.ts` (expose `lastSweepAt` and record failures), `apps/api/src/modules/tasks/digest.ts` (record a failed send), `apps/api/src/app.ts` (register), the access-matrix test

**Interfaces:**
- Produces: `GET /api/v1/system/health` (`settings.manage`):

```ts
type Health = {
  checkedAt: string;
  followUps: { lastSweepAt: string | null; pending: number; late: number; firedToday: number };
  queue: { waiting: number; active: number; failed24h: number; retrying: number };
  digest: { lastSentAt: string | null; sentToday: number; failures24h: number };
  noTouch: { enabled: boolean; lastRunAt: string | null; createdToday: number };
  sources: { id: string; name: string; kind: string; status: string; lastSyncAt: string | null }[];
  restoreTest: { at: string | null; ok: boolean | null };
  problems: { key: string; words: string }[]; // "late" > 0, no sweep in 5 min, failed jobs, 3 digest failures in a row, a paused source, a restore test that failed or is > 8 days old
};
```

  - `late` = pending reminders with `fire_at < now() - 2 min` (the sweeper should have caught them).
  - `queue` reads `pgboss.job` for LUME's own queue names only.
  - `lastSweepAt` comes from the running queue (3A's `lastSweepAt()`), exposed on the app.
- **Ops alerts:** every 15th tick, `opsAlerts()` turns each current `problems` entry into a `system_alert` notification (and one email) to each active user with `settings.manage`, **once per problem key per business day**, recorded in `ops_events` as `ops.alert` with `{ key }`. A problem that clears and returns the next day alerts again.
- The digest writes `ops_events` `digest.failed` `{ userId }` on a failed send (no names).
- Tests: each number against seeded rows; `late` counts a reminder the sweeper hasn't reached; a rep gets 403; problems in words for each condition; an alert goes once a day per problem, to admins only, never to a rep; the digest failure is recorded and counted.
- Commit: `feat(api): System health — is every reminder firing, every email going, every source syncing — and a word to admins when not`.

### Task 6: The screens for rules, hours and presets

**Files:**
- Create: `apps/web/src/components/settings/StageAutomations.tsx` (+ test), `apps/web/src/components/settings/DuePresetsEditor.tsx` (+ test), `apps/web/src/components/settings/WorkingHours.tsx` (+ test)
- Modify: `apps/web/src/components/settings/PipelineEditor.tsx`, `apps/web/src/components/settings/FollowUpSettings.tsx`, the Business settings form, `apps/web/src/components/tasks/FollowUpSheet.tsx` (+ test), the activity wording in the lead drawer's history, the notification centre's Updates kinds (`lead_stage`, `system_alert`)

**Behaviour (apple-design; frontend spec §8.10):**
- **Pipeline & stages:** each stage row gets its **automation summary line** (from `describeRule`, e.g. "When a lead enters: sets a follow-up in 2 days · tells Maya"), or a quiet "Add an automation". Clicking opens a sheet, "When a lead enters {stage}":
  - rules as cards in order, each with a plain sentence and a remove button; "Add" offers the three kinds;
  - Set a follow-up: title, "in N hours/days", for "the lead's owner" or a person;
  - Clear open follow-ups;
  - Tell someone: the lead's owner and/or people;
  - a line under the sheet: "Runs when a lead moves here, or arrives here from a webhook or a sheet. Imports don't run it.";
  - saves with the stage (the existing optimistic pattern), refused-in-words from the server shown on the card.
- **Settings → Follow-ups:** below escalation, **"Leads gone quiet"** (a switch and "after N days"), **"Keep to working hours"** (a switch, with the hours in words and a link to Business), and **"Time choices"** (`DuePresetsEditor`): the presets as reorderable rows (drag, 1:1), each with a label and its rule in plain words ("in 30 minutes", "tomorrow at 10:00", "next Monday at 09:00"), add and remove, at most 8, at least 1.
- **Settings → Business:** **Working hours**: the seven days as toggles (week starting at `weekStart`) and from/to times, "in {business timezone}".
- **The follow-up sheet** reads `/api/v1/follow-ups/presets` (cached for the page) instead of its fixed chips. On `UNKNOWN_PRESET` it refetches and shows LUME's words.
- **History:** `automation` activities in words (Task 3's lines), with the LUME mark as their avatar.
- **The notification centre:** `lead_stage` and `system_alert` are Updates; `system_alert`'s inline action is "Open System health".
- Tests: the summary line for each rule kind; the sheet adds, orders and removes rules and saves once; the presets editor's limits and wording; working hours refuses no days and start ≥ end before asking the server; the sheet renders custom presets and recovers from `UNKNOWN_PRESET`; the history lines; axe on each new surface.
- Commit: `feat(web): automations on each stage, time choices you set, and your working hours`.

### Task 7: System health (web)

**Files:**
- Create: `apps/web/src/app/(app)/settings/health/page.tsx`, `apps/web/src/components/settings/SystemHealth.tsx` (+ test)
- Modify: the settings areas list (`areas.ts`) and its test

**Behaviour:**
- Settings → **System health** (`settings.manage`), in the Workspace group.
- A headline in words: "Everything is running" (a calm green tick) or "{n} things need a look", listing `problems`, each with what to do ("Open Integrations", "Check the mail settings in .env: SMTP_URL").
- Cards: Follow-up reminders (last check "32 s ago", waiting, late), Background jobs, Morning emails, Leads gone quiet, Sources (each with its last sync), Backups (the last restore test).
- It refreshes every 30 s while visible (pauses when the tab is hidden), with no layout jump (fixed-width numerals).
- Tests: healthy and unhealthy states from fixtures; the refresh pauses when hidden (fake timers + `visibilitychange`); axe.
- Commit: `feat(web): System health — one look says whether LUME is keeping its promises`.

### Task 8: End to end and acceptance

- e2e (`automations.spec.ts`):
  - an admin adds "Set a follow-up in 2 days" to a stage; moving a lead there shows the follow-up in the drawer and the history line;
  - a Won stage clears open follow-ups;
  - a custom time choice appears in the follow-up sheet and sets the right time;
  - System health shows "Everything is running" on the healthy stack;
  - screenshots (and full review copies) of the automation sheet, Follow-ups settings, working hours and System health in both themes; axe.
- The live script `apps/web/e2e-live/acceptance-3c.mjs` (unmasked screenshots in `docs/runbooks/screenshots-3c/`): a stage rule set through the UI, a lead moved, the follow-up present; System health healthy; the chain in `accept-all.sh` gains it after 2C.
- Runbook: a "Phase 3C" section in `docs/runbooks/acceptance.md` in the 3A/3B shape.
- Commit: `test(e2e): stage automations, time choices and System health, end to end`.

## Self-review

- **Coverage:** spec §2 3C: stage automations (Task 3, 6), the no-touch alert (Task 4), working-hours shifting (Tasks 1, 3, 4, 6), editable presets (Tasks 1, 2, 6), System health (Tasks 5, 7). Report §10.4.7's "failed jobs … raise an ops alert to admins by email" is Task 5's ops alerts. Report §10.5's `meeting_reminders` needs calendars and templates (Phases 4–5): out of scope, as the spec says.
- **Placeholders:** none; tests are named with their inputs and expected results (the ledger's standing ruling: the plan describes tests in prose, they are written in full, first).
- **Type consistency:** `StageRule`/`OnEnter`/`onEnterSchema`, `WorkingHours`/`shiftToWorkingHours`, `DuePresetDef`/`DEFAULT_DUE_PRESETS`/`dueFromPresetDef` (Task 1) are the names Tasks 2–6 use; `readFollowUpSettings`/`readWorkingHours` (Task 2) are used by Tasks 3–5; `NO_TOUCH_RULE_ID` (Task 4) by Task 6's history wording.
- **Rulings** (the owner's to overturn):
  - R1. Rules run inside the stage change's transaction, as the mover — not in the worker (the report's "run in the worker" predates 3A's ruling that follow-up work lives in the API). A rule can't loop because no rule moves a stage.
  - R2. Intake runs the first stage's rules for webhooks and live syncs, not CSV imports or a sheet's first sync.
  - R3. New installs seed "clear open follow-ups" on Won and Lost; existing installs are untouched.
  - R4. A rule's follow-up goes to the lead's owner when its named person can't take it.
  - R5. `lead_stage` and `system_alert` follow no alert switch.
  - R6. Working hours are the business's, not each person's (report §10.2).
  - R7. The no-touch alert is off by default (7 days when switched on).
