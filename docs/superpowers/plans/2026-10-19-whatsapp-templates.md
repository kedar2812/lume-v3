# WhatsApp W3b-2: approved templates and sending beyond 24 hours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A business submits its LUME templates (with a header file from its library) to Meta from LUME, sees each one approved or rejected with Meta's reason, and sends an approved template to any lead from LUME, including a lead who has never written or went quiet more than 24 hours ago, with its cost shown first and a monthly limit that protects the business from a surprise bill.

**Architecture:** A LUME template version maps to one Meta template per WhatsApp business account (`whatsapp_template_submissions`): LUME's named tokens become Meta's numbered parameters in order, with readable examples. Status arrives by Meta's webhook (through the relay, which already forwards everything for the account) and, as a backstop, a sweep that asks Meta every 15 minutes about anything still pending. Sending reuses W3a's outbox and queue: a row carries the submission and the lead's values instead of free text, so idempotency, statuses, retries and "counts as a send" are W3a's, unchanged.

**Tech Stack:** Fastify, Drizzle, Postgres (FORCE RLS), pg-boss, Next.js, Vitest, Playwright, the fake Meta.

**Spec:** `docs/superpowers/specs/2026-10-18-whatsapp-replies-ai-design.md` §4.3 (media templates, the route per lead, the cost guard). It is the prerequisite for `docs/superpowers/specs/2026-10-19-lume-ai-autopilot-design.md` §8. W3b-1 (`2026-10-19-whatsapp-file-library.md`) comes first: header files are library files.

## Global Constraints

- Meta's template rules, checked in LUME before submitting (core `templateProblems`), so a person hears what's wrong in LUME's words instead of a rejection a day later.
- Meta charges template fees to the client's own WhatsApp account; LUME shows "about" the published rate and never promises an exact charge. The rate card carries its date.
- Monthly limit (owner, 2026-10-19: usage is monthly): `paidSendsMonthly` in the plan, and an optional lower cap an admin sets; at the limit nothing is sent and LUME says so.
- Opt-out is honoured from day one: Meta's "stopped marketing messages" refusal (131050) marks the lead, and no marketing template is offered for them again.
- Nothing client-specific; copy speaks as LUME, no em dashes; scale bar 1,000 people.
- Every new route in the access matrix; every new table named in RLS coverage (business configuration) or under the outbox's RLS.
- TDD: each step's test fails before its code. Commit after each task.

## Review Focus

1. A template edited after approval: the approved version keeps sending as approved; the screen says "Edited since approval" and offers Submit again; the new version is never sent unapproved.
2. A lead missing a value a template needs (no first name, no meeting): never sent with a blank; the sheet names what's missing and offers the templates that don't need it.
3. Two numbers on two WhatsApp business accounts: a template approved on one isn't offered for a lead whose send goes from the other.
4. Meta recategorises a template from Utility to Marketing (`template_category_update`): the shown cost follows.
5. The plan's limit lowered mid-month below what's already used: sending stops at once, in words.

---

### Task 1: Meta's template rules and the mapping, in core

**Files:**
- Create: `packages/core/src/whatsapp/templates.ts`, `packages/core/src/whatsapp/templates.test.ts`, `packages/core/src/whatsapp/rates.ts`, `packages/core/src/whatsapp/rates.test.ts`
- Modify: `packages/core/src/whatsapp/index.ts`, `packages/core/src/messaging/render.ts` (export `valueOf` and each variable's `example`)

**Interfaces:**
- Produces:
  - `type MetaCategory = "MARKETING" | "UTILITY"`; `metaCategoryOf(c: TemplateCategory): MetaCategory` (`reminder` → UTILITY; the rest MARKETING).
  - `metaNameOf(name: string, version: number): string`: lowercase ASCII words joined by `_`, non-letters dropped, at most 500 characters, then `_v<version>` ("First hello · interiors", 3 → `first_hello_interiors_v3`; a name with no letters → `template_v3`).
  - `templateProblems(body: string, header?: { kind: "image" | "video" | "document"; size: number; mime: string }): string[]`, each in LUME's words: body empty or over 1,024 characters; starts or ends with a `{{…}}`; two variables with nothing but spaces between; more variables than half the words; a header of the wrong type or over Meta's size (image JPEG/PNG ≤ 5 MB, video MP4 ≤ 16 MB, document PDF ≤ 100 MB).
  - `toMetaTemplate(t: { name: string; version: number; language: string; category: MetaCategory; body: string; header?: { kind: "image" | "video" | "document"; handle: string } }): { payload: Record<string, unknown>; tokens: string[] }`: tokens in order of first use become `{{1}}…{{n}}`; the body's `example.body_text` uses each variable's `example` from render.ts; a header gives a `HEADER` component with `format` and `example.header_handle`.
  - `paramsFor(tokens: string[], ctx: RenderContext): { values: string[]; missing: string[] }`.
  - `costOf(countryIso: string | null, category: MetaCategory): { amount: number; currency: string; asOf: string } | null` from `TEMPLATE_RATES` (India MARKETING `{ amount: 0.86, currency: "INR", asOf: "2026-10-18" }` + "+ GST" in words, as the spec states; other markets added from Meta's rate card in the runbook; unknown → null).

- [ ] **Step 1: Write the failing tests** with the exact cases above, plus: `toMetaTemplate` for "Hi {{lead.first_name}}, your {{meeting.date}} visit is confirmed." gives `tokens ["lead.first_name","meeting.date"]`, body "Hi {{1}}, your {{2}} visit is confirmed.", examples `[["Aisha","October 24, Saturday"]]`; `paramsFor` with no meeting returns `missing ["meeting.date"]`; `costOf("IN","MARKETING")` is 0.86 INR, `costOf("ZZ","MARKETING")` is null.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run packages/core/src/whatsapp/templates.test.ts packages/core/src/whatsapp/rates.test.ts'`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the functions in core.
- [ ] **Step 4: Run** the step 2 command and `npx vitest run packages/core/src/messaging`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): WhatsApp's template rules, LUME's tokens as Meta's parameters, and the rate card`.

### Task 2: Tables

**Files:**
- Create: `packages/db/migrations/0078_whatsapp_templates.sql`
- Modify: `packages/db/src/schema/whatsapp.ts`, `packages/db/src/schema/leads.ts`, `apps/api/test/rls-coverage.test.ts`, `packages/db/src/schema.test.ts`

**Interfaces:**
- Produces:
  - `whatsapp_template_submissions (id uuid pk, template_version_id uuid not null references template_versions(id), waba_id text not null, language text not null, category text not null check (category in ('MARKETING','UTILITY')), meta_name text not null, meta_template_id text, header_file_id uuid references message_files(id), tokens jsonb not null default '[]', status text not null check (status in ('submitting','pending','approved','rejected','paused','disabled','failed')), reason text, submitted_by uuid references users(id), submitted_at timestamptz not null default now(), decided_at timestamptz, unique (template_version_id, waba_id, language))`, index on `(status) where status = 'pending'`; business configuration (no RLS; in WITHOUT_RLS with why); `REVOKE ALL … FROM lume_worker`.
  - `whatsapp_outbox` gains `submission_id uuid references whatsapp_template_submissions(id)`, `params jsonb`, `cost numeric(10,4)`, `cost_currency char(3)`, `paid boolean not null default false`; its content check becomes `text IS NOT NULL OR media_id IS NOT NULL OR submission_id IS NOT NULL OR status = 'failed'`.
  - `leads.whatsapp_marketing_off_at timestamptz`.

- [ ] **Step 1: Write the failing tests:** a submission row for a template version is unique per account and language; an outbox row with only a submission is accepted; the worker can't read submissions.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run packages/db/src/schema.test.ts -t submission'`. Expected: FAIL.
- [ ] **Step 3: Write** the migration and Drizzle schema.
- [ ] **Step 4: Run** the step 2 command, `schema.drift.test.ts` and `rls-coverage.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): template submissions, and the outbox carrying a template`.

### Task 3: Meta's template endpoints, real and fake

**Files:**
- Modify: `apps/api/src/modules/whatsapp/meta.ts`, `apps/api/test/meta-fake.ts`, `apps/api/src/app.ts` and `apps/api/src/main.ts` (`meta.appId` from `LUME_META_APP_ID`), `infra/docker-compose.yml` (pass `LUME_META_APP_ID` to api and worker)
- Create: `apps/api/src/modules/whatsapp/meta.test.ts` (against the fake)

**Interfaces:**
- Produces on `metaClient`: `uploadForTemplate(appId: string, bytes: Buffer, mime: string, name: string): Promise<string>` (Meta's resumable upload: `POST /{appId}/uploads?file_name&file_length&file_type` → `upload:…` id, then `POST /{id}` with `file_offset: 0` → `{ h }`); `createTemplate(wabaId: string, payload: Record<string, unknown>): Promise<{ id: string; status: string; category: string }>`; `templates(wabaId: string, names: string[]): Promise<{ id: string; name: string; language: string; status: string; category: string; reason: string | null }[]>` (pages through `paging.next`, only Meta's hosts, as `download` checks).
- Fake Meta: the three endpoints (rejecting a payload missing examples with code 100, as Meta does); `templates` state; `POST /__fake/template { name, status, reason?, category? }` sets a template's status and delivers `message_template_status_update` (and `template_category_update` when `category` is given) to the registered callback; `messages` with `type: "template"` checks the template exists and is APPROVED (132001 otherwise) and the body parameters count matches (132000 otherwise).

- [ ] **Step 1: Write the failing tests** against the fake for each method, including a two-page `templates` answer and a `paging.next` on another host refused as `untrusted`.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/whatsapp/meta.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement** the methods, the fake's endpoints and `meta.appId`.
- [ ] **Step 4: Run** the step 2 command and `apps/api/src/modules/whatsapp`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(whatsapp): Meta's template endpoints, and the fake's`.

### Task 4: Submitting a template, and its status

**Files:**
- Create: `apps/api/src/modules/whatsapp/submit.ts`, `submit.test.ts`
- Modify: `packages/core/src/whatsapp/webhook.ts` (+ test: `readTemplateEvents`), `apps/api/src/modules/whatsapp/receive.ts`, `apps/api/src/modules/whatsapp/routes.ts`, `apps/worker/src/jobs/*` (the 15-minute sweep), `apps/api/test/matrix.test.ts`

**Interfaces:**
- Consumes: Task 1 (`templateProblems`, `toMetaTemplate`, `metaNameOf`, `metaCategoryOf`), Task 3 (client), W3b-1 `message_files`.
- Produces:
  - `POST /api/v1/templates/:id/whatsapp { language: string; category?: MetaCategory; headerFileId?: string }` (`templates.manage`): the template's current version, checked by `templateProblems` (422 `TEMPLATE_PROBLEMS` with the list), submitted once per WhatsApp business account of the active numbers; 202 `{ submissions: SubmissionView[] }`. A second submit of the same version and language is 409 "Already with WhatsApp for review."
  - `GET /api/v1/templates/:id/whatsapp` (`templates.use`): `SubmissionView = { id; versionId; current: boolean; account: string (the numbers it covers, by display); language; category; status; reason: string | null; submittedAt; decidedAt }`.
  - `readTemplateEvents(raw): { templateId: string; event: string; reason: string | null; category?: MetaCategory }[]` (no `metadata` required, unlike messages).
  - Status applied by `meta_template_id`; APPROVED/REJECTED notify the submitter and admins in the bell ("WhatsApp approved “First hello”." / "WhatsApp turned down “First hello”: <reason>").
  - Worker job `whatsapp.templates.sweep` every 15 minutes: submissions pending for over 10 minutes, asked of Meta by account.

- [ ] **Step 1: Write the failing tests:** submit maps tokens and header and stores `pending`; a body ending in a variable is 422 with LUME's words; Meta's approval by webhook flips it to `approved` and notifies; a rejection stores Meta's reason; a category update changes `category`; the sweep catches an approval whose webhook never came; editing the template after approval leaves the approved row on the old version (`current: false` in the view).
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/whatsapp/submit.test.ts packages/core/src/whatsapp/webhook.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and the access matrix. Expected: PASS.
- [ ] **Step 5: Commit** `feat(whatsapp): submit a template to WhatsApp, and hear back`.

### Task 5: The monthly limit

**Files:**
- Modify: `packages/core/src/licence/fleet.ts` (`paidSendsMonthly`, ACCEPTS `plan3`) and its tests, `apps/licence/src/**` (the plan editor's field and the signer, as `aiReadsHourly` was added), `apps/api/src/modules/settings/*` (`messaging.paidSendsMonthly`, admin, optional, ≤ the plan's)
- Create: `apps/api/src/modules/whatsapp/paid.ts`, `paid.test.ts`

**Interfaces:**
- Produces: `paidUse(pool: pg.Pool, now: Date, tz: string): Promise<number>` (paid outbox rows not `failed` this calendar month on the business's clock); `paidLimit(plan: PlanClaim | null, settings): number | null` (the lower of the two; null: none); refusal 409 `PAID_LIMIT` "This month's paid WhatsApp messages are used up (1,000 of 1,000). An admin can ask for more."; one bell notice to admins at 80%.

- [ ] **Step 1: Write the failing tests:** the limit is the lower of plan and setting; usage resets on the 1st on the business's clock; a plan claim with `paidSendsMonthly` is accepted only by a LUME that sent `plan3`; the 80% notice fires once a month.
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/whatsapp/paid.test.ts packages/core/src/licence; cd apps/licence && npx vitest run'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(whatsapp): a monthly limit on paid messages, from the plan and the admin`.

### Task 6: Sending an approved template

**Files:**
- Create: `apps/api/src/modules/whatsapp/template-send.ts`, `template-send.test.ts`
- Modify: `apps/api/src/modules/whatsapp/sender.ts` (`bodyOf` for a template row; refusals 131050, 132000, 132001), `packages/core/src/whatsapp/outbound.ts` (`templateBody`, the refusals' words), `apps/api/src/modules/whatsapp/routes.ts`, `apps/api/src/modules/whatsapp/thread.ts` (a template message in the thread)

**Interfaces:**
- Consumes: Tasks 1, 2, 4, 5; W3a `sendable`, `countSend`, `sendLimiter`, `uploadMedia` cache.
- Produces:
  - `templateState(req, d, lead): Promise<TemplateState>`: `{ number: { id; display } | null; options: { submissionId; name; category; preview: string; missing: string[]; cost: { amount; currency; asOf } | null }[]; reason: string | null }`. The number: the lead's owner's number if active, else the business's default number (Settings → Integrations → WhatsApp, a new choice when there's more than one), else the only active number; only submissions approved on that number's account, current version, usable by the caller's roles; none when the lead has no valid phone, is marked marketing-off (marketing ones only), or replying from LUME is off.
  - `POST /api/v1/leads/:id/whatsapp/template { submissionId: string; clientKey: string }` (`messages.send`): every check of `mayReply` except the 24 hours, plus approved, current, params complete, the monthly limit and the per-person limiter; queues an outbox row (`paid: true` when outside the 24 hours, `cost` from `costOf`); 202 as W3a's send.
  - `templateBody(to: string, t: { name: string; language: string; values: string[]; header?: { kind; mediaId; filename? } }): Record<string, unknown>` in core.
  - Refusals: 131050 → the lead's `whatsapp_marketing_off_at` is set and the row fails with "This person turned off marketing messages from you on WhatsApp."; 132000/132001 → the submission is marked `failed` with "WhatsApp no longer has this template as approved. Submit it again."

- [ ] **Step 1: Write the failing tests:** a lead who never wrote gets the approved template from the owner's number, as sent by the fake (`type: "template"`, parameters in order); a missing value is 422 `MISSING_VALUES` naming it; the second identical `clientKey` is one message; inside the 24 hours the row is `paid: false`; a 131050 marks the lead and the next `templateState` offers no marketing template; a 132001 fails the submission; a template on another account is not offered; the monthly limit refuses in words; it counts as a send (last message, first contact, follow-up done).
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'npx vitest run apps/api/src/modules/whatsapp/template-send.test.ts apps/api/src/modules/whatsapp/sender.test.ts'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step 2 command and all of `apps/api/src/modules/whatsapp`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(whatsapp): send an approved template to any lead, with its cost and a monthly limit`.

### Task 7: The screens

**Files:**
- Create: `apps/web/src/components/templates/WhatsAppApproval.tsx` (+ test), `apps/web/src/components/whatsapp/TemplatePick.tsx` (+ test)
- Modify: the template editor (`apps/web/src/components/templates/*`), `apps/web/src/components/leads/drawer/WhatsAppComposer.tsx` (+ test), `apps/web/src/lib/whatsapp/client.ts`, `apps/web/src/lib/templates/client.ts`, `apps/web/src/components/integrations/WhatsAppCard.tsx` (the default number choice)

**Interfaces:**
- Produces:
  - In a template, a "WhatsApp approval" panel: language (default the business's), category with one plain line on what it means and its cost, an optional header file (FilePicker, W3b-1), the problems LUME found (from `templateProblems`, live as the body changes), **Submit to WhatsApp**, and each account's status chip (With WhatsApp for review / Approved / Turned down: <reason> / Paused / Edited since approval: Submit again).
  - In the reply box, outside the 24 hours (or for a lead who never wrote): instead of the reason alone, "Send an approved template": each option with the lead's own preview, what's missing, and "WhatsApp charges about ₹0.86 + GST for this"; Send; "or wait for their reply".
- [ ] **Step 1: Write the failing tests** for each of the above, including the live problem list and "Edited since approval".
- [ ] **Step 2: Run** `bash scripts/dev.sh run bash -c 'cd apps/web && npx vitest run src/components/templates src/components/whatsapp src/components/leads/drawer/WhatsAppComposer.test.tsx'`. Expected: FAIL.
- [ ] **Step 3: Implement** in LUME's look (Porcelain and Obsidian, the WhatsApp app icon, status chips with a dot, the spring tokens).
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): WhatsApp approval for templates, and sending one from the reply box`.

### Task 8: End to end, and the runbook

**Files:**
- Modify: `apps/web/e2e/whatsapp.spec.ts`, `docs/runbooks/whatsapp.md`, `docs/whatsapp-w3b-2026-10-19.md` (what shipped)

- [ ] **Step 1: Write the e2e:** an admin submits a template with a library PDF; the fake approves it by webhook; a rep sends it to a lead who never wrote; the fake receives a template with the right parameters and header; delivered and read ticks follow; a rejection shows Meta's reason; axe passes in both themes.
- [ ] **Step 2: Run** the spec. Expected: PASS.
- [ ] **Step 3: Runbook:** `LUME_META_APP_ID` on every client; the rate card's date and how to update it; what a 131050 means for a team; Meta's template review times.
- [ ] **Step 4: Full suites** (unit, typecheck, lint, full e2e with `--update-snapshots=changed`, changed images reviewed). Expected: green.
- [ ] **Step 5: Commit** `test(e2e): approved templates end to end; runbook`.
