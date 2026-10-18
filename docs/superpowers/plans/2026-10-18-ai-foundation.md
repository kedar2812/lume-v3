# LUME AI, part 1: foundation, call notes → next step, catch-up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship LUME's first AI, behind a switch and Claude-style hourly and weekly limits: a suggested next step from a call note, and a three-line catch-up on a lead — with no Meta dependency.

**Architecture:** Pure task definitions (input shaping, output schemas, rules) live in `@lume/core`; the API owns one `AiProvider` plug (Anthropic and Google adapters plus a fake), a reads service that enforces the switch, the plan and the hourly and weekly limits, and writes one `ai_reads` row per call; the web shows one suggestion card and one catch-up card. The plan claim grows `ai`/`whatsapp` modules and `aiReadsHourly`/`aiReadsWeekly`, signed only for a LUME that accepts `plan2`.

**Tech Stack:** TypeScript, Fastify, Drizzle + Postgres (RLS), zod, Next.js (App Router), vitest, Playwright; `@anthropic-ai/sdk`, `@google/genai`.

**Spec:** `docs/superpowers/specs/2026-10-18-whatsapp-replies-ai-design.md` (§0, §2, §5.2–5.4, §6.3–6.4, UI rule). Parts D–F (WhatsApp) get their own plan.

## Global Constraints

- A suggestion is never applied without a tap; nothing is sent to a lead. (§5.4)
- The AI reads only facts from the lead's record and the business's own settings; never a phone, email, web address or Instagram handle (same exclusion as `contextFor`, `apps/api/src/modules/leads/sending.ts`). (§5.4)
- With the AI switch off, the plan leaving `ai` out, no provider configured, or a limit reached: no AI call is made and LUME works exactly as today. (§0, §2.2)
- AI switch: Settings → Integrations → "LUME AI", off by default, admins (`integrations.manage`) only. Copy says the text of notes is sent to the AI provider to be read and isn't used to train it. (§2.2)
- Limits: plan `aiReadsHourly` (rolling 60 minutes) and `aiReadsWeekly` (resets Monday 00:00 on the business's clock), null = no limit; one successful AI call = one read, per business. At a limit, AI pauses until it resets and every place a suggestion would appear says which limit and when it's back ("LUME AI has reached this hour's limit. It's back at 3:40 pm." / "LUME AI has reached this week's limit. It's back Monday."). Admins: one bell notice at 75% and one at 90% of the week, one when either limit is reached. Coming back is silent. (§2.2)
- Provider, model and key come only from `.env` (`LUME_AI_PROVIDER` = `anthropic` | `google` | `fake`, `LUME_AI_MODEL`, `LUME_AI_KEY`); no model is hard-coded. The model is chosen by the eval (Task 11). (§2.1, §6.2)
- `ai_reads` rows hold no message text from the lead's record beyond the structured result; never in logs, exports, health or check-ins. (§2.3, §6.3)
- Older licence servers / older LUMEs keep working: `ai` and `whatsapp` absent from a plan = included; `plan2` keys signed only when the LUME lists `accepts: ["plan2"]`. (§2.2)
- UI rule (verbatim): "Super simple and predictable: the patterns people already know … one card with one primary button ("Apply") and a quiet "Dismiss" … Every control keyboard-reachable with a visible focus ring, labelled for screen readers, 4.5:1 contrast in Porcelain and Obsidian, 44 px touch targets, reduced motion respected. A canvas is drawn for the new screens before they're built."
- LUME's voice ("LUME …", never "we"); Prettier + `pnpm lint` clean; `node scripts/check-client-names.mjs` clean; commits straight to `main`.

## Review Focus

1. **Provider returns ids that aren't the business's** (a stage or tag id made up or from another list) → dropped server-side before the suggestion is shown; the rest of the suggestion stands. (Task 6 test "drops ids the business doesn't have")
2. **A follow-up time in the past or unreadable** ("call me Thursday" read on Friday) → no follow-up part; never a task due in the past. (Task 6 test "never suggests a follow-up in the past")
3. **Two Applies at once / Apply after the lead changed** (stage moved by someone else, lead version stale) → the apply re-reads the lead, applies what's still valid, and says what it skipped; a second Apply of the same read is refused (409). (Task 6 tests)
4. **Provider slow or down** → the read fails after 20 s, isn't counted against the limits, and the card says "LUME couldn't read this note just now" once; the call/note itself is already saved. (Task 5 test)
5. **A rep without access to the lead, or a lead deleted between read and apply** → 404 on read and apply (RLS + `visibleLead`); no suggestion leaks across leads. (Task 6 test)

---

### Task 1: Config and the AI task definitions in core

**Files:**
- Modify: `packages/config/src/schema.ts` (add the three env vars beside `LUME_FX_*`)
- Create: `packages/core/src/ai/tasks.ts`, `packages/core/src/ai/index.ts`; export from `packages/core/src/index.ts`
- Test: `packages/core/src/ai/tasks.test.ts`, `packages/config/src/schema.test.ts` (extend)

**Interfaces:**
- Produces:
  - config: `LUME_AI_PROVIDER: "anthropic" | "google" | "fake" | undefined`, `LUME_AI_MODEL?: string`, `LUME_AI_KEY?: string` (provider other than `fake` requires both model and key, else config error).
  - `type AiTask = "next_step" | "catch_up"`.
  - `type LeadFacts = { firstName: string; stage: { id: string; name: string }; stages: { id: string; name: string; kind: "open" | "won" | "lost" }[]; lostReasons: { id: string; label: string }[]; tags: { id: string; label: string }[]; fields: { label: string; value: string }[]; history: { at: string; kind: "note" | "call" | "stage" | "follow_up"; text: string }[]; timezone: string; now: string }` (ISO strings; history newest last, at most 20 items, at most 4,000 characters in total — trimmed oldest first).
  - `nextStepOutput` (zod, strict): `{ summary: string(1..140), stageId: string | null, followUp: { at: string /* local "YYYY-MM-DDTHH:mm" on the business clock */, title: string(1..80) } | null, lostReasonId: string | null, tagIds: string[] (max 3), decisionMaker: string(1..60) | null }`.
  - `catchUpOutput` (zod, strict): `{ lines: [string, string, string] }`, each 1..160 chars.
  - `instructionsFor(task: AiTask): string` — fixed instructions per task carrying §5.4's rules (only facts given; never invent prices, dates, offers or urgency; pick ids only from the lists given; null when unsure; plain English).
  - `inputFor(task: AiTask, facts: LeadFacts, note?: string): string` — the user content: facts as compact JSON plus the note.
  - Ruling: spec §5.2's "objections from a list the business can edit" are the business's own tags (Settings → Tags), so no new list is needed.
  - `cleanNextStep(out: NextStep, facts: LeadFacts): NextStep` — drops a `stageId`, `lostReasonId` or tag id not in the lists, drops `lostReasonId` unless the stage is a lost stage, drops a `followUp` whose time is not after `facts.now` on the business clock.

- [ ] **Step 1: Write the failing tests** — `tasks.test.ts`:
  - `"never asks for contacts"`: `inputFor("next_step", facts, "note")` contains no `+971`, `@`, `http` when `facts.fields` had none (and LeadFacts has no contact keys by type).
  - `"drops ids the business doesn't have"`: `cleanNextStep({...stageId: "x", tagIds: ["t1","nope"], lostReasonId: "r1"}, facts)` → `stageId: null`, `tagIds: ["t1"]`, `lostReasonId: null` (stage not lost).
  - `"never suggests a follow-up in the past"`: facts.now `2026-10-18T10:00:00+04:00`, timezone `Asia/Dubai`, followUp.at `"2026-10-18T09:30"` → `followUp: null`; `"2026-10-18T11:00"` kept.
  - `"trims history to 20 items and 4,000 characters, oldest first"`.
  - schema tests: `nextStepOutput` rejects an extra key and a 141-char summary; `catchUpOutput` rejects two lines.
  - config: `LUME_AI_PROVIDER=anthropic` without `LUME_AI_KEY` fails; `fake` alone passes; unset passes.
- [ ] **Step 2: Run** `bash scripts/dev.sh run pnpm exec vitest run packages/core/src/ai packages/config` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the types, schemas and the three functions in `packages/core/src/ai/tasks.ts`; config vars in `schema.ts` with a `superRefine` for the key/model rule. Business-clock comparison uses the existing timezone helpers in `@lume/core` (as follow-up presets do).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): LUME AI's tasks — next step and catch-up, their rules and schemas`

### Task 2: The plan grows `ai`, `whatsapp` and Claude-style AI limits (licence server + LUME)

**Files:**
- Modify: `packages/core/src/licence/fleet.ts` (`PLAN_MODULES`, `planClaimSchema`, `ACCEPTS`), `packages/core/src/licence/plan.test.ts`
- Modify: `apps/licence/src/server/plan.ts`, `apps/licence/src/server/check.ts`, `apps/licence/src/server/clients.ts` (`planSchema`, `patchPlan`, `getClient`), `apps/licence/src/components/PlanLimits.tsx`
- Create: `apps/licence/migrations/0008_ai_reads.sql`
- Modify: `apps/api/src/licence/plan.ts` (`MODULE_NAMES`, `AUDIT_NAMES`, `modulesOn`)
- Test: `apps/licence/src/server/plan.test.ts`, `apps/licence/src/components/plan.test.tsx`, `apps/api/src/licence/plan.test.ts`

**Interfaces:**
- Produces:
  - `PLAN_MODULES = ["googleSheets", "webhooks", "googleCalendar", "calendly", "ai", "whatsapp"] as const`.
  - `planClaimSchema`: `places`, `modules` with the four existing keys required and `ai?`, `whatsapp?` optional booleans, `aiReadsHourly?: number | null` (int 1..100,000) and `aiReadsWeekly?: number | null` (int 1..1,000,000). Strict.
  - `ACCEPTS = ["announcements", "plan", "plan2"]`.
  - Licence server: `licences.ai_reads_hourly integer NULL CHECK (ai_reads_hourly BETWEEN 1 AND 100000)` and `licences.ai_reads_weekly integer NULL CHECK (ai_reads_weekly BETWEEN 1 AND 1000000)`; `planOf(l, { v2: boolean })` → v2 adds `ai`, `whatsapp`, `aiReadsHourly`, `aiReadsWeekly`; `check.ts` passes `v2: b.accepts?.includes("plan2")`.
  - `modulesOn`: `ai` from `settings.integrations.ai.enabled`; `whatsapp` always false in this plan.
  - Dashboard Plan limits card: two more module rows ("LUME AI", "WhatsApp") and two number fields "AI reads an hour" and "AI reads a week" (empty = no limit), same patterns as Places.

- [ ] **Step 1: Write the failing tests**:
  - core: `"a plan without ai or whatsapp parses, and they count as included"`; `"aiReadsHourly 0 and aiReadsWeekly 0 are refused"`.
  - licence: `"signs ai, whatsapp and the AI limits only for a LUME that accepts plan2"` (accepts `["plan"]` → payload `plan.modules` has exactly the four keys, no AI limits); `patchPlan` stores both limits and records it in the client's history event.
  - licence UI: the card shows both fields and saves `{ aiReadsHourly: 100, aiReadsWeekly: 750 }`.
  - api: `applyPlan` switches `ai` off once when the plan leaves it out (audit row `module: "ai"`), and `modulesOn` reports `ai` when on.
- [ ] **Step 2: Run** `bash scripts/dev.sh run pnpm exec vitest run packages/core/src/licence apps/licence apps/api/src/licence` — Expected: FAIL.
- [ ] **Step 3: Implement** as in Interfaces; migration `0008_ai_reads.sql` with the column and its comment.
- [ ] **Step 4: Run** the same — Expected: PASS; also `pnpm --filter @lume/licence exec playwright test` (panel spec) green.
- [ ] **Step 5: Commit** `feat(licence): plans carry LUME AI, WhatsApp and hourly and weekly AI limits (plan2)`

### Task 3: `ai_reads` table and the AI switch's storage

**Files:**
- Create: `packages/db/migrations/0068_ai_reads.sql`, `packages/db/src/schema/ai.ts`; export in `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/identity.ts` (`integrations` type gains `ai?: { enabled: boolean }`)
- Test: `packages/db/src/schema.drift.test.ts` (existing, must stay green), the RLS coverage test (`rls-coverage.test`, add the table)

**Interfaces:**
- Produces table `ai_reads`: `id uuid pk`, `lead_id uuid not null`, `user_id uuid not null`, `task text check in ('next_step','catch_up')`, `source_activity_id uuid null`, `provider text`, `model text`, `input_tokens int`, `output_tokens int`, `status text check in ('ok','failed')`, `result jsonb null` (the cleaned output), `outcome text null check in ('applied','dismissed')`, `outcome_by uuid null`, `outcome_at timestamptz null`, `created_at timestamptz default now()`. Index `(created_at)` and `(lead_id, created_at desc)`. RLS like `activities` (read/insert where the lead is visible; update of `outcome*` columns only, same condition). Grants to `lume_app` as activities have.
- Drizzle `schema.aiReads`.

- [ ] **Step 1: Write the failing test** — RLS: a rep who can't see the lead reads 0 rows of its `ai_reads` (add to the existing RLS harness test for activities, `apps/api/test/rls*.test.ts` pattern).
- [ ] **Step 2: Run** `bash scripts/dev.sh run pnpm exec vitest run packages/db apps/api/test/rls` — Expected: FAIL (relation does not exist).
- [ ] **Step 3: Implement** migration + Drizzle table + coverage entry.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): ai_reads — one row per AI read, visible with its lead`

### Task 4: The provider plug (Anthropic, Google, fake)

**Files:**
- Create: `apps/api/src/ai/provider.ts`, `apps/api/src/ai/anthropic.ts`, `apps/api/src/ai/google.ts`, `apps/api/src/ai/fake.ts`
- Modify: `apps/api/src/app.ts` (`AppDeps.ai?: AiProvider | null`), `apps/api/src/main.ts` (build from config), `apps/api/package.json` (`@anthropic-ai/sdk`, `@google/genai`), `apps/web/e2e/api-server.mjs` (`LUME_AI_PROVIDER: "fake"`)
- Test: `apps/api/src/ai/provider.test.ts`

**Interfaces:**
- Produces:
  - `interface AiProvider { name: string; model: string; read<T>(o: { instructions: string; input: string; schema: z.ZodType<T>; maxOutputTokens: number; signal: AbortSignal }): Promise<{ output: T; inputTokens: number; outputTokens: number }> }` — throws `AiUnreadable` when the reply doesn't validate, any other error on transport failure.
  - `anthropicProvider({ apiKey, model, baseURL? })`: Messages API with structured output (`output_config: { format: json_schema }` from the zod schema via `z.toJSONSchema`), no streaming, `max_tokens` = `maxOutputTokens`. Read the bundled claude-api skill's `typescript/claude-api/README.md` before writing it; don't guess SDK calls.
  - `googleProvider({ apiKey, model, baseURL? })`: `@google/genai` `models.generateContent` with `responseMimeType: "application/json"` and `responseSchema` from the zod schema. Check the SDK's current README for names before writing.
  - `fakeProvider(answers?: Partial<Record<AiTask, unknown>>)`: returns the given answer (or a fixed valid default per task), tokens 100/30; used in tests and e2e.
  - `providerFromConfig(cfg): AiProvider | null` (null when `LUME_AI_PROVIDER` unset).
- [ ] **Step 1: Write the failing tests** — both real adapters against a local `http.createServer` stub passed as `baseURL`: `"sends the instructions, the input and the schema, and reads the JSON back"` (assert request body carries the model and a JSON schema; response parsed into the zod type, tokens from usage); `"an answer that doesn't match the schema is AiUnreadable"`; `"an aborted read rejects"`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run pnpm exec vitest run apps/api/src/ai` — Expected: FAIL.
- [ ] **Step 3: Implement** the four files and the wiring.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): one plug for LUME AI — Anthropic, Google and a fake`

### Task 5: The AI switch, the hourly and weekly limits, and the reads service

**Files:**
- Create: `apps/api/src/modules/ai/service.ts`, `apps/api/src/modules/ai/routes.ts`; register in `apps/api/src/app.ts`
- Modify: `apps/api/src/modules/sheets/service.ts` (`integrationsView` includes `ai: { on, configured, inPlan }`)
- Test: `apps/api/src/modules/ai/ai.test.ts`

**Interfaces:**
- Consumes: `AiProvider` (Task 4), `instructionsFor`/`inputFor` and schemas (Task 1), `assertModule` (`apps/api/src/licence/plan.ts`), `schema.aiReads` (Task 3), `notify` (notifications).
- Produces:
  - `type AiLimit = { used: number; limit: number | null; resetsAt: string /* ISO */ }`.
  - `GET /api/v1/ai` (any signed-in person) → `{ on: boolean, hour: AiLimit, week: AiLimit, paused: null | { by: "hour" | "week"; until: string } }`. Hour: `used` = ok reads in the last 60 minutes, `resetsAt` = oldest of them + 60 minutes (now + 60 minutes when none). Week: `used` = ok reads since Monday 00:00 business clock, `resetsAt` = next Monday 00:00.
  - `POST /api/v1/integrations/ai { enabled: boolean }` (`integrations.manage`) → refuses `enabled: true` with 409 `PLAN_MODULE` when left out, 409 `AI_NOT_CONFIGURED` when no provider; audit `integration.enabled|disabled` with `module: "ai"`.
  - `runRead<T>(req, d, o: { task: AiTask; leadId: string; sourceActivityId?: string; instructions: string; input: string; schema: z.ZodType<T>; maxOutputTokens: number }): Promise<{ id: string; output: T } | { unavailable: "off" | "not_configured" | "failed" } | { unavailable: "limit"; by: "hour" | "week"; until: string }>` — checks switch, plan and both limits (counted under an advisory lock so two reads at the last slot can't both pass), calls the provider with a 20 s `AbortSignal.timeout`, writes the row (`ok` or `failed`; `failed` not counted), then sends admin notices (`system_alert`): once per week each "LUME AI has used 75% of this week's reads" and "…90%…", and once per window when a limit is reached: "LUME AI has reached this hour's limit. It's back at 3:40 pm." / "LUME AI has reached this week's limit. It's back Monday." (business clock and format).
- [ ] **Step 1: Write the failing tests** (`ai.test.ts`, harness + `fakeProvider`): `"off by default: no read, nothing written"`; `"refuses to switch on when the plan leaves it out"`; `"the hourly limit rolls: at 2 an hour the third read waits until the first is an hour old"` (third → `{unavailable:"limit", by:"hour", until: first+60m}`; move `h.clock` 61 minutes → ok); `"the weekly limit resets Monday 00:00 on the business's clock"` (Asia/Kolkata; Sunday 23:59 refused, Monday 00:00 ok); `"failed reads aren't counted"`; `"two reads at the last slot: only one passes"`; `"a provider that hangs fails after 20 s and isn't counted"` (fake timers); `"tells admins once at 75%, once at 90%, once at the limit"` (no repeat on the next read); `"GET /ai says this hour's and this week's use and when each resets"`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run pnpm exec vitest run apps/api/src/modules/ai` — Expected: FAIL.
- [ ] **Step 3: Implement** service and routes.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): the LUME AI switch, its hourly and weekly limits and one row per read`

### Task 6: Next step from a call note — read, apply, dismiss

**Files:**
- Create: `apps/api/src/modules/ai/facts.ts` (`leadFacts(req, lead): Promise<LeadFacts>`), `apps/api/src/modules/ai/next-step.ts`
- Modify: `apps/api/src/modules/ai/routes.ts`
- Test: `apps/api/src/modules/ai/next-step.test.ts`

**Interfaces:**
- Consumes: `runRead` (Task 5), `cleanNextStep` (Task 1), `visibleLead`, `moveStage` (`leads/write.ts`), `createTask(req, d, leadId, { title, due: { at } })` (`tasks/service.ts`), `updateLead(req, id, expectedVersion, { tagIds })` (`leads/service.ts`), `addNote` for the decision-maker line.
- Produces:
  - `POST /api/v1/leads/:id/ai/next-step { activityId: uuid }` (`leads.edit` on the lead) → `{ read: { id, suggestion: NextStep } } | { unavailable }`; the activity must be this lead's `note` or `call_logged` with text.
  - `POST /api/v1/ai/reads/:id/apply { stage: boolean, followUp: boolean, tags: boolean }` → applies the chosen parts in one transaction, as the person; returns `{ applied: string[], skipped: { part: string; why: string }[] }`; marks `outcome='applied'`. Second apply → 409 `ALREADY_DONE`.
  - `POST /api/v1/ai/reads/:id/dismiss` → `outcome='dismissed'`.
  - Applied parts write their normal activities with `via: "ai_suggestion"` in the payload (spec §2.3): `moveStage` and `createTask` gain an optional `via?: "ai_suggestion"` that only lands in the activity payload.
  - `leadFacts` builds `LeadFacts` only from visible, non-contact fields (reuse `contextFor`'s field filter), stages of the lead's pipeline, lost reasons, tags, the last 20 notes/calls/stage moves/follow-ups, the business timezone and `d.clock()`.
- [ ] **Step 1: Write the failing tests**: `"reads a call note into a suggestion the business can apply"` (fake returns stage "Site visit booked" id, follow-up tomorrow 11:00, tag id → GET shape); `"drops ids the business doesn't have"` (fake returns a foreign stage id → `stageId: null`); `"never suggests a follow-up in the past"`; `"apply moves the stage, sets the follow-up and adds the tag, as the person"` (activity rows written, task due at 11:00 business time); `"apply after someone else moved the stage applies the rest and says what it skipped"`; `"a second apply is refused"`; `"a rep who can't see the lead gets 404 for read and apply"`; `"no contacts reach the provider"` (fake records its input; assert no phone/email of the seeded lead).
- [ ] **Step 2: Run** `bash scripts/dev.sh run pnpm exec vitest run apps/api/src/modules/ai` — Expected: FAIL.
- [ ] **Step 3: Implement** `facts.ts`, `next-step.ts`, routes.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): LUME AI reads a call note into a next step, applied with one tap`

### Task 7: Catch-up summary

**Files:**
- Create: `apps/api/src/modules/ai/catch-up.ts`
- Modify: `apps/api/src/modules/ai/routes.ts`
- Test: `apps/api/src/modules/ai/catch-up.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/leads/:id/ai` → `{ offerCatchUp: boolean, pending: { id, suggestion: NextStep, from: { activityId, at } } | null }`. `offerCatchUp` when AI is available to this person and either the lead's owner changed to this person within the last 7 days or `last_activity_at` is 14+ days ago.
  - `POST /api/v1/leads/:id/ai/catch-up` → `{ read: { id, lines: [string, string, string] } } | { unavailable }`. On request only.
- [ ] **Step 1: Write the failing tests**: `"offers a catch-up after a reassignment to me, and after 14 quiet days"`, `"not when AI is off"`, `"returns three lines from the fake"`, `"pending shows the latest suggestion not yet applied or dismissed"`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): Catch me up — three lines on a lead, on request`

### Task 8: Canvas (owner approval gate before any UI)

**Files:** a claude.ai artifact canvas (apple-design skill; LUME's real chrome as earlier canvases).

- [ ] **Step 1:** Draw, in Porcelain and Obsidian, desktop and phone: (a) Integrations → "LUME AI" card (switch, one line on what's sent and that it isn't used for training, "Not in this LUME's plan" state); (b) the usage meter on that card: two plain bars with numbers, "This hour: 12 of 100 · resets 3:40 pm" and "This week: 640 of 750 · resets Monday 12:00 am" (colour plus text, never colour alone), and the paused state; (c) the next-step card under a logged call in the drawer: title "Suggested next step", the summary line, three checkable rows (stage, follow-up, tags), primary "Apply", quiet "Dismiss", "From your call at 4:12 pm"; loading, "couldn't read" and "limit reached, back at …" states; (d) the "Catch me up" button and its three-line card.
- [ ] **Step 2:** Send the owner the link; record approval (or changes) in the ledger. UI tasks start only after approval.

### Task 9: Web — the LUME AI card and its usage meter

**Files:**
- Create: `apps/web/src/components/integrations/AiCard.tsx`, `apps/web/src/lib/ai/client.ts`
- Modify: `apps/web/src/components/integrations/Integrations.tsx`
- Test: `apps/web/src/components/integrations/AiCard.test.tsx`

**Interfaces:** consumes `GET /api/v1/ai`, `POST /api/v1/integrations/ai`, `integrationsView().ai`; reuses `Switch`, `NotInPlan`, the integrations card styles.

- [ ] **Step 1: Failing tests**: switch off by default; turning on calls the API and shows the meter with both limits and their reset times; a paused week shows "It's back Monday"; "Not in this LUME's plan" disables the switch; a 409 `AI_NOT_CONFIGURED` shows "LUME AI isn't set up on this server yet."; axe clean.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c "cd apps/web && pnpm exec vitest run src/components/integrations"` — FAIL.
- [ ] **Step 3: Implement** to the approved canvas.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): LUME AI in Integrations — the switch and its hourly and weekly meter`

### Task 10: Web — the suggestion card and Catch me up, plus e2e

**Files:**
- Create: `apps/web/src/components/leads/drawer/NextStepCard.tsx`, `apps/web/src/components/leads/drawer/CatchUp.tsx`, `apps/web/e2e/ai.spec.ts`
- Modify: `apps/web/src/components/leads/drawer/LogCall.tsx` (after a saved call with a note, request the next step when AI is on), the drawer's activity list (a "Suggest next step" action on a note or logged call, keyboard-reachable, not hover-only), `apps/web/src/components/leads/drawer/LeadDrawer.tsx` (show `pending` and `offerCatchUp` from `GET /leads/:id/ai`)
- Test: `NextStepCard.test.tsx`, `CatchUp.test.tsx`

- [ ] **Step 1: Failing tests**: card shows summary and the three parts checked; unticking a part sends `false` for it; Apply shows what was applied and skipped in words; Dismiss removes the card; Escape/Tab order; focus moves to the card's heading when it appears (announced via `aria-live="polite"`); catch-up shows a loading state then three lines; nothing renders when AI is off; at a limit the card area says "LUME AI has reached this hour's limit. It's back at 3:40 pm." and offers no button. e2e (`ai.spec.ts`, fake provider): log a call with a note → card → Apply → stage and follow-up visible on the lead; screenshots + axe both themes.
- [ ] **Step 2: Run** unit tests — FAIL.
- [ ] **Step 3: Implement** to the approved canvas.
- [ ] **Step 4: Run** unit tests — PASS; full e2e on the build host with `--update-snapshots=changed` (only inside a FULL run) — PASS; check the new review copies light and dark.
- [ ] **Step 5: Commit** `feat(web): a suggested next step after a call, and Catch me up`

### Task 11: The eval set and runner (gate before switching AI on for a client)

**Files:**
- Create: `evals/ai/next-step.jsonl` (50 call notes), `evals/ai/catch-up.jsonl` (20 lead histories), `scripts/ai-eval.mjs`, `docs/runbooks/ai.md`

- [ ] **Step 1:** Write the sets fresh (no client data): English, Hinglish, Telugu-English, Marathi-English; prices, visits, dates ("after Diwali", "next Saturday"), refusals, decision-makers, one-word notes. Each line: facts, note, expected stage/follow-up/lost reason/tags.
- [ ] **Step 2:** `scripts/ai-eval.mjs --provider anthropic|google --model <id>` runs the real provider through `apps/api/src/ai` adapters and the Task 1 cleaner, prints accuracy per field and total tokens/cost; refuses to run without `--yes` (it spends money).
- Pass mark before any client switches AI on: stage right ≥ 90%, follow-up date right ≥ 90%, no follow-up in the past 100%, no invented id 100% (after the cleaner), catch-up lines each grounded in the history (checked by hand on 20).
- [ ] **Step 3:** Dry-run against `fake` in CI-free mode to prove the script; do NOT run a real model — ask the owner to approve the spend, then record results and the chosen model in `docs/runbooks/ai.md` (with per-client provider key + hard monthly spend cap setup).
- [ ] **Step 4: Commit** `test(ai): the eval sets and runner for LUME AI (paid runs need the owner's yes)`

### Task 12: Gate, docs and release

- [ ] **Step 1:** Full gate on the build host: `pnpm test`, `pnpm lint`, `pnpm exec prettier --check apps packages infra scripts`, `node scripts/check-client-names.mjs`, web e2e full, licence e2e — all green; CI green after push.
- [ ] **Step 2:** Deploy the licence server 0.6.0 (migration 0008, backup first, rollback image kept), per `docs/runbooks/licence-server.md`; healthz 200.
- [ ] **Step 3:** `docs/ai-2026-10-18.md`: what shipped, rulings, deferred (per-client AI cost on the licence dashboard and in health — with the WhatsApp plan), marketing note ("LUME has no AI writer" stays true: no drafts yet).
- [ ] **Step 4: Commit** `docs: LUME AI part 1 — what shipped, licence 0.6.0, the rulings`
