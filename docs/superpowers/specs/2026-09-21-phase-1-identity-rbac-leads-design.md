# LUME Phase 1 — Identity, RBAC and Core Data: Design

**Date:** 2026-09-21 · **Status:** approved in brainstorming
**Implements:** `docs/LUME_PROJECT_REPORT.md` §5.1–5.3, §5.5 (audit_log), §6, §7, §8.3–8.4 (manual create + phone normalisation only), §12.1–12.2, §12.4, §14 (Phase 1 subset), §15.3, §16.1 (screens listed below), §17 Phase 1.
The report is authoritative. This spec records the owner's decisions, how Phase 1 is split, and the choices the report leaves open. UI follows `2026-09-21-lume-frontend-design.md` and the approved prototypes.

## 1. Owner decisions (report §18)

| # | Decision |
|---|---|
| 4 | **Sales reps see contacts masked, with a metered Reveal.** Seeded Sales role gets `leads.contact.reveal:own`, not `leads.contact.full`. |
| 9 | **Teams are built now.** `own / team / all` scopes all work from day one. |
| 2 | **Email provider decided later.** Phase 1 sends through SMTP to **Mailpit** on the dev stack. Production needs only `SMTP_URL` + `MAIL_FROM`. |
| 7 | Nupuur preset uses the report's stages (New → Message sent → Replied → Call booked → Call done → Won / Lost, plus Follow-up later) and fields (`struggles` = multi-select, `handled_by` = user). All editable in Settings; Tasneem can adjust them later without code. |

Architecture choice: **server-rendered pages call the API internally** (`http://api:3001` over the Docker network, forwarding the session cookie). Browser mutations call same-origin `/api/v1`. All authorisation lives in the API. The web app never touches Postgres.

## 2. Split

| Plan | Delivers | Acceptance |
|---|---|---|
| **1A Identity & access** | schema for identity + settings + audit_log; setup wizard API; Argon2id auth; TOTP 2FA + recovery codes; server-side sessions; CSRF; login throttling/lockout; invites; password reset; permission catalog + sync; roles/teams/user admin APIs; effective-permission engine with NOTIFY-busted cache; per-request transaction with `SET LOCAL`; RLS helper functions; audit writer; Mailpit | route × role matrix green for all 1A routes; disabling a user kills their sessions within one request; audit append-only proven |
| **1B Configuration & leads** | pipelines/stages/fields/lost reasons/tags/products APIs; industry presets; leads + lead_tags + stage/assignment history + activities; runtime custom-field validation; phone normalisation; masking serializer + Reveal; field-level access; search/filters; RLS policies on lead tables; idempotency keys; optimistic concurrency | matrix green for every route; a sales user can't read an out-of-scope lead via any endpoint **or** raw SQL as `lume_app` |
| **1C Screens** | wired sign-in/2FA; setup wizard; invite acceptance; password reset; leads table + Kanban + bulk actions; lead drawer; settings (Business, Pipeline & stages, Fields, Lost reasons, Tags, Products, Users, Roles & access, Teams, My sessions & 2FA, Audit log) | Playwright E2E: setup → invite → 2FA sign-in → create lead → move stages → reveal → reassign (rep loses access) → disable user (session dies); axe + visual green in both themes |

Order: 1A → 1B → 1C. Each gets its own plan in `docs/superpowers/plans/`.

## 3. Decisions the report leaves open

### Auth & sessions
- **Argon2id** via `@node-rs/argon2`: memoryCost 65536 KiB, timeCost 3, parallelism 1 (2 vCPU host). Hashes are re-checked and upgraded on login if parameters change.
- **Breached-password list:** the UK NCSC top-100k list (SecLists `100k-most-used-passwords-NCSC.txt`) as sorted SHA-1 hashes bundled as a sorted binary file in `packages/core/data/`. Lookup by binary search. Passwords are checked hashed, never logged.
- **Constant-time login:** unknown emails run a dummy Argon2 verify, so response time never reveals whether an account exists.
- **Throttling:** per-IP and per-account counters in Postgres (`auth_throttle` table, sliding window), progressive delay (0 / 1 / 2 / 4 … s capped at 30 s), 15-minute lock after 10 failures. Caddy rate limits remain the outer layer.
- **TOTP:** implemented directly on node:crypto (RFC 6238, verified against the RFC test vectors; no dependency), SHA-1, 6 digits, 30 s, window ±1. The last used time-step is stored to block replays. Secrets are AES-256-GCM encrypted (§12.5) with a data key wrapped by `LUME_MASTER_KEY`.
- **Recovery codes:** 10 × 10 characters from a 31-symbol unambiguous alphabet (~49 bits each), stored as SHA-256 (high-entropy random secrets need no slow hash; Argon2 would cost ten 64 MB hashes per attempt), single use.
- **2FA mandatory** when the user is the owner, or holds `users.manage`, `roles.manage`, `leads.export`, `security.manage`, or `leads.contact.full` with scope `all`. Such a user is forced through enrolment before any other route works (`403 TWO_FACTOR_REQUIRED` → UI enrolment screen).
- **Sessions:** token = 32 random bytes (base64url) in `__Host-lume_session`. The DB stores `sha256(token)` as the id. Idle timeout 12 h and absolute 7 d, both from `settings.security`. `last_seen_at` is written at most once per minute. Rotation happens on login, 2FA completion and any change to the user's roles.
- **CSRF:** SameSite=Lax + `Origin`/`Sec-Fetch-Site` check + double-submit token (`__Host-lume_csrf` cookie, readable by JS, echoed in `X-CSRF-Token`) on every non-GET.
- **Per-role login restrictions** (IP allowlist, allowed hours in business timezone) are evaluated at login **and** on each request.

### Permission engine
- Catalog in `packages/core/src/rbac/catalog.ts`: a typed array (key, group, label, description, scoped). It's synced to `permissions` on API boot (insert/update, never delete, since removed keys are marked retired).
- `Actor` = `{ userId, isOwner, perms: Map<key, scope | true>, teamMemberIds: string[], fieldAccess: Map<fieldId, "hidden"|"view"|"edit"> }`. Built once per request.
- Cache: in-process LRU keyed by user id, TTL 30 s. `LISTEN lume_rbac` clears entries on any role, user_role, role_permission, team or field-access change. Those changes `NOTIFY` in the same transaction.
- `requirePermission(key)` is used by route config. `scopeOf(actor, key)` → `own|team|all|null`. The pseudo-permission `auth.self` means "any signed-in, fully authenticated user" (used for /me and logout).
- The owner bypasses permission checks but is still subject to RLS scope `all` (the owner sees everything, through the same code paths).

### Database access per request
- Every authenticated request runs inside one transaction on a `lume_app` connection. It begins with `SET LOCAL lume.user_id`, `lume.lead_scope` (the widest `leads.view` scope), and `lume.team_member_ids` (a text array literal).
- SQL helper functions `lume_user()`, `lume_scope()`, `lume_team_members()` are `STABLE` and read `current_setting(..., true)`. With no settings, the policies return **no rows** (fail closed).
- RLS is `ENABLE` + `FORCE` on leads and all lead-child tables. Child policies use `EXISTS (select 1 from leads l where l.id = lead_id)`.
- Writes follow the matching scoped permissions (edit/change_stage/assign/delete). Services check them explicitly, and RLS `WITH CHECK` mirrors read visibility.

### Leads
- UUID v7 generated in the app (`uuid` package, v7).
- Custom-field Zod schema built from `field_definitions`, memoised by a `field_defs_version` counter in `settings` that bumps on every definition change.
- Phone normalisation (`libphonenumber-js/max`): strip formatting, `00`→`+`, parse international, else the default country, accepted only if `isValid()`, otherwise `needs_country`. Nothing is guessed silently. Country picker and bulk fix are Phase 2.
- Masking: phone `+971 50 ••• ••21` (country code + first 2 national digits + last 2), email `a•••@gmail.com`, Instagram `@a•••k`. Implemented once in `packages/core/src/leads/mask.ts`.
- `POST /api/v1/leads/:id/contact/reveal` returns full contact for one lead. It requires `leads.contact.reveal` in scope, writes an audit entry, increments `reveal_counters` (user, hour bucket). Anomaly alerts are Phase 6.
- Idempotency: `idempotency_keys (key, user_id, route, request_hash, response jsonb, created_at)`. Same key + same body replays the response, a different body gets `422`, and keys expire after 24 h (worker cleanup job).
- Optimistic concurrency: `version int` on leads. Updates include `If-Match: <version>` → `409 CONFLICT` if stale.

### Audit log
- `audit_log(bigserial id, at, actor_user_id, actor_ip, action, entity_type, entity_id, diff jsonb, request_id)`. `lume_app`/`lume_worker` get INSERT + SELECT only, and a trigger raises on UPDATE/DELETE/TRUNCATE.
- Written through one `audit(tx, event)` function. Diffs never contain secrets or full contact values.

### Email
- `packages/core/src/mail`: nodemailer over `SMTP_URL`, with plain-text + HTML templates for invite, password reset and lockout alert. Emails contain no lead contact data (report §10.7).
- Dev stack adds a **Mailpit** service (UI bound to `127.0.0.1:8025`, viewed through the tunnel).

## 4. API surface (Phase 1)

All routes live under `/api/v1`. Each declares `config.permission` or `config.public`.

| Area | Routes |
|---|---|
| Setup | `GET /setup/status` (public), `POST /setup` (public, token-gated, only when zero users) |
| Auth | public: `POST /auth/login`, `POST /auth/2fa` (needs the pending-2FA session), `POST /auth/recovery`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `GET /auth/csrf`. Signed-in (`auth.self`): `POST /auth/logout`, `GET /auth/me` |
| Me | `GET/DELETE /me/sessions[/:id]`, `POST /me/2fa/enrol`, `POST /me/2fa/confirm`, `POST /me/2fa/disable`, `POST /me/recovery-codes`, `PATCH /me` (name, timezone, theme) |
| Invites | `POST /invites` (users.manage), `GET /invites/:token` (public), `POST /invites/:token/accept` (public) |
| Users | `GET /users`, `PATCH /users/:id`, `POST /users/:id/disable`, `POST /users/:id/enable`, `DELETE /users/:id/sessions` |
| Roles | `GET /permissions`, `GET/POST /roles`, `GET/PATCH/DELETE /roles/:id`, `POST /roles/:id/clone`, `PUT /roles/:id/field-access` |
| Teams | `GET/POST /teams`, `PATCH/DELETE /teams/:id`, `PUT /teams/:id/members` |
| Settings | `GET /settings` (any signed-in user; filtered), `PATCH /settings` (settings.manage) |
| Config | pipelines, stages (incl. reorder + archive-with-move), fields (incl. archive), lost-reasons, tags, products: CRUD under their permission |
| Leads | `GET /leads` (cursor, filters), `POST /leads`, `GET/PATCH/DELETE /leads/:id`, `POST /leads/:id/stage`, `POST /leads/:id/assign`, `POST /leads/bulk`, `POST /leads/:id/contact/reveal`, `GET /leads/:id/activities`, `POST /leads/:id/notes`, `GET /leads/duplicates?phone&email&instagram` |
| Audit | `GET /audit` (audit.view, cursor, filters) |

Error shape and 404-not-403 per report §4.4.

## 5. Testing

- **Unit:** catalog integrity, effective-permission union and widest scope, masking, custom-field schema building, phone normalisation, stage-move rules, password policy, TOTP window and replay, throttle maths.
- **Integration (real Postgres, per-test database):** every service; RLS by raw SQL as `lume_app` under each scope; audit immutability; concurrency (409) and idempotency (replay/422); session idle/absolute expiry; disable → next request 401; NOTIFY cache bust.
- **Access matrix:** `apps/api/test/matrix.test.ts` enumerates `app.printRoutes`-derived route list × seeded actors (owner, Admin, Sales, Team lead, random role, signed-out) × in/out-of-scope fixtures, with expected status from the catalog. It fails if a route has no matrix entry.
- **E2E (Playwright, in toolbox):** the 1C flow in §2, reading invite and reset emails from Mailpit's API.

## 6. Out of scope for Phase 1
Sheets/webhook/CSV intake, country picker + bulk fix, saved views (Phase 2); tasks, notifications, digests (Phase 3); WhatsApp (Phase 4); calendar (Phase 5); anomaly detection, exports, watermarks, offboarding flow beyond disable/reassign (Phase 6); analytics (Phase 7).
