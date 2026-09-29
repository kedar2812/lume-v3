# Phase 4B — Saved views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person names the groups of leads worth their time ("No reply 3+ days", "Lost — re-engage"), finds them in the sidebar with a live count, and opens them in one click. A manager can share a view with roles.

**Architecture:**
- A saved view stores the Leads list's own API filters (`FilterQuery`), so the list, the board counts and the view counts all run through the one `leadFilters()` function.
- Views are row-level secured: a person reads their own and those shared with one of their roles; managers (`views.manage`) also see every shared one. The request scope gains the caller's role ids and whether they manage views.
- Counts are one grouped query per sidebar load, under the viewer's own row-level security. They refresh when the live stream says leads changed: a statement-level trigger on `leads` notifies `lume_leads`, the hub fans out a data-free `leads` event, throttled per stream. Nothing polls.
- A person's order of their views is theirs (user preferences), not a shared column everyone fights over.

**Tech Stack:** as 4A: Fastify, Drizzle, Postgres 17 with row-level security, Next.js, vitest, Playwright, and Motion for springs.

**Spec:** `docs/superpowers/specs/2026-09-29-phase-4-whatsapp-templates-design.md` (§2 4B, §3 Saved views and View counts, §4 `saved_views`, §5 views routes and the new Leads filters, §6 The Views sidebar section and Seeds, §7 Views).

## Global Constraints

- **Design bar (owner, 2026-09-29):** "a really clean UI, it should stand up to the design we have built so far, clean animations and proper placement of components".
  - The apple-design skill applies to every screen.
  - Motion is interruptible springs, with reduced-motion cross-fades.
  - Every new screen has full, unmasked review copies in both themes, shown to the owner before it's called done.
- A view never shows a lead the viewer can't see: counts and lists run under the viewer's own row-level security, always.
- No client names or client stages. Seeded views are generic and name no stage (they use kinds and dates).
- Copy speaks as LUME. One accent blue; view colours come from the existing tag/stage colour tokens.
- Sound only on achievements: saving a view is silent.
- The gate (lint, typecheck, tests), TDD with RED watched, CI read after **every** push (the 4A lesson), and the live chain.

## Interaction and motion (apple-design, binding for Tasks 5–6)

Every value comes from the existing tokens (`SPRINGS`, `tokens.css`).

- **Response.** Every row, chip and button gives feedback on pointer-down (`:active` scale 0.97, 100 ms). A view click navigates at once; the list shows its skeleton, never a frozen page.
- **Springs.** A new view arrives in the sidebar with `SPRINGS.default`: it grows in place (height from 0, opacity) and the rows below make room. A removed view collapses the same way (with Undo). Counts change by cross-fading the digits, never by a counting animation that lies about the number.
- **Direct manipulation.** Drag to reorder views follows the pointer 1:1 from where it was grabbed (Motion `Reorder`, as the template library). Alt+↑/↓ on the handle does the same by keyboard.
- **Spatial consistency.** "Save view" is a popover growing from its button, beside the filters it saves. A view's menu grows from its row.
- **Materials.** Popovers are glass as elsewhere; no scrim (nothing modal in 4B).
- **Typography.** View names `--fs-sm` like nav labels; counts `--fs-xs`, `--text-3`, tabular numerals, right-aligned so they line up down the list.
- **Placement.** The Views section sits under the main navigation, above the spacer, with a small uppercase "Views" heading. "Save view" sits at the end of the filter bar, after the chips it saves. One primary action per surface ("Save").
- **Keyboard.** Views are links (Tab reaches them; Enter opens). The Save view popover: the name field takes focus, Enter saves, Esc closes.
- **Reduced motion.** Arrivals and removals cross-fade in 150 ms; drag still tracks 1:1.

Each UI task's tests include the reduced-motion path, the keyboard path, and (in e2e) axe in both themes. Review copies are shown to the owner before 4B is done.

## Review Focus

1. **A rep's count of a shared view.** "My overdue" shared with Sales counts only that rep's own leads, and the list shows the same number; an admin's count of the same view is the whole team's.
2. **A view that names something since removed** (an archived stage or field, a deleted tag or lost reason). Its count shows "—" instead of breaking the sidebar for everyone, and opening it drops the stale part of the filter (as the Leads page already does for a stale link).
3. **Sharing changes.** A person who loses the role a view was shared with no longer sees it on their next request; a view un-shared by a manager leaves other people's sidebars on the next load.
4. **A burst of lead changes** (a 500-row import, a bulk move of 200). Counts refresh once or twice, not hundreds of times, and never while nobody is looking at them.
5. **"New today" across midnight** in the business's timezone, not the server's or the browser's.

Each has its test in the owning task.

---

### Task 1: The new Leads filters (API)

**Files:**
- Modify: `apps/api/src/modules/leads/query.ts` (`FilterQuery`, `leadFilters`), `apps/api/src/modules/leads/routes.ts` (`listQuery`)
- Test: `apps/api/src/modules/leads/filters.test.ts` (new)

**Interfaces:**
- Produces: `FilterQuery` gains `noReplyDays?: number` (1–365), `lostDaysAgo?: number` (0–3650), `lostReasonId?: string` (uuid), `followUpOverdue?: boolean`, `createdDays?: number` (1–365). The zod `listQuery` gains the same (numbers coerced; `followUpOverdue` from `"true"`). Exported `filterQuerySchema` (the list query without cursor/limit, plus `sort`) for Task 3 to validate stored views with.

**Behaviour (each in the one `leadFilters`, so list, board and view counts agree):**
- `noReplyDays=N`: an open lead messaged at least N days ago and not answered since: `last_message_at <= now() - N days AND (last_reply_at IS NULL OR last_reply_at < last_message_at)` and its stage kind is `open`.
- `lostDaysAgo=N`: in a lost stage, lost at least N days ago (`lost_at <= now() - N days`).
- `lostReasonId`: lost for that reason (implies lost).
- `followUpOverdue=true`: has an open follow-up whose due time has passed (`EXISTS` on `tasks`, which row-level security already limits to leads the viewer sees).
- `createdDays=N`: the lead's enquiry date (`lead_created_at`) falls within today and the N−1 days before it, **in the business's timezone** (`settings.timezone`), whatever the server's zone. 1 means today.

- [ ] Write the failing tests (real database, seeded leads with set timestamps):
  - each filter picks exactly the right leads, and none of the wrong ones (a replied lead is not "no reply"; a lost lead is not "no reply"; a lead lost 10 days ago is in `lostDaysAgo=7` and not in `lostDaysAgo=30`; a done or cancelled follow-up is not overdue);
  - **Review Focus 5:** with the business in `Pacific/Auckland`, a lead created at 23:30 yesterday there and one at 00:30 today there — `createdDays=1` finds only the second, whatever `TZ` the test process runs in;
  - a masked rep's `followUpOverdue` never counts another rep's lead;
  - bad values are refused in words (`noReplyDays=0`, `createdDays=400`, a non-uuid reason).
- [ ] RED, implement, GREEN; run the leads suite.
- [ ] Commit: `feat(api): leads by what's gone quiet — no reply for days, lost a while ago, overdue follow-ups, new today`.

### Task 2: Views in the database, and "leads changed"

**Files:**
- Create: `packages/db/migrations/0027_saved_views.sql`, `packages/db/src/schema/views.ts`
- Modify: `packages/db/src/schema/index.ts`, `packages/core/src/rbac/catalog.ts` (`views.manage`), `apps/api/src/db/context.ts` (`applyRequestScope`), `apps/api/test/probes.ts`

**Interfaces:**
- Produces: table `saved_views` (`id`, `name` citext 1–40, `color` text, `filters jsonb`, `owner_id` → users, `shared_role_ids uuid[]` default `{}`, `position` int, `created_at`, `updated_at`, `deleted_at` for Task 3's Undo); Drizzle `schema.savedViews`.
- Produces: permission `views.manage` (group Leads, unscoped, "Share views", "Share saved views with roles, and manage shared ones").
- Produces: request settings `lume.role_ids` (`{uuid,…}`) and `lume.manage_views` (`on`/`off`), with SQL helpers `lume_role_ids()` and `lume_manages_views()`.
- Produces: channel `lume_leads`, notified (empty payload) by a statement-level trigger after INSERT, UPDATE or DELETE on `leads`.

**The migration:**
- `saved_views` with FORCE row-level security:
  - read: `owner_id = lume_user() OR shared_role_ids && lume_role_ids() OR (shared_role_ids <> '{}' AND lume_manages_views())`;
  - insert/update/delete: `owner_id = lume_user() OR lume_manages_views()`;
  - the backup role's read policy (the 3A lesson); `lume_worker` gets nothing.
- `views.manage` inserted into `permissions` (ON CONFLICT DO NOTHING; the boot sync keeps its words) and granted, unscoped, to every role that holds `users.manage` (the Admin preset's mark), so existing installs' admins can share at once. New installs get it through `ALL_GRANTS`.
- The `leads` trigger: `pg_notify('lume_leads', '')` once per statement. (Postgres folds identical notifications in one transaction into one, so a 500-row import in one transaction notifies once.)

- [ ] Write the failing probes (as 4A's): a rep reads their own view and one shared with their role, never another's personal view or one shared with a role they lack; a manager reads every shared view, not others' personal ones; a rep can't update or delete a shared view they don't own; the backup role reads all; the trigger notifies `lume_leads` once for a multi-row update in one transaction.
- [ ] RED, implement, GREEN; run the API matrix and probes.
- [ ] Commit: `feat(db): saved views, private or shared by role, and a signal when leads change`.

### Task 3: The views API, counts, and the seeded views

**Files:**
- Create: `apps/api/src/modules/views/{service,routes}.ts`, `apps/api/src/modules/views/views.test.ts`
- Modify: `apps/api/src/app.ts` (register), `packages/core/src/leads/presets.ts` (`STARTER_VIEWS`), `apps/api/src/modules/setup/service.ts` (seed after the owner and roles), `apps/web/src/lib/settings/audit.ts` (+ test: `view.created`, `view.updated`, `view.deleted`), `apps/api/test/probes.ts`

**Interfaces:**
- Produces:
  - `ViewView = { id, name, color, filters: FilterQuery & { sort }, shared: boolean, sharedRoleIds: string[], mine: boolean, canEdit: boolean }`;
  - `GET /api/v1/views` → `{ views: ViewView[] }` in the caller's order (preferences `viewOrder`, then any not in it, newest last);
  - `POST /api/v1/views` `{ name, color, filters, sharedRoleIds? }` → `ViewView` (201); sharing needs `views.manage`;
  - `PATCH /api/v1/views/:id` (any of those) → `ViewView`; `DELETE /api/v1/views/:id` → 204; `POST /api/v1/views/:id/restore` → `ViewView` (the Undo);
  - `PUT /api/v1/views/order` `{ ids }` → `{ views }` (the caller's own order, stored in their preferences);
  - `GET /api/v1/views/counts` → `{ counts: Record<viewId, number | null> }`.
  - All need `leads.view`.
- Deleting is a soft delete (`deleted_at`, added in Task 2's migration) so Undo can restore it; a name must be free among the caller's visible views.

**Behaviour:**
- Filters are validated with Task 1's `filterQuerySchema` and stored normalised (unknown keys dropped).
- Counts: one `SELECT count(*) FILTER (WHERE …) AS "v1", … FROM leads WHERE deleted_at IS NULL` built from `leadFilters` per view, under the caller's row-level security. A view whose filters no longer validate (an archived field, a deleted tag or reason, a stage that's gone) gets `null` (the sidebar shows "—"); the rest still count (**Review Focus 2**).
- `ownerId: "me"` means the viewer, so a shared "My overdue" is each person's own.
- Seeds for new installs (`STARTER_VIEWS`, the same for every preset, owned by the owner, shared with every role that exists at setup): "My overdue" (`ownerId: me, followUpOverdue`), "New today" (`createdDays: 1`), "No reply 3+ days" (`noReplyDays: 3`), "Lost — re-engage" (`lostDaysAgo: 30`). Setup sets `lume.user_id` to the new owner before seeding, so row-level security applies to the seed as to everything else.

- [ ] Write the failing tests:
  - create personal; create shared (manager) and refused for a rep with 403 "Sharing views is for people who manage them"; edit; delete and restore; a taken name is 409;
  - order is per person: a rep reordering doesn't change the admin's order;
  - **Review Focus 1:** "My overdue" shared with Sales: the rep's count is their own overdue leads, the admin's is everyone's, and each equals the list's total for the same filters;
  - **Review Focus 2:** a view filtering on a field that's then archived counts `null`, and the other views still count;
  - **Review Focus 3:** a rep removed from the role a view was shared with no longer lists it on the next request;
  - a new install has the four views, shared with Admin and Sales, and each counts without error;
  - audit words for create, update and delete.
- [ ] RED, implement, GREEN; run the API suite and matrix.
- [ ] Commit: `feat(api): saved views with live counts, shared by role, and four to start with`.

### Task 4: "Leads changed" on the live stream

**Files:**
- Modify: `apps/api/src/modules/notifications/hub.ts` (LISTEN `lume_leads`, `onLeads(fn)`), `apps/api/src/modules/notifications/routes.ts` (the stream sends `event: leads`), `apps/web/src/lib/notifications/stream.ts` (`useLeadsChanged(fn)`)
- Test: `apps/api/src/modules/notifications/stream.test.ts` (extend), `apps/web/src/lib/notifications/stream.test.ts` (extend)

**Interfaces:**
- Produces: hub `onLeads(listener): unsubscribe`; stream event `leads` with data `{}` and **no id** (so the browser's Last-Event-ID stays the notifications'); web `useLeadsChanged(fn: () => void)`.

**Behaviour:**
- The hub's one listening connection also LISTENs `lume_leads` and tells every subscribed stream.
- Each stream sends at most one `leads` event per 3 s (the first at once, then one trailing), so a burst becomes one or two (**Review Focus 4**). The payload says only "something changed": which leads, and whose, is never sent; each browser asks for its own counts under its own row-level security.
- On the web, `useLeadsChanged` shares the tab's one EventSource with notifications. The sidebar asks for counts only when the tab is visible; a hidden tab marks itself stale and asks once when it's shown again.

- [ ] Write the failing tests: a lead update reaches an open stream as one `leads` event with no id; ten updates within a second arrive as at most two; a notification still arrives with its id and resumes correctly after a `leads` event; on the web, the hook fires on `leads` and not on `notification`, and a hidden tab defers until visible.
- [ ] RED, implement, GREEN.
- [ ] Commit: `feat: the live stream says when leads change, so counts stay true without polling`.

### Task 5: The new filters on the Leads screen

**Files:**
- Modify: `apps/web/src/lib/leads/filters.ts` (+ test), `apps/web/src/components/leads/FilterBar.tsx` (+ `LeadsScreen.test.tsx`), `apps/web/src/components/leads/leads.module.css`

**Behaviour:**
- `ListFilters` gains `noReplyDays`, `lostDaysAgo`, `lostReasonId`, `followUpOverdue`, `createdDays`; each round-trips through the address bar (`noreply`, `lost`, `reason`, `overdue`, `new`) and `apiQuery`, and a bad value in a pasted link is dropped, as today.
- **More filters** is always there now, with a "Follow-ups and replies" group above the custom fields:
  - "Overdue follow-up" (a switch);
  - "No reply for" (Any, 1, 3, 7, 14 days);
  - "Lost" (Any, 7+, 30+, 90+ days ago) and, when set, "Reason" (the business's lost reasons);
  - "Added" (Any, Today, Last 7 days).
- Each active one shows as a removable chip after the controls ("No reply 3+ days ×"), counts in the active-filter count, and clears with Clear all.

- [ ] Write the failing tests: parse/serialise round trips and stale values dropped; each control sets its filter and its chip; the chip removes it; the reason select appears only with Lost; Clear all clears them.
- [ ] RED, implement with the apple-design skill loaded, GREEN.
- [ ] Commit: `feat(web): filter leads by what's gone quiet, from More filters`.

### Task 6: Views in the sidebar, and Save view

**Files:**
- Create: `apps/web/src/lib/views/client.ts`, `apps/web/src/components/views/{SidebarViews,SaveView,ViewMenu}.tsx`, `apps/web/src/components/views/views.module.css`, `apps/web/src/components/views/Views.test.tsx`
- Modify: `apps/web/src/components/shell/Sidebar.tsx` (render `SidebarViews` under the nav when the person may view leads), `apps/web/src/components/leads/{FilterBar,LeadsScreen}.tsx` (Save view; opening `?view=`), `apps/web/src/app/(app)/leads/page.tsx` (a `view` param loads that view's filters)

**Behaviour:**
- **The sidebar section** "Views": each view a link row with its colour dot, name and count (tabular, "—" when `null`). The active view (the Leads page opened with `?view=<id>`) carries the nav pill's highlight. Drag the handle (shown on hover or focus) or Alt+↑/↓ to reorder; the order saves as the person's own.
- **Counts** load with the section and refresh on `useLeadsChanged`, and after a view is saved, edited or deleted.
- **Opening a view** goes to `/leads?view=<id>`: the page loads the view's filters (dropping anything stale, Review Focus 2) and shows the view's name above the filters, with its menu. Changing a filter then shows "Update view" beside Save view (for a view the person may edit).
- **Save view** (end of the filter bar, only when at least one filter is set): a popover with Name (focused), eight colour swatches, and — for someone with `views.manage` — "Just me" or "Share with…" and role pills. Save (Enter) closes it; the view arrives in the sidebar with the spring and becomes the active one.
- **The view menu** (a row's ⋯, and beside the view's name on Leads): Rename, Colour, Share (managers), Delete. Delete removes it at once with an Undo note ("Deleted “No reply 3+ days”" · Undo).
- Someone who can only read a shared view (not theirs, no `views.manage`) sees no Rename, Share or Delete.

- [ ] Write the failing tests: the section lists views with counts and "—"; a click opens `/leads?view=`; `leads` stream events refresh counts (once for a burst); Save view with Just me, and with Share for a manager, and no Share for a rep; the new row arrives and is active; Update view after a change; rename; delete with Undo; keyboard reorder; a read-only shared view has no edit actions; the reduced-motion path.
- [ ] RED, implement with the apple-design skill loaded, GREEN.
- [ ] Commit: `feat(web): saved views in the sidebar with live counts, saved from the filters in one step`.

### Task 7: End to end and acceptance

- **e2e (`views.spec.ts`):**
  - the four seeded views are in the sidebar with counts;
  - a manager filters (No reply 3+ days), saves "Chase list" shared with Sales; a masked rep sees it with their own count, opens it, and the list total equals the count;
  - a lead change elsewhere updates the count without a reload;
  - reorder by drag; delete with Undo;
  - screenshots (full review copies) of the sidebar section, Save view, the view's header on Leads and More filters, in both themes; axe.
- **The live script `apps/web/e2e-live/acceptance-4b.mjs`** (unmasked screenshots in `docs/runbooks/screenshots-4b/`): the seeded views on a fresh install; save and share a view; the rep's count; the chain gains it after 4A.
- **Runbook:** a "Phase 4B" section in `docs/runbooks/acceptance.md`.
- **Show the owner** the review copies of every new screen before calling 4B done.
- Commit: `test(e2e): saved views, end to end`.

## Self-review

- **Coverage:** spec §2 4B (views, sharing, sidebar with counts, filters, seeds) → Tasks 1–6; §3 Saved views and View counts → Tasks 2–4; §4 `saved_views` → Task 2; §5 views routes and the four filters (plus `createdDays` for "New today") → Tasks 1 and 3; §6 The Views sidebar section and Seeds → Tasks 3 and 6; §7 Views → Tasks 1–7.
- **Placeholders:** none; tests are named by what they prove (the standing ruling: written in full, first).
- **Type consistency:** `FilterQuery`/`filterQuerySchema` (Task 1) are what Task 3 stores and counts; `ViewView` (Task 3) is what Task 6's client reads; `useLeadsChanged` (Task 4) is what Task 6 refreshes on.
- **Rulings** (the owner's to overturn):
  - R1. "New today" needs a relative date the spec's four filters don't have: `createdDays` (1 = today, in the business's timezone) is added.
  - R2. A person's order of views is theirs (their preferences), not the shared `position` column, so one person's drag never reorders everyone's sidebar. `position` stays as the default order.
  - R3. Deleting a view is soft, so Undo can bring it back (as templates' archive).
  - R4. Seeded views are owned by the owner and shared with every role that exists at setup. A role created later sees them once a manager shares them with it.
  - R5. Existing installs' admins get `views.manage` through the migration (roles holding `users.manage`), so sharing works on day one after the update.
