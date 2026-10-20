# Autopilot A1: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything LUME AI Autopilot stands on that a business sees before any run: one monthly LUME AI allowance with the usage ring in the top bar, asking the owner for a top-up, and Settings → LUME AI (what LUME AI knows, its voice, and the business's standing choices).

**Architecture:** The allowance moves from a weekly to a monthly window on the business's clock, signed into the licence like W3b-2's paid sends (a new `plan4` claim: `aiCallsMonthly` and this month's `aiTopUps`); a LUME whose licence server doesn't send it keeps the weekly limit. Top-up requests go to the licence server the way feedback does and show on the owner's dashboard as an alert with "Add a top-up". Settings → LUME AI is one validated document per business (`ai_profile`), read by the run engine in A2.

**Autopilot is three plans, each shipping working software:** A1 (this one) foundations; A2 the run engine on the server (runs, per-lead state, permissions enforced server-side, hours/caps/tier pacing, templates outside 24 hours, replies inside, stop/handover/price guard, the event stream, pause/end/take over), driven end to end through the API against the fake AI provider and the fake Meta; A3 the screens (the start sheet, the live Autopilot page, Ready for you, phone). A2 and A3 are written once A1 is built, against its interfaces.

**Tech Stack:** Fastify, Drizzle, Postgres, pg-boss, zod, Next.js 16, motion, Vitest, Playwright; the licence server (apps/licence).

**Spec:** `docs/superpowers/specs/2026-10-19-lume-ai-autopilot-design.md` §4 (usage, limits, the ring, top-up), §5 (Settings → LUME AI), §1.1–1.3 and §3 (the standing choices those settings hold), §10 (owner's answers: monthly and generous; paused until the admin asks for a top-up; "Are you a bot?" and replies outside hours are business settings).

## Global Constraints

- Nothing client-specific: every list (stages, fields, files, people) is read from the business's own configuration; sample words in tests are fictional.
- Copy speaks as LUME, plain words, no em dashes (`scripts/check-copy.mjs`); icons, never numbered steps; the LUME AI mark is `public/lume-ai-mark.svg` on plain grounds only, never a gradient.
- No over-promising: Autopilot itself isn't built in A1, so no copy here says LUME AI runs, sends or answers anything yet; settings that only Autopilot uses say "Used by Autopilot" and nothing more.
- The LUME AI switch (Settings → Integrations, 2026-10-18 §2.2) gates everything; with it off, nothing here shows except Settings → LUME AI's own explanation and a link to switch it on. LUME works in full without it.
- Porcelain and Obsidian tokens only; motion from `apps/web/src/lib/motion.ts` with Reduce Motion fades; phone width 390 px; axe clean in both themes.
- A LUME whose licence server predates `plan4` keeps today's weekly limit exactly as now (no regression for a client whose licence server isn't updated).
- TDD for every task; new routes in `apps/api/test/probes.ts`; new tables under `apps/api/test/rls-coverage.test.ts` rules; licence server changes need the owner to deploy the licence app (record it, never deploy).

## Review Focus

1. The month turns over at midnight on the 1st in the business's timezone, not UTC: a business in Asia/Dubai at 01:00 on November 1 local (still October in UTC) has November's allowance. Test: Task 1 "turns at local midnight".
2. A top-up the owner adds for this month raises the allowance at the next check-in and an AI pause ends by itself; one for a past month changes nothing. Test: Task 2 "a top-up lifts this month only", Task 4 "a top-up ends the pause".
3. Two admins press Ask for a top-up at once, or one presses it five times: the owner gets one request for the month, and the button says it's asked. Test: Task 3 "one request a month".
4. The price list holds a business's real prices in its own currency: an amount like 3,80,000 (Indian grouping) or 1,150.50 survives saving and reading exactly; a negative or a 20-digit number is refused in words. Test: Task 5 "prices keep their value".
5. A file chosen for LUME AI to send is later archived in Media: Settings shows it as archived with a way to remove it, and the profile never offers a file the business can't send. Test: Task 5 "an archived file is said".

---

### Task 1: The monthly allowance, in core

**Files:**
- Modify: `packages/core/src/ai/limits.ts` and its test, `packages/core/src/licence/fleet.ts` (plan claim) and `packages/core/src/licence/plan.test.ts`

**Interfaces:**
- Produces: `AiLimits = { hourly: number | null; weekly: number | null; monthly: number | null }`; `AiUsage` + `monthN: number`; `aiWindows(now, tz)` + `monthStart`, `nextMonthStart`; `AiLimitState` + `month: AiLimit`; `AiPause.by` adds `"month"` (checked first); `backWords` for a month: `"on November 1"`; `planSchema` gains `aiCallsMonthly?: number | null` (1–10,000,000) and `aiTopUps?: { month: string /* YYYY-MM */; calls: number }[]` (≤ 12 entries, calls 1–10,000,000), signed only for a LUME that accepts `"plan4"`; `ACCEPTS` = `["announcements", "plan", "plan2", "plan3", "plan4"]`; `aiAllowance(plan, month: string): number | null` = `aiCallsMonthly` + the sum of `aiTopUps` for that month, `null` when `aiCallsMonthly` is null or absent; `usesMonthly(plan): boolean` = `aiCallsMonthly !== undefined`.

- [ ] **Step 1: Write the failing tests:** `monthly: used against the month's allowance, resets on the 1st`; `turns at local midnight` (Asia/Dubai, `2026-10-31T21:30:00Z` is November); `the month pauses before the hour` (both over: `by: "month"`); `backWords says the day the month comes back` (`"on November 1"`); `aiAllowance adds this month's top-ups and ignores other months` (`{ aiCallsMonthly: 3000, aiTopUps: [{ month: "2026-10", calls: 500 }, { month: "2026-09", calls: 900 }] }` → `3500` for `2026-10`); `a plan from an older licence server has no monthly` (`usesMonthly({ aiReadsWeekly: 750 })` false); `plan4 claims validate` (0 and 10,000,001 refused; 13 top-ups refused).
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run packages/core/src/ai packages/core/src/licence'`. Expected: FAIL.
- [ ] **Step 3: Implement** using `wallTime` for the month boundaries, as the week does.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): LUME AI's allowance is monthly, with top-ups, on the business's clock`.

### Task 2: The licence server signs the monthly allowance and takes top-up requests

**Files:**
- Create: `apps/licence/migrations/0010_ai_monthly.sql`, `apps/licence/src/server/topup.ts`, `topup.test.ts`
- Modify: `apps/licence/src/server/plan.ts` (+ test), `apps/licence/src/server/api.ts` (route), `apps/licence/src/server/clients.ts` (client page data, Add a top-up), `apps/licence/src/lib/alerts.ts` (+ test), the client page component and its test, `docs/runbooks/licence-server.md`

**Interfaces:**
- Consumes: Task 1's `planSchema` fields, `"plan4"`.
- Produces: `licences.ai_calls_monthly integer CHECK (1..10000000)`; `ai_topups (id, client_id, month text CHECK (month ~ '^\d{4}-\d{2}$'), calls integer CHECK (1..10000000), added_at, note)`; `topup_requests (id, client_id, month, asked_at, asked_by_name, asked_by_email, note, done_at)` with `UNIQUE (client_id, month)`; `POST /v1/topup` (body `{ instanceId, licenseKey, installId, appVersion, month, askedBy: { name, email }, note? }` checked like feedback: the key and install must match; 201 `{ asked: true }` first time, 200 `{ asked: true, already: true }` again that month; 429 past 10 a day per client); `planOf` for a `plan4` LUME adds `aiCallsMonthly` and `aiTopUps` for this and next month; an alert `topup_requested` ("{client} asked for a LUME AI top-up for October") on Fleet until handled; the client page: "LUME AI a month" on the plan form, open requests, and **Add a top-up** (calls, note) which inserts `ai_topups` and marks that month's request done.

- [ ] **Step 1: Write the failing tests:** `a LUME that accepts plan4 gets its monthly allowance and this month's top-ups`; `a LUME that doesn't gets no monthly (it keeps its weekly)`; `a top-up lifts this month only`; `/v1/topup with a key that isn't this install's is 401`; `one request a month: a second is 200 already`; `the request shows as an alert until a top-up for that month is added`; `Add a top-up records it and closes the request`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'cd apps/licence && npx vitest run src/server/topup.test.ts src/server/plan.test.ts src/lib src/app'`. Expected: FAIL.
- [ ] **Step 3: Implement**, following `feedback.ts` for the credential check and rate limit.
- [ ] **Step 4: Run** the step 2 command and the whole licence suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(licence): LUME AI a month per client, top-up requests and Add a top-up` (the licence app needs a deploy by the owner; record it).

### Task 3: LUME counts the month, tells admins, and asks for a top-up

**Files:**
- Create: `packages/db/migrations/0081_ai_monthly.sql`
- Modify: `apps/api/src/modules/ai/service.ts` (+ `ai.test.ts`), `apps/api/src/modules/ai/routes.ts`, `apps/api/src/licence/keeper.ts` (+ test), `apps/api/src/licence/plan.ts` (accepts plan4), `apps/api/test/probes.ts`, `packages/config/src/schema.ts` (+ test), `infra/docker-compose.yml` (pass-through), `docs/runbooks/ai.md`

**Interfaces:**
- Consumes: Task 1 (`aiAllowance`, `usesMonthly`, `AiLimitState.month`), Task 2 (`POST /v1/topup`).
- Produces: `lume_ai_usage(hour_since, week_since, month_since)` and `lume_ai_reserve(…, monthly_limit, month_since)` replacing the two-window versions (refusal `'month'`); `ai_limit_notices.kind` adds `month_75`, `month_90`, `month_limit`; `GET /api/v1/ai` → `AiStatus` + `month` and `spend: { used: number; cap: number | null; currency: "USD" } | null` and `pace: { daysLeft: number | null }`, and `topUp: { asked: boolean } | null` (admins); `POST /api/v1/ai/topup` (`settings.manage`) → `{ asked: true; already?: true }` or 409 `NO_LICENCE` / 502 `UNREACHABLE` in words; `keeper.requestTopUp(o: { month: string; askedBy: { name: string; email: string }; note?: string }): Promise<{ ok: true; already: boolean } | { ok: false; reason: "no_key" | "unreachable" | "limited" }>`; env `LUME_AI_PRICE_IN`, `LUME_AI_PRICE_OUT` (USD per million tokens) and `LUME_AI_MONTHLY_CAP` (USD), all optional: with prices set, spend is input and output tokens this month at those prices; without, `spend` is null and the ring says nothing about money.

- [ ] **Step 1: Write the failing tests:** `with a monthly plan, reads count against the month and the week is ignored`; `with an older licence, the week works as before` (the existing weekly tests unchanged); `admins hear once at 75% and 90% of the month, and once at the limit`; `at the month's limit a read is refused with by: "month" and until the 1st`; `a top-up ends the pause` (the plan's allowance rises, the next read goes); `spend and pace: 1,000,000 input and 200,000 output tokens at $3 and $15 is $6.00; at 600 of 3,000 by the 10th of a 31-day month, about 40 days left`; `no prices set: no spend`; `one request a month: the second press says already` (keeper fake); `only settings.manage may ask`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/ai apps/api/src/licence packages/config packages/db/src/schema.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement**; pace = `remaining / (used / daysElapsed)` rounded down, null before the first use.
- [ ] **Step 4: Run** the step 2 command and the matrix. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): one monthly LUME AI allowance, its notices, spend and pace, and asking for a top-up`.

### Task 4: The ring

**Files:**
- Create: `apps/web/src/components/ai/AiRing.tsx`, `AiRingPanel.tsx`, `ring.module.css`, tests `AiRing.test.tsx`
- Modify: `apps/web/src/components/shell/TopBar.tsx` (beside the bell), `apps/web/src/lib/ai/client.ts` (status type, `askTopUp()`)

**Interfaces:**
- Consumes: Task 3's `GET /api/v1/ai` and `POST /api/v1/ai/topup`.
- Produces: `<AiRing />` shown only when LUME AI is on for this person: an 18 px progress ring of the month's use, amber past 80%, the LUME AI mark inside at rest; its button `aria-label="LUME AI: 64% of this month used"`; the panel (a Popover): the percentage, "About 12 days left at this pace", this month's and this hour's use, spend against the cap when known ("$6.00 of $50 this month"), "Resets on November 1", **Ask for a top-up** for admins (at 80% and over, and while paused: "Asked. LUME will let you know when it's added." after), a link "LUME AI settings" for admins; paused: "LUME AI has reached this month's allowance." / "…this hour's limit. It carries on at 3:40 pm."

- [ ] **Step 1: Write the failing tests:** `hidden while LUME AI is off`; `the ring's name says the month's share`; `amber past 80%`; `the panel says days left, this month and this hour, and when it resets`; `spend shows only when known`; `an admin at 85% may ask for a top-up, once; a rep never sees the button`; `paused by the month: says so, and offers the top-up`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'cd apps/web && npx vitest run src/components/ai src/components/shell'`. Expected: FAIL.
- [ ] **Step 3: Implement** (the ring's stroke animates with `--spring-soft`; it refreshes with the bell's stream tick and when the panel opens).
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): LUME AI's ring in the top bar: this month's use at a glance, and a top-up when it's needed`.

### Task 5: What LUME AI knows, its voice and the business's standing choices (server)

**Files:**
- Create: `packages/core/src/ai/profile.ts` (+ test), `packages/db/migrations/0082_ai_profile.sql`, `apps/api/src/modules/ai/profile.ts` (+ test)
- Modify: `packages/db/src/schema/*.ts`, `apps/api/src/modules/ai/routes.ts`, `apps/api/test/probes.ts`, `apps/api/test/rls-coverage.test.ts` (`ai_profile: "Business configuration"`)

**Interfaces:**
- Produces (core): `AUTOPILOT_ACTIONS = ["first_messages", "follow_ups", "replies", "send_files", "book_meetings", "move_stages", "set_follow_ups", "fill_fields", "answer_prices", "mark_lost", "hand_to_rep"] as const`; `Allow = "go" | "ask" | "never"`; `PRESETS: Record<"careful" | "balanced" | "hands_off", Record<Action, Allow>>` (careful: messages go, everything that changes a lead ask; balanced: messages, files and meetings go, the rest ask, the default; hands_off: all go); `presetOf(perms): Preset | null`; `aiProfileSchema` = `{ knows: { about: string ≤ 2000; faqs: { q ≤ 300; a ≤ 1000 }[] ≤ 50; prices: { id: uuid; item ≤ 120; price: number (0 ≤ x < 1e12, ≤ 2 decimals); unit ≤ 40; notes ≤ 300 }[] ≤ 200; files: uuid[] ≤ 50; neverSay: string ≤ 200 [] ≤ 30 }; voice: { tone: "warm" | "formal" | "casual"; language: "match_lead" | string /* BCP 47, ≤ 20 */; signOff ≤ 80 }; standing: { goalStages: uuid[] ≤ 5; permissions: Record<Action, Allow>; followUpDays: int[] (1–30, ≤ 4, ascending; default [2, 5]); speaker: uuid | null /* null = whoever starts the run */; dailyCap: int (1–10,000) | null /* null = from the number's Meta tier */; botQuestion: "say_so" | "hand_over"; outsideHours: "reply_any_time" | "wait" } }`; `DEFAULT_AI_PROFILE` (balanced, `[2, 5]`, `say_so`, `wait`, warm, `match_lead`); `mergeAiProfile(stored, patch)` like `mergePreferences` (a stored value that no longer parses falls back per field).
- Produces (DB/API): `ai_profile (id smallint PRIMARY KEY CHECK (id = 1), profile jsonb NOT NULL, updated_at, updated_by)`; `GET /api/v1/ai/profile` (`settings.manage`) → `{ profile, files: { id, name, archived }[] /* the chosen files, by name */, stages: { id, name, kind }[] /* open stages, for goals */ }`; `PATCH /api/v1/ai/profile` (`settings.manage`, body = a partial profile, merged) → the same; amounts in the business currency (`settings.currency`), stored as numbers with the currency beside them in the answer.

- [ ] **Step 1: Write the failing tests:** (core) `presets set every action, and presetOf names one or none`; `prices keep their value` (380000 and 1150.5 round-trip; −1, 1e13 and 1.005 refused in words); `a stored profile from an older shape keeps what still parses`; (API) `an admin saves what LUME AI knows and reads it back`; `a file that isn't in Media is refused; an archived file is said` (returned with `archived: true`); `goal stages must be the business's open stages`; `a rep gets 403`; `the speaker must be someone who may send messages`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run packages/core/src/ai apps/api/src/modules/ai packages/db/src/schema.test.ts apps/api/test/matrix.test.ts apps/api/test/rls-coverage.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement**, audit `ai_profile.updated` with the changed top-level sections only (never the words).
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): what LUME AI knows, its voice and the business's standing choices`.

### Task 6: Settings → LUME AI

**Files:**
- Create: `apps/web/src/app/(app)/settings/ai/page.tsx`, `apps/web/src/components/settings/ai/AiSettings.tsx`, `KnowsSection.tsx`, `PriceList.tsx`, `VoiceSection.tsx`, `StandingSection.tsx`, `PermissionRow.tsx`, `ai.module.css`, tests `AiSettings.test.tsx`, `PriceList.test.tsx`, `StandingSection.test.tsx`
- Modify: `apps/web/src/lib/settings/areas.ts` (+ test: "LUME AI", `settings.manage`, after Integrations), `apps/web/src/lib/ai/client.ts`

**Interfaces:**
- Consumes: Task 5's routes; Task 3's status (the Usage section reuses `AiRingPanel`'s content); `MediaPicker multiple wide` for files.
- Produces: the page, admins only, with the LUME AI mark and one line ("Teach LUME AI your business once. Autopilot uses what's here.") and four sections: **What LUME AI knows** (about your business, FAQs, the price list as rows with the business currency, files from Media by their thumbnails, things it must never say), **Voice** (tone as a segmented control, language, sign-off, with a live sample line), **Standing choices** (goal stages from the pipeline, the three presets and one Go ahead / Ask me / Never control per action named in the business's words, follow-up days, speaker, daily cap, "If someone asks whether they're talking to a bot", "Replies outside working hours"), **Usage** (the month's meter). Saved per section with the existing "Saved" pattern; Leave without saving guard (owner ruling 2026-10-18). With LUME AI off: the explanation and "Switch LUME AI on in Integrations".

- [ ] **Step 1: Write the failing tests:** `the price list adds, edits and removes rows, shows the business currency and refuses a negative price in words`; `pressing a preset sets every row; changing one row unpresses it`; `a file chosen from Media shows by its thumbnail; an archived one says so with Remove`; `the voice sample changes with the tone`; `leaving with unsaved changes asks first`; `with LUME AI off, the page explains and links to Integrations`; `Settings lists LUME AI for an admin after Integrations, not for a rep`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'cd apps/web && npx vitest run src/components/settings/ai src/lib/settings'`. Expected: FAIL.
- [ ] **Step 3: Implement** to LUME's Settings patterns (cards, `SettingsPage`, `Switch`, `SegmentedControl`), phone layout with the three-way controls full width under each action (spec §2.3).
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Settings → LUME AI: what it knows, its voice and your standing choices`.

### Task 7: End to end, and the gate

**Files:**
- Create: `apps/web/e2e/ai-settings.spec.ts`
- Modify: `apps/web/e2e/licence-fake.ts` (plan4: monthly allowance, `/v1/topup`), `apps/licence/e2e/*` (Add a top-up on the client page), `docs/runbooks/ai.md`

- [ ] **Step 1: Write the e2e:** an admin with LUME AI on sees the ring; uses AI until 80% (the licence fake's small allowance), the ring turns amber; asks for a top-up, the licence fake records one request; the fake adds a top-up, the ring falls back; Settings → LUME AI: adds three prices (one with Indian grouping), a FAQ, two files from Media, sets Careful then changes one row (no preset pressed), saves, reloads, all kept; phone width: the three-way controls stack under each action; screenshots (review copies) and axe in both themes. Licence e2e: the alert shows, Add a top-up closes it.
- [ ] **Step 2: Run** `timeout 3000 bash scripts/dev.sh run bash -c "cd apps/web && pnpm exec playwright test e2e/ai-settings.spec.ts e2e/ai.spec.ts"` and the licence e2e. Expected: PASS; read every screenshot.
- [ ] **Step 3: Full suites:** typecheck, lint (`npx eslint . --ignore-pattern "social media/**"`), check-copy, unit (all packages, licence), the full web e2e with `--update-snapshots=changed` (baselines fetched in the same command; each changed image reviewed), the licence e2e. Expected: all green.
- [ ] **Step 4: Commit** `test(e2e): LUME AI's month, the ring, a top-up, and Settings → LUME AI` and push.
