# LUME Phase 1C — Screens, Onboarding and Product Tour: Design

**Date:** 2026-09-24 · **Status:** approved in brainstorming
**Implements:** `docs/LUME_PROJECT_REPORT.md` §4.1, §4.4, §6 (customisation UX), §7 (three enforcement layers, UI side), §12.2 (anti-leak UI), §14 (search, filters, table, board), §15.3 (first-run wizard), §16 (UX requirements and required screens, incl. §16.1 #10 per-user welcome), §17 Phase 1.
**Builds on:** `2026-09-21-lume-frontend-design.md` (visual system, approved prototypes), `2026-09-21-phase-1-identity-rbac-leads-design.md` (the API this consumes), Plans 1A and 1B (built and accepted).

The report is authoritative. This spec records what Phase 1C builds, the owner's new decisions about onboarding and the product tour, and the choices the report leaves open for the browser side.

## 1. Owner decisions (2026-09-22 / 09-24)

| # | Decision |
|---|---|
| 1 | **Every person gets a first-sign-in onboarding form.** It collects name, timezone, theme, working days and hours, morning digest time, alert and sound preferences, and offers Google Calendar (everyone) and Google Sheets (admins) connections. Every step is skippable and everything stays editable in Settings. |
| 2 | **Onboarding layout:** the approved blend — the real app blurred behind a glass sheet (so LUME is visible from the first second), a step rail on the left with ticks and jump-back, one calm question at a time on the right, and the soft blue aura over everything. Finishing dissolves the sheet into the app. |
| 3 | **Name first.** An invited person confirms their name (pre-filled from the invite) before anything else, including the required two-step setup for admins, so their authenticator entry reads `LUME · <business> (<name>)`. |
| 4 | **Product tour: spotlight only.** A gaussian-blurred background with one sharp, rounded highlight; a short line per step; **module names in bold** so people learn the vocabulary; progress bar with Back / Skip; arrow keys, Enter, Escape and click-anywhere advance. Replayable from Settings. No checklist card. |
| 5 | **The tour explains all of LUME, briefly.** One idea per step, ~15 steps for a sales rep and ~18 for an admin, built from the person's permissions so nobody is shown a place they can't open. |
| 6 | **Scrollbars everywhere follow the app's own rule** (spec §4.4): thin, token-coloured, invisible until hover or scroll, with a soft fade where scrolling content meets fixed controls. Never the browser default. |
| 7 | **Third-party marks are official files.** Google Calendar, Google Sheets and the Google "G" use Google's own brand assets, unmodified, bundled with the app (as with `lume-mark.png`, which is never regenerated). |
| 8 | **Integrations are pulled forward** so the onboarding Connect step is real from day one: Google Sheets intake (report §8.1, originally Phase 2) and Google Calendar connect (report §9.1, originally Phase 5) are built straight after 1C, before later phases. |
| 9 | **Reliability and scale gets its own phase** immediately after those integrations, with evidence like Phase 0 had. |

## 2. Split

| Plan | Delivers | Acceptance |
|---|---|---|
| **1C-1 Getting in** | web↔API session and permission wiring; setup wizard; sign-in + 2FA + recovery; invite acceptance; forgot/reset password; per-person onboarding; spotlight tour engine; the small API additions for preferences, onboarding state and tour state | Playwright: setup → invite → 2FA sign-in → onboarding (all steps, and skipping) → tour (finish and skip) → replay from Settings. axe clean on every new route in both themes; visual baselines for both themes; a rep, an admin and the owner each get their own step list |
| **1C-2 Leads** | leads table (columns, filters, sort, inline edit), Kanban board with drag and keyboard moves, lead drawer (details, notes, history), Reveal, WhatsApp message hand-off, bulk actions, duplicate warnings, empty and error states | Playwright: create lead → move stages (required fields and lost reason prompts) → reveal → reassign (previous rep loses it) → bulk change → duplicate warning. A masked role's table renders no contact column and no export control, and the API refuses those anyway |
| **1C-3 Settings** | Settings home plus Business, Pipeline & stages, Fields, Lost reasons, Tags, Products, People, Roles & access (permission matrix + field access), Teams, My sessions & 2FA, Audit log, About | Playwright: rename a stage, add a field and see it on the lead form, hide a field from a role and see it vanish for that role, invite and disable a person (their session dies), read the audit log. Every page refuses gracefully when access is lost mid-visit |

Order: **1C-1 → 1C-2 → 1C-3 → Sheets intake → Calendar connect → reliability phase.** Each plan lands on `main` with CI green and a live acceptance run, as in 1A and 1B.

## 3. Architecture: how the browser and the API fit together

Phase 1's architecture decision (spec §1) stands: **server components call the API internally; the browser calls the API same-origin; the web app never touches Postgres.**

- **Server-side session:** one helper (`apps/web/src/server/session.ts`) calls `GET /api/v1/auth/me` with the incoming `__Host-lume_session` cookie, memoised per request (React `cache`). It returns `{ user, permissions, twoFactor, onboarding, tour }` or null.
- **Permission helpers** mirror `packages/core`'s engine, with the *same* `can` / `scopeOf` / `canOnRecord` functions imported from `@lume/core`, so the browser never re-implements the rules. Nav items, buttons and columns render from those permissions.
- **Hiding is never the only defence.** Every server component fetches through the API, which enforces the same rules and returns 404 for out-of-scope records. UI gating is a courtesy, not a control (report §7.4).
- **Mutations** go to `/api/v1/...` from the browser with the CSRF header (the existing `auth-client.ts` helper), then `router.refresh()` so server-rendered data updates. No client-side data store; the server is the source of truth.
- **Loading:** every route has a skeleton that matches the final layout's dimensions, so nothing jumps (frontend spec §5.3).
- **Errors:** a shared `ErrorState` for 4xx/5xx with a friendly line, the field-level messages from the API's `details`, and a retry. A lost API connection keeps the shell and shows a "reconnecting" strip. `409 VERSION_CONFLICT` shows "Someone else changed this lead. Reload and try again" with a one-click reload of just that lead.
- **Idempotency:** every mutating browser call sends an `Idempotency-Key` (a UUID v7 per user action), so double-clicks and retries never duplicate (report §4.4, built in 1B).
- **Route protection:** `proxy.ts` keeps its nonce CSP and adds the rules "no session → `/sign-in`", "pending 2FA → `/sign-in/2fa`", "session but onboarding unfinished → `/welcome`". The API stays the authority; the proxy only saves a round trip.

## 4. Onboarding

### 4.1 Flow

Steps are chosen from the person's permissions and state:

| Step | Who | Skippable | Collects |
|---|---|---|---|
| Welcome | everyone | — | nothing; sets expectations and time ("about a minute") |
| You | everyone | yes | display name (pre-filled from the invite), timezone (pre-filled from `Intl.DateTimeFormat().resolvedOptions().timeZone`, with a searchable list) |
| Secure your account | anyone whose roles require 2FA and who hasn't enrolled | **no** | TOTP enrolment (QR + manual key) and recovery codes, reusing the 1A endpoints. The authenticator label is `LUME · <business> (<name>)` |
| Look | everyone | yes | theme: Porcelain / Obsidian / match device, previewing live on the app behind the sheet |
| Your day | everyone | yes | working days, working hours, morning digest time; a plain-language preview sentence |
| Alerts | everyone | yes | achievement sounds on/off + volume (with a sample), which alerts they want in LUME and by email. Admins additionally see "security alerts: always on" |
| Your team | `users.manage` | yes | invite by email with a role picker; shows who already exists, including other admins and pending invites, and who invited them |
| Pipeline | `pipelines.manage` | yes | review the preset's stages (rename, reorder, add); shows "reviewed by <admin> <when>" if another admin already did it |
| Connect | Calendar: everyone with `calendar.connect`; Sheets: `leads.import` | yes | Google Calendar (per person) and Google Sheets (shared, admin). Shows the existing state when another admin already connected the sheet |
| Done | everyone | — | offers the tour or "explore on my own" |

**Multiple admins** never collide: workspace steps (Your team, Pipeline, Sheets) read live state and show what another admin already did, with who and when. They stay editable; nothing is hidden because someone else went first.

**The owner** skips "Secure your account" (done during setup) and sees the workspace steps, since setup already collected the business details.

### 4.2 Data

Migration `0011_user_onboarding.sql` adds to `users`:

- `preferences jsonb not null default '{}'` — validated by a Zod schema in `packages/core/src/users/preferences.ts` (shared by API and web): `{ workingDays: number[], workStart: "HH:MM", workEnd: "HH:MM", digestTime: "HH:MM", sounds: { enabled: boolean, volume: 0..100 }, alerts: { assigned: boolean, dueFollowUps: boolean, emailDigest: boolean } }`. Unknown keys are rejected. Defaults: working days Monday–Friday, 09:00–18:00, digest 08:00, sounds on at 60, all three alerts on.
- `onboarding jsonb not null default '{}'` — `{ step: string, skipped: string[], completedAt: string | null }`.
- `tour jsonb not null default '{}'` — `{ version: number, step: number, completedAt: string | null, skippedAt: string | null }`.

API additions (`auth.self`, with the 1A/1B rules unchanged):

- `PATCH /api/v1/me` also accepts `preferences` (deep-merged, validated).
- `PUT /api/v1/me/onboarding` — `{ step?, skipped?, completed? }`.
- `PUT /api/v1/me/tour` — `{ step?, completed?, skipped? }`.
- `GET /api/v1/auth/me` also returns `preferences`, `onboarding`, `tour`, and `flags: { needsOnboarding, needsTwoFactorEnrolment }`.

Preferences are stored now and consumed by later phases (reminders, digests, notification centre) exactly as the report describes; 1C only stores and shows them.

### 4.3 Definition in code, not in the page

`packages/core/src/onboarding/steps.ts` exports the ordered step list with each step's `id`, `title`, `permission | null`, `required: boolean` and `appliesWhen(actor, state)`. Both the API (to compute `needsOnboarding`) and the web app (to render) read the same list, so they can never disagree.

## 5. Product tour

- **Spotlight:** a full-screen veil with `backdrop-filter: blur(9px)` and a token-coloured tint, and a rounded hole cut out with `clip-path: path(evenodd, …)` so exactly one element stays sharp. A 2px accent ring with a soft glow sits on the hole. Hole, ring and card move together with the approved springs. Where `clip-path: path()` is unsupported, the veil stays whole (a plain dim) and the ring still marks the target.
- **Card:** kicker ("Step 4 of 15" + "Esc to skip"), a short title, one sentence (**module names bold**), a progress bar, Back / Skip tour / Next.
- **Advance:** Next, click the veil, Enter, or →. Back, ←. Escape skips. Focus moves into the card on each step; the highlighted element is described to screen readers via `aria-describedby`, and the tour is a labelled dialog. With "reduce motion", movement becomes a cross-fade.
- **Steps** live in `packages/core/src/tour/steps.ts`: `{ id, target: string (data-tour attribute), title, body, permission | null, placement }`. Targets are marked in the UI with `data-tour="today"` etc., so a refactor can't silently break the tour (a test asserts every step's target exists).
- **Coverage (rep, ~15):** LUME itself · **Today** · the four numbers · a lead row · **Reveal** · **Message** · **Leads** · **Pipeline** · **Calendar** · **Templates** · **Analytics** · **Ctrl K** · reminders bell · **Settings** · profile. **Admin adds (~3):** Settings as the place LUME is shaped · People and roles · the audit log.
- **Versioned:** `TOUR_VERSION` in code. A later phase that adds screens can raise it and show only the new steps, once, as "What's new".
- **Replay** from Settings → Help, and from the profile menu.

## 6. Leads screens (1C-2)

- **Table:** cursor-paged (never more than 100 rows per request), chosen and reorderable columns, sort, inline edit where field access allows, and a filter bar: stage, owner (me / unassigned / person), tag, date range, phone status and any filterable custom field. A masked role's table has **no contact columns at all** and no export control (report §12.2 #4). Search is by name for masked roles; contact search appears only for roles that may see full contacts.
- **Board:** one column per stage of the chosen pipeline, counts per column, drag to move with the approved spring. Dropping into a stage with required fields opens a small form; dropping into a `lost` stage asks for the reason. **Keyboard equivalent:** select a card, `Space` to pick up, arrows to move, `Enter` to drop (the board is not drag-only).
- **Lead drawer:** opens over the list, full page on phones. Header (name, stage, owner, value), tabs for Details (core + custom fields, inline editable per field access), Notes, and History (stage changes, assignments, reveals, messages, edits — from the activity list). Reveal sits next to the masked contact and states plainly that it was recorded.
- **Create lead:** a sheet with name, contact, stage, owner (if allowed), value, tags and custom fields. Duplicate warning appears as the phone or email is typed, naming the owner only when the caller may see that lead, otherwise "a lead with this phone already exists".
- **Bulk:** select rows → change stage, assign, add/remove tags, delete. The result reports what was skipped and why ("3 moved, 1 skipped: needs a lost reason").
- **Empty, loading and error states** for every surface, including "no leads yet" with a create button and "nothing matches these filters" with a clear-filters action.

## 7. Settings screens (1C-3)

One home with cards, and one page per area:

| Page | Permission | Notes |
|---|---|---|
| Business | `settings.manage` | name, timezone, currency, default country, week start; logo is the owner's file, never generated |
| Pipeline & stages | `pipelines.manage` | drag to reorder, colours, kinds, required fields, SLA hours; archive asks where its leads go |
| Fields | `fields.manage` | add/edit custom fields with a **live preview of the lead form**; option editing keeps ids; archive, never delete; type changes are refused with the reason |
| Lost reasons · Tags · Products | `pipelines.manage` / `settings.manage` | simple lists with archive/delete |
| People | `users.manage` | invite, resend, revoke, disable/enable, end sessions, reassign their leads on disable |
| Roles & access | `roles.manage` | permission matrix with scope pickers, plus per-field hidden/view/edit; refuses to grant what the editor doesn't hold, with a clear message |
| Teams | `teams.manage` | teams and team leads (which drives `team` scope) |
| My sessions & 2FA | `auth.self` | current sessions with device and last-seen, revoke others, enrol/disable 2FA, regenerate recovery codes, replay the tour |
| Audit log | `audit.view` | cursor-paged, filter by action, person, entity; states plainly that it cannot be edited |
| About | `auth.self` | version, restore-test status, links to runbooks |

## 8. Quality bars (every plan)

- **End-to-end (Playwright, in the toolbox image):** the flows named in §2, run against the real stack, reading invite and reset emails from Mailpit's API.
- **Accessibility:** axe on every route in both themes; keyboard paths for every action including the board; visible focus; `prefers-reduced-motion` honoured; contrast ≥ 4.5:1 for text (the 1A/1B token work already enforces this).
- **Visual baselines:** every route in both themes, plus **role snapshots** (owner, admin, sales rep) of Today, Leads, a lead drawer and Settings home, so a control can never leak into a rep's screen unnoticed.
- **Tour and onboarding integrity tests:** every step's target exists in the rendered app; every step's permission is a real catalog key; a rep's list contains no admin step.
- **Standing rules:** superpowers:systematic-debugging for any failure (reproduce → find the cause → fix the cause, never the symptom), and superpowers:verification-before-completion before any claim of done (run the command, show the output). The full gate (`lint`, `typecheck`, all tests) runs before every commit, and CI is watched after every push.

## 9. Out of scope for 1C

Notification centre and reminders (Phase 3, though preferences are collected now); WhatsApp send queue and template management (Phase 4, the Message hand-off is a link only); calendar screens beyond connecting (Phase 5); analytics screens (Phase 7); saved views and CSV import (later); country picker and bulk phone fix (with the pulled-forward Sheets work); exports and watermarking (Phase 6).

## 10. Dependencies on the owner

1. **Google Cloud project for Calendar**, owned by LUME (not by Kedar personally and never by a client), with LUME’s OAuth consent screen and each client subdomain as a redirect URI. Google’s verification of the sensitive calendar scope takes weeks, so start it during 1C-1 (report §9.1). Agreed order (2026-09-24):
   1. buy the LUME domain;
   2. create the LUME Google account on that domain — Google Workspace (own organisation, real mailbox, survives any change of hands; recommended) or a free Google account whose username is the domain address, with mail hosted elsewhere;
   3. publish the landing page **including privacy policy and terms pages** — Google requires both, so the landing page is on the critical path for calendar access;
   4. verify the domain in Search Console **with that same account**;
   5. create the Cloud project, brand the consent screen as LUME with those links;
   6. add the `calendar.events.readonly` scope and submit for verification; create the Sheets service account in the same project (no review needed, so sheet intake can ship first).

   Guardrails: two owners on the project so nobody can be locked out, two-step sign-in on the LUME account, recovery codes kept offline. One LUME project serves every client. **Calendar connect is therefore built last in the pulled-forward group, to give the review the most time.**
2. **A Google service account** for Sheets (no verification needed), and the client sharing the sheet with it as Viewer (report §8.1).
3. **Tasneem's confirmations** still open: the final Struggles options and lost reasons (preset values are editable in Settings), and the email provider (`SMTP_URL`) for production.
