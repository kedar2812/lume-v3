# Phase 4A — Templates and sending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People send the business's best wording to a lead in two taps, from anywhere a lead appears. LUME knows it went out, and when they replied.

**Architecture:**
- Templates are configuration (like stages): `message_templates` plus immutable `template_versions`.
- One pure renderer in `@lume/core` serves the server and the screen. The server always renders again from the lead the caller may see, and builds the wa.me link, as today.
- "Sent" and "They replied" update the lead's `last_message_at` / `last_reply_at`, then apply the stage's optional move through `moveStage`, so required fields and 3C automations still apply.

**Tech Stack:** as 3C: Fastify, Drizzle, Postgres 17 with row-level security, Next.js, vitest, Playwright, and Motion for springs.

**Spec:** `docs/superpowers/specs/2026-09-29-phase-4-whatsapp-templates-design.md` (§2 4A, §3, §4, §5, §6, §7).

## Global Constraints

- **Design bar (owner, 2026-09-29):** "a really clean UI, it should stand up to the design we have built so far, clean animations and proper placement of components".
  - The apple-design skill applies to every screen.
  - Motion is interruptible springs, with reduced-motion cross-fades.
  - Every new screen has full, unmasked review copies in both themes, shown to the owner before it's called done.
- No phone or email ever reaches a template variable, a render response or a log line. The one exception is the wa.me link `prepare` returns, as today (report §11.2 step 5).
- One accent blue. WhatsApp green only on WhatsApp send actions. WhatsApp's official mark, unmodified.
- Copy speaks as LUME. There are no client names; starter templates are generic.
- Sound only on achievements: `sent` for a confirmed send and for a logged reply (frontend spec sound table). Opening WhatsApp is silent.
- The gate (lint, typecheck, tests), TDD with RED watched, and CI green.

## Interaction and motion (apple-design, binding for Tasks 5–7)

These turn the design bar into checkable requirements. Every value comes from the existing tokens (`SPRINGS` in `apps/web/src/lib/motion.ts`, `tokens.css`), never a new ad-hoc curve.

- **Response.**
  - Every button, card and chip gives feedback on pointer-down: `:active` scale 0.97 over 100 ms, and never on release alone.
  - The editor's preview updates on every keystroke **without a network round-trip**. The editor fetches the preview lead's `RenderContext` once and calls `render` locally; the server renders again only on send.
- **Springs.**
  - Everything that appears, moves or resizes uses `SPRINGS.default` (critically damped, response 0.38). Nothing overshoots unless it followed a flick.
  - Drag-reorder in the library follows the pointer 1:1, respects the grab offset, and settles with `SPRINGS.default`.
  - A drop is decided by the pointer's velocity projected forward (the drag's direction of travel), not only where it was released. Dragging past the ends rubber-bands.
- **Interruptible.**
  - Opening and closing sheets and popovers can be reversed mid-flight; closing a sheet as it opens reverses from where it is. No input is locked during a transition.
  - A template picked while the previous one's text is still animating in replaces it from the current frame.
- **Spatial consistency.**
  - The send sheet and the Reopen menu grow from their trigger (`transform-origin` at the trigger) and return into it along the same path.
  - The Sent prompt rises out of the WhatsApp button and, once answered, settles back into it.
  - The editor sheet rises from the bottom and leaves downward.
- **Materials.**
  - The Sent prompt and the send sheet are glass, as the notification centre is: `backdrop-filter` blur with the `--glass` token and a bright top edge. They carry no scrim, so the drawer behind stays usable.
  - The editor is a modal task, so it gets the scrim.
  - With `prefers-reduced-transparency`, glass turns solid (`--raised`).
- **Harmony.** The `sent` sound, the Sent prompt's tick drawing on, and the button's brief `ok` tint start on the same frame (the sound is triggered in the same handler that sets the state).
- **Typography.**
  - Template names are semibold at `--fs-md`, body previews regular in `--text-2`, and category headers `--fs-xs` in capitals with `--ls-xs` tracking.
  - Counts use tabular numerals, so "412 / 1,000" never jitters.
- **Placement.**
  - One primary action per surface: "New template", "Save", "Open WhatsApp".
  - Destructive actions (Archive) live in the overflow menu with undo, never beside the primary.
  - The variable chips sit directly above the textarea they insert into. The preview sits beside the text it previews, and moves below it under 900 px.
- **Keyboard.**
  - The send sheet: ↑/↓ choose a template, Enter renders it into the text, ⌘/Ctrl+Enter opens WhatsApp, Esc closes.
  - The drawer: W opens WhatsApp (as today), R marks They replied.
- **Reduced motion.** Springs become 150 ms cross-fades. The bubble's re-flow is instant. Drag still tracks 1:1 (that's direct manipulation, not decoration).

Each UI task's tests include:
- the reduced-motion path;
- the keyboard path;
- that feedback shows on pointer-down, not on click only;
- axe in both themes.

Its full review copies are shown to the owner before the task is marked complete.

## Review Focus

1. **A template edited while someone's send sheet is open.** Their send uses the version they saw: `prepare` takes the version id. An archived template's version still sends, and the history keeps its words.
2. **A masked rep.** `render`, `prepare`, `confirm` and `replied` responses, errors and history lines never contain the lead's number, apart from the wa.me link.
3. **A template naming a custom field that was since archived or renamed.** It renders as missing (amber in the sheet) and never errors.
4. **"Sent? Yes" twice, or after its follow-up was already done.** One `whatsapp_confirmed_sent`, no second move, and the follow-up done once.
5. **An after-sent move to a stage that needs fields the lead lacks.** The send is still logged. The lead stays put, and the answer says why in LUME's words.

---

### Task 1: Rendering in `@lume/core`

**Files:**
- Create: `packages/core/src/messaging/render.ts`, `packages/core/src/messaging/render.test.ts`, `packages/core/src/messaging/index.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/shared.ts`

**Produces:**
- `type TemplateCategory = "first_touch" | "follow_up" | "reminder" | "re_engagement" | "custom"`, and `TEMPLATE_CATEGORIES` in display order, with labels ("First touch", "Follow-up", "Reminder", "Re-engagement", "Custom").
- `type RenderContext = { lead: { name: string; custom: Record<string, unknown> }; owner: { name: string } | null; business: { name: string; currency: string; timezone: string }; fields: { key: string; type: FieldType; options?: { label: string }[] }[]; people: { id: string; name: string }[] }`
- `render(body: string, ctx: RenderContext): { text: string; missing: string[] }`. `missing` lists variable names without a value, in order, each once.
- `VARIABLES`: the picker's list, `{ token, label, needs?: "calendar" }[]`. It includes `lead.first_name`, `lead.name`, `owner.first_name` and `business.name`, one per non-contact custom field (from `fields`), and `meeting.date|time|link` with `needs: "calendar"`.
- `waFormat(text): { t: string; b?: true; i?: true }[]`: `*bold*` and `_italic_` runs, for the preview.

**Behaviour:**
- `{{lead.first_name}}` is the first word of the name.
- A `{{lead.custom.<key>}}` whose field type is phone, email, url or instagram **never renders**, and is listed as missing. So is an unknown key.
- Formatting by type:
  - date: "12 Oct" (business timezone);
  - datetime: "12 Oct, 17:30";
  - currency: `Intl.NumberFormat` in the business currency, no decimals when whole;
  - number: plain;
  - boolean: Yes/No;
  - select: the label;
  - multi_select: labels joined with ", " and " and " before the last;
  - user: the first name;
  - long_text: as is.
- `{{meeting.*}}` is always missing in 4A.
- Whitespace inside braces is tolerated (`{{ lead.name }}`). Anything else in braces stays as written and is listed as missing.

- [ ] Write the failing tests:
  - each variable and field type, in Dubai, Kolkata and London (dates cross midnight in one and not the others);
  - missing values listed once, in order;
  - an unknown variable;
  - a phone-type custom field never rendered;
  - `*bold*` and `_italic_` runs, including unclosed marks left as text;
  - `VARIABLES` excludes contact fields.
- [ ] Run: `scripts/dev.sh run pnpm vitest run packages/core/src/messaging`. Expect FAIL (module not found).
- [ ] Implement, then run again. Expect PASS.
- [ ] Commit: `feat(core): templates render in the lead's own words — every field type, what's missing, never a contact`.

### Task 2: Data, starter templates and stage moves

**Files:**
- Create: `packages/db/migrations/0026_templates.sql`
- Modify: `packages/db/src/schema/*.ts` (tables and columns), `packages/db/src/schema.test.ts`, `packages/core/src/leads/presets.ts`, `apps/api/src/modules/pipelines/seed.ts`, `apps/api/src/modules/pipelines/routes.ts` + `service.ts`, the probes and the access-matrix tests

**Produces:**
- `message_templates (id uuid, name citext 1–80, category text CHECK in the five, allowed_role_ids uuid[] default '{}', current_version_id uuid, position int, created_by, created_at, updated_at, archived_at)`, with live names unique.
- `template_versions (id uuid, template_id → message_templates, body text 1–4096, created_by, created_at)`. `lume_app` may INSERT and SELECT only, with no UPDATE or DELETE.
- `leads.last_message_at`, `leads.last_reply_at` (timestamptz, nullable, indexed).
- `stages.after_sent_stage_id`, `stages.after_reply_stage_id` (uuid, nullable, referencing stages).
- Templates carry no lead data, so there is no row-level security. The backup role reads them through the default grants (a probe checks this).
- `Preset.templates: { name; category; body }[]` for both presets (six each), and `Preset.moves: { afterSent: [fromStageName, toStageName][]; afterReply: [from, to][] }`.
  - Coaching: New → Message sent after a send; Message sent → Replied after a reply.
  - General: New → Contacted after a send; none after a reply.
- The seed writes the templates (each with version 1) and the stage moves, **on new installs only**.
- The stage body accepts `afterSentStageId` and `afterReplyStageId` (null or a live stage of the **same pipeline**). Anything else is refused ("Pick a stage in this pipeline"). `stageView` returns both.

- [ ] Write the failing tests:
  - migration probes: the version table is immutable; a category outside the five is refused; the backup role reads both tables;
  - a new install has six templates with version 1 and the preset's moves;
  - a stage accepts a same-pipeline move and refuses another pipeline's stage;
  - the access matrix covers the new stage fields.
- [ ] Run them: expect FAIL. Implement, run: expect PASS.
- [ ] Commit: `feat(db): templates with their history, stage moves after a send or a reply, and starter wording for new installs`.

### Task 3: Templates API

**Files:**
- Create: `apps/api/src/modules/templates/routes.ts`, `service.ts`, `templates.test.ts`
- Modify: `apps/api/src/app.ts` (register), `apps/api/test/probes.ts`, `apps/web/src/lib/settings/audit.ts` (+ test)

**Interfaces:**
- Consumes: Task 1 (`TemplateCategory`, `TEMPLATE_CATEGORIES`), Task 2 tables.
- Produces:
  - `type TemplateView = { id; name; category; allowedRoleIds: string[]; versionId: string; body: string; position: number; updatedAt: string; usable: boolean }`;
  - `GET /api/v1/templates → { templates: TemplateView[] }`.
- Routes:
  - `POST /api/v1/templates { name, category, body, allowedRoleIds? }` → 201.
  - `PATCH /api/v1/templates/:id { name?, category?, body?, allowedRoleIds? }`: a changed body writes a new version and moves `current_version_id`.
  - `POST /api/v1/templates/:id/archive`.
  - `PUT /api/v1/templates/order { ids }`.
- **Permissions:** `templates.use` lists the templates the caller's roles may use (empty `allowedRoleIds` means all). `templates.manage` lists all and may write.
- **Refusals:** an unknown role id; a duplicate live name ("A template with that name already exists"); an empty body.
- **Audit:** `template.created`, `template.updated` (with `newVersion: true` when the body changed), `template.archived`, `template.reordered`. Each is phrased in the audit log.

- [ ] Write the failing tests:
  - a rep sees only templates their role may use, and a manager sees all;
  - an edit makes version 2, and version 1 still reads;
  - archived templates are hidden from the list but their versions stay;
  - order;
  - each refusal;
  - audit phrases;
  - every route is in the access matrix.
- [ ] RED, implement, GREEN.
- [ ] Commit: `feat(api): templates to write once and use everywhere — each edit a new version, each role its own`.

### Task 4: Sending, sent, replied and reopened

**Files:**
- Modify: `apps/api/src/modules/leads/messages.ts`, `apps/api/src/modules/leads/routes.ts`, `apps/api/src/modules/leads/write.ts` (`moveStage` writes `reopened`), `apps/api/src/modules/tasks/service.ts` (complete from a send), `apps/api/test/probes.ts`
- Create: `apps/api/src/modules/leads/sending.test.ts`

**Interfaces:**
- Consumes: Task 1 `render`, Task 2 columns, Task 3 versions.
- Produces:
  - **`POST /api/v1/leads/:id/messages/render { templateId?: uuid; text?: string } → { text, missing, versionId? }`** (`messages.send` on the lead). With a template it renders the current version. With text it renders the variables inside the text.
  - **`POST /api/v1/leads/:id/messages/prepare { text, templateVersionId?, taskId? } → { url }`**.
    - It checks that the version belongs to a template the caller may use; an archived one is fine for a version already shown.
    - The `whatsapp_opened` activity records `templateVersionId` and `taskId`.
  - **`POST /api/v1/leads/:id/messages/confirm { sent, taskId? } → { moved: { stageId, stageName } | null, notMoved?: { code, message } }`**. With `sent: true`:
    1. `whatsapp_confirmed_sent`, once per `whatsapp_opened` (a repeat changes nothing);
    2. `leads.last_message_at = now()`;
    3. completes `taskId` if it's still open and the caller may change it (3A rules);
    4. applies `after_sent_stage_id` through `moveStage`.
    - A refused move leaves the lead where it is and returns `notMoved` in words.
  - **`GET /api/v1/leads/:id/messages/context → RenderContext`** (`messages.send` on the lead): what `render` needs to preview locally in the editor and the send sheet. It carries only the name, the custom values of non-contact fields, the owner's name, business name, currency and timezone, fields and people. A test asserts that no phone, email or Instagram value is in it.
  - **`POST /api/v1/leads/:id/replied → { moved, notMoved? }`** (`leads.edit` on the lead): `reply_logged`, `last_reply_at`, `last_activity_at`, then the after-reply move.
  - **`moveStage`** writes a `reopened` activity (`{ from, to }`) whenever a lost lead moves to an open stage.

- [ ] Write the failing tests (`sending.test.ts`):
  - render: a template and freeform text, and a missing value;
  - Review Focus 1: a version shown before an edit still prepares, and its id is recorded;
  - Review Focus 2: a masked rep's render, confirm and replied bodies, and every error body, never contain the seeded number;
  - Review Focus 3: an archived custom field in the body comes back as missing, not an error;
  - Review Focus 4: confirming twice gives one confirmed activity and one move, and the follow-up is done once;
  - Review Focus 5: an after-sent move to a stage with a required field the lead lacks returns `notMoved`, and the lead and the logged send stay;
  - replied applies its move and stops an "until they reply" repeat;
  - Lost → New writes `reopened`;
  - a template the caller's role may not use is refused in words.
- [ ] RED, implement, GREEN. Run the whole API suite.
- [ ] Commit: `feat(api): send from a template, and know it went — sent completes the follow-up, a reply is one tap, each can move the lead`.

### Task 5: The Templates page (web)

**Files:**
- Create:
  - `apps/web/src/app/(app)/templates/page.tsx` (replacing the placeholder);
  - `apps/web/src/components/templates/TemplateLibrary.tsx`, `TemplateEditor.tsx`, `WhatsAppBubble.tsx`, `VariablePicker.tsx` (+ tests);
  - `apps/web/src/components/templates/templates.module.css`;
  - `apps/web/src/lib/templates/client.ts`

**Behaviour:**
- **Library:**
  - A grouped list by category (sticky group headers). Each card shows the name, the first line of the body in the secondary colour, and who can use it ("Everyone" or role names).
  - Managers can drag to reorder, and have a menu with Edit and Archive (with undo).
  - "New template" is the one primary action, top right.
  - Empty state: the LUME mark and "Write your first template". A rep with no usable templates sees "No templates for your role yet".
  - People without Manage templates see the library read-only; the page needs Use templates.
- **Editor:** a wide sheet with two panes that stack on phones.
  - **Left:**
    - name;
    - category as a segmented control;
    - the body textarea with `{{` autocomplete from `VARIABLES`, and a chip row above it (click to insert at the caret);
    - the character count (amber past 1,000, WhatsApp's practical limit);
    - "Who can use it" (Everyone, or roles).
  - **Right:** a WhatsApp-style bubble (a green-tinted bubble with a tail, and bold and italic rendered) previewing against a lead picked from a small search ("Preview as Aisha Khan"). Missing values show as amber tokens in the bubble.
    - The preview renders **locally** with `render`, on every keystroke, from the `RenderContext` fetched once when a preview lead is chosen (`GET /api/v1/leads/:id/messages/context`, Task 4). It never waits on the network per keystroke.
  - Saving says "Saved as version N" in the save bar, and the library card updates in place with a highlight fade.
- **Motion:**
  - the sheet rises with the default spring;
  - the bubble re-flows with `layout`;
  - chips pop in with a short spring;
  - reduced motion cross-fades.

- [ ] Write the failing tests:
  - grouping and order;
  - the read-only library for a rep;
  - autocomplete inserts at the caret;
  - the preview renders bold and italic and shows missing values;
  - the count;
  - saving a new version;
  - archive with undo;
  - axe.
- [ ] RED, implement with the apple-design skill loaded, GREEN.
- [ ] Commit: `feat(web): Templates — a library by category, and an editor that shows the message as WhatsApp will`.

### Task 6: Sending from anywhere (web)

**Files:**
- Create: `apps/web/src/components/messages/SendSheet.tsx` (+ test), `apps/web/src/components/messages/SentPrompt.tsx`, `apps/web/src/components/messages/messages.module.css`
- Modify:
  - `apps/web/src/components/leads/drawer/MessageButton.tsx` (it becomes the trigger for `SendSheet`);
  - `LeadDrawer.tsx` (They replied and Reopen, and R for replied);
  - `apps/web/src/lib/leads/history.ts` (+ test);
  - `apps/web/src/components/today/*` and `apps/web/src/components/notifications/NotificationCentre.tsx` (a WhatsApp action on follow-up rows);
  - `apps/web/src/lib/leads/client.ts`

**Behaviour:**
- **`SendSheet`** is anchored to its trigger (the follow-up sheet's popover pattern, form size).
  - The top is a template list: the context's category first (follow-up rows suggest Follow-up, lost leads Re-engagement), then the rest, then "Write your own".
  - Choosing one renders the message through `render` into an editable textarea, with missing tokens underlined in amber and one line under it ("Missing: lead.custom.package. Fill it in, or LUME sends it as is.").
  - **Open WhatsApp** (green, the one primary) uses today's hand-off: open a blank tab on the click, prepare, then point the tab at the link.
- **`SentPrompt`** replaces the drawer's inline "Sent?". It's a small glass pill that rises from the WhatsApp button when LUME has focus again, with Yes, sent and Not sent.
  - Yes plays `sent` and shows the move, if any: "Moved to Message sent", with undo, which moves it back.
  - A refused move shows its words.
- **The drawer:**
  - **They replied** is a secondary button beside WhatsApp (R). It plays `sent` and shows its move.
  - On lost leads, **Reopen** takes its place, with a stage menu defaulting to the first open stage.
- **Today and the notification centre:** follow-up rows gain a WhatsApp icon button that opens `SendSheet` with that follow-up's context. Sent completes it, and the row leaves with its done animation.
- **History wording:**
  - "WhatsApp sent · from “Gentle nudge”";
  - "They replied";
  - "Reopened · into New".

- [ ] Write the failing tests:
  - the sheet's template order by context;
  - render and edit;
  - the missing line;
  - prepare with the version id (and task id from a follow-up);
  - the Sent prompt showing a move and its undo;
  - a refused move's words;
  - They replied (button and R);
  - Reopen's menu;
  - history lines;
  - WhatsApp from a Today row completing it;
  - axe.
- [ ] RED, implement with the apple-design skill loaded, GREEN.
- [ ] Commit: `feat(web): send from a template wherever a lead is — and "They replied" is one tap`.

### Task 7: Stage moves in Pipeline & stages (web)

**Files:**
- Modify: `apps/web/src/components/settings/PipelineEditor.tsx` (+ test), `apps/web/src/lib/settings/pipelines.ts`, `apps/web/src/lib/leads/types.ts`

**Behaviour:**
- Each stage row's "Does" sheet (3C) gains a first section, **"Moves"**, with two selects:
  - "After a message is sent, move to" (None, or this pipeline's other stages);
  - "After a reply, move to".
- The summary under the stages lists them as sentences ("After a message is sent: moves to Message sent").
- It saves with the stage (the existing optimistic pattern) and takes back on refusal.

- [ ] Write the failing tests: choosing and saving each; the summary sentence; a refusal puts it back; axe.
- [ ] RED, implement, GREEN.
- [ ] Commit: `feat(web): each stage says where a lead goes after a message or a reply`.

### Task 8: End to end and acceptance

- **e2e (`messaging.spec.ts`):**
  - a manager writes a template with a custom-field variable and sees the preview;
  - a masked rep sends it from the drawer: the page never shows the number, a popup blocker isn't tripped, and they confirm Sent (the move to the next stage shows);
  - They replied;
  - WhatsApp from a Today follow-up completes it;
  - Reopen a lost lead;
  - screenshots (with full review copies) of the library, editor, send sheet, Sent prompt and the drawer's new actions, in both themes; axe.
- **The live script `apps/web/e2e-live/acceptance-4a.mjs`** (unmasked screenshots in `docs/runbooks/screenshots-4a/`): starter templates on a fresh install; send as a masked rep; confirm; replied; the chain gains it after 3C.
- **Runbook:** a "Phase 4A" section in `docs/runbooks/acceptance.md`.
- **Show the owner** the review copies of every new screen before calling 4A done (the design bar).
- Commit: `test(e2e): templates and sending, end to end`.

## Self-review

- **Coverage:**
  - spec §2 4A: templates (Tasks 1–3, 5), the send sheet (6), Sent completing follow-ups (4, 6), They replied (4, 6), stage moves (2, 4, 7), starter templates (2);
  - §3's rows for 4A (versions, variables, formatting, rendering, freeform, editing, role availability, after sent, replied, moves, reopen) are in Tasks 1–4;
  - §4's 4A tables and columns are in Task 2; §5's 4A routes are in Tasks 3 and 4; §6's 4A screens are in Tasks 5–7; §7's 4A tests are in Tasks 1–8.
- **Placeholders:** none; tests are named with their inputs and expected results (the standing ledger ruling).
- **Type consistency:** `render`/`RenderContext`/`VARIABLES`/`waFormat`/`TemplateCategory` (Task 1) are the names used in Tasks 3–6. `TemplateView` (Task 3) is used by Tasks 5 and 6. The `confirm` and `replied` shape `{ moved, notMoved? }` (Task 4) is used in Task 6.
- **Rulings** (the owner's to overturn):
  - R1. The spec's single migration is split per part: `0026_templates.sql` (4A), then 4B's and 4C's own.
  - R2. The move a Sent or a reply makes can be undone from the prompt (it moves back), because a person may disagree with the rule.
  - R3. The Sent prompt and They replied play `sent` (the sound table lists both).
  - R4. Stage moves after a send or a reply live in the 3C "Does" sheet under "Moves", not as two more controls on the crowded stage row: cleaner placement.
