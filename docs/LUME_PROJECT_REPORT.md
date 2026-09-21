# LUME — Project Report (v3, ground-up rebuild)

> **Audience:** Claude Code. This file is the build spec. Read it end to end before writing code.
> **Owner:** Kedar Gurav. **First deployment:** Nupuur Patil's business (operations lead: Tasneem).
> **Division of labour:** the frontend design is yours to decide. Use the `apple-design` skill for every UI decision. This report defines *what* the product does and *how* the backend, data, security, integrations and deployment must work. Those parts are not open to reinterpretation. Where the report says "configurable", nothing about it may be hardcoded.

---

## 0. How to use this document

- Sections 1–3 define the product and its principles.
- Sections 4–15 are the engineering spec (architecture, data, RBAC, integrations, jobs, security, analytics).
- Section 16 covers UX requirements (behaviour, not visuals).
- Section 17 is the build order with acceptance criteria. **Build in that order.** Do not start a phase until the previous phase's acceptance tests pass.
- Section 18 lists open items. Where one blocks you, ask the owner. Do not guess.
- When this spec and your instincts disagree on security or data integrity, the spec wins. When they disagree on visual design, you win.

---

## 1. Product definition

**LUME is a general-purpose, self-hosted lead management system.** It pulls leads in from wherever a business captures them (Google Sheets, webhooks, Calendly, manual entry, CSV) and moves them through a funnel the business defines. It makes sure every follow-up happens on time and every conversation starts in one click on WhatsApp. It only shows each person what they are allowed to see.

It is **not** custom software for one client. Nupuur's business is the first installation and the reference use case. Every business-specific concept must be expressed as data or configuration, never as code:

| Nupuur-specific thing | How LUME expresses it generically |
|---|---|
| Fields: date, name, struggles, phone, email, Instagram ID | Core fields plus admin-defined **custom fields** |
| Status: message sent → replied → call booked → won/lost | An admin-defined **pipeline** with ordered **stages** |
| "Sales call handled by" | A custom field of type `user` |
| Admin and Sales team | Admin-created **roles** with granular **permissions** |
| SuperReply → Google Sheet | A **lead source** of type `google_sheet`, plus a generic signed webhook source |
| Lead meetings only on the calendar | **Calendar matching rules** |
| Follow-up WhatsApp messages | **Message templates** plus click-to-send |

### 1.1 The problems LUME must solve (from the client meeting)

1. **Data leak.** A sales team member leaked the lead list to a competitor, which cost the business revenue. **This is the single most important requirement.** Section 7 (RBAC) and Section 12 (anti-exfiltration) exist because of it.
2. **Missed follow-ups.** Follow-ups and reminders are the two features that must never fail silently (Section 10).
3. **Calendar noise.** Tasneem wants to see lead meetings only, not every event in the connected calendar (Section 9.2).
4. **Messy phone numbers.** Numbers arrive from the sheet without country codes, which breaks WhatsApp links (Section 8.4).
5. **No visibility.** The business has no numbers on its funnel, team, or revenue (Section 13, Analytics).

### 1.2 Users (examples, not hardcoded)

- **Admin (Tasneem / Nupuur):** sees and controls everything, configures the system, assigns leads, reviews analytics and audit logs.
- **Sales rep:** sees only leads assigned to them, works their follow-ups, sends WhatsApp messages from templates, logs outcomes.
- Future roles the admin might create: team lead (sees their team's leads), marketing (analytics only, no contact data), assistant (calendar and tasks only).

---

## 2. Product principles

1. **Every screen earns its place.** If a feature doesn't make someone's day easier, it doesn't ship. Default views should answer "what do I do next?"
2. **Least privilege by default.** A new role starts with zero permissions. Contact data is the most protected asset in the system.
3. **Nothing hardcoded.** Roles, pipelines, stages, fields, templates, lost reasons, sources, calendar rules and notification timings are all data.
4. **Source of truth is LUME's database.** The Google Sheet is an intake pipe only (one-way pull).
5. **Reliability over cleverness.** Scheduled things (follow-ups, reminders, digests, syncs) must be durable, idempotent and observable.
6. **Honest UX.** LUME never claims a WhatsApp message was delivered, because it can't know that (click-to-send). It asks the user to confirm instead.
7. **Everything is auditable.** Every sensitive read or write leaves a trace.

---

## 3. Decisions already made (do not revisit)

| Area | Decision |
|---|---|
| Deployment model | **Single-tenant.** One installation per client, on that client's own VPS, with its own database. No shared multi-tenant DB. Do not add `tenant_id` columns. |
| Server | Hostinger **KVM 2**: 2 vCPU, 8 GB RAM, 100 GB NVMe. Ubuntu 24.04 LTS. |
| Database | PostgreSQL 17 |
| Architecture | Separate services: Next.js frontend, dedicated TypeScript API (Fastify), background worker |
| Google Sheets | **One-way pull** into LUME. LUME never writes to the sheet. |
| WhatsApp | **Click-to-send** (`wa.me` deep link with pre-filled template text). No WhatsApp Cloud API in v1. Design a `MessageChannel` interface so the Cloud API can be added later without refactoring. |
| Notifications | **In-app notification panel** (real-time) plus **email digest**. No browser push in v1. |
| Integrations | Google Sheets, Google Calendar, Calendly, SuperReply (via sheet and/or webhook) |
| Domain | LUME is licensed under one owner-controlled domain. Each client gets a subdomain, e.g. `nupuur.<lume-domain>`. The domain is TBD (see Section 18). |

---

## 4. System architecture

### 4.1 Services

```
                 Internet
                    │  443 only
               ┌────▼─────┐
               │  Caddy   │  TLS (auto Let's Encrypt), security headers, rate limits, routing
               └──┬────┬──┘
     /api/*, /webhooks/*  │ everything else
          ┌──────▼──┐   ┌─▼────────┐
          │  api    │   │  web     │  Next.js (UI only, no DB access)
          │ Fastify │   └──────────┘
          └──┬───┬──┘
             │   │ LISTEN/NOTIFY
       ┌─────▼┐ ┌▼────────┐
       │  pg  │◄┤ worker  │  pg-boss jobs: sheet sync, reminders, calendar sync, digests, rollups, backups
       └──────┘ └─────────┘
```

| Service | Tech | Notes |
|---|---|---|
| `caddy` | Caddy 2 | Only container with published ports (80, 443). |
| `web` | Next.js (current stable, App Router), TypeScript | UI only. **Never** talks to Postgres. On the `frontend` Docker network only. Calls `/api` same-origin, so no CORS is needed. |
| `api` | Node 22 LTS, Fastify 5, TypeScript, Zod, `fastify-type-provider-zod` | All business logic and all authorisation. On the `frontend` and `backend` networks. |
| `worker` | Same codebase as `api`, different entrypoint | Runs pg-boss consumers and cron schedules. `backend` network only. |
| `db` | PostgreSQL 17 | `backend` network only. **Never** published to the host or internet. |

**Why no Redis:** the job queue uses **pg-boss** (Postgres-backed). One less service to secure and back up, and jobs can be enqueued inside the same transaction as the data change that caused them (no lost reminders). Real-time fan-out uses Postgres `LISTEN/NOTIFY`. On a single-node KVM 2 this is simpler and more reliable.

### 4.2 Repository layout (monorepo, pnpm workspaces)

```
lume/
  apps/
    web/              Next.js UI
    api/              Fastify server (entry: src/server.ts)
    worker/           Job runner (entry: src/worker.ts), imports from packages/core
  packages/
    core/             Domain logic: services, permission engine, phone utils, template renderer
    db/               Drizzle schema, migrations (SQL), RLS policies, seed + industry presets
    contracts/        Zod schemas shared by api and web (request/response types)
    config/           Env loading and validation (fails fast on missing/invalid env)
  infra/
    docker-compose.yml
    Caddyfile
    postgres/postgresql.conf
    scripts/          bootstrap-server.sh, backup.sh, restore.sh, rotate-keys.sh
  docs/               ADRs, runbooks
```

### 4.3 Key libraries

| Purpose | Library |
|---|---|
| ORM / query builder | Drizzle ORM plus hand-written SQL migrations (RLS policies live in SQL) |
| Validation | Zod (every request body, query and param; every env var) |
| Jobs / cron | pg-boss |
| Passwords | `@node-rs/argon2` (Argon2id) |
| 2FA | `otplib` (TOTP) |
| Phone numbers | `libphonenumber-js` (max metadata) |
| Google APIs | `googleapis` |
| Email | `nodemailer` over SMTP (provider TBD, Section 18) |
| Dates / TZ | `date-fns` + `date-fns-tz`. All DB timestamps are `timestamptz` in UTC. |
| Logging | `pino` (JSON). Redact phone, email, tokens, cookies. |
| IDs | UUID v7 (time-sortable) |
| Tests | Vitest, Testcontainers (real Postgres), Playwright (e2e) |

### 4.4 API conventions

- REST under `/api/v1`. JSON only. OpenAPI generated from the Zod schemas and served at `/api/v1/docs`, **admin-only**.
- Cursor pagination (`?cursor=&limit=`), max `limit` 100. **No endpoint returns unbounded lists of leads.**
- Error shape: `{ error: { code: "LEAD_NOT_FOUND", message, details? } }`. Never leak stack traces or SQL.
- Return **404, not 403**, for records outside the user's scope. Don't confirm that a record exists.
- Every mutating endpoint accepts an `Idempotency-Key` header (stored 24h) so double-clicks and retries never create duplicates.
- Optimistic concurrency on leads: `updated_at` / `version` check. A stale write returns `409 CONFLICT`.

---

## 5. Data model

All tables have `id uuid` (v7) PK, `created_at timestamptz default now()`, and `updated_at` unless noted. Soft-delete with `deleted_at` where marked. Use `citext` for emails and `jsonb` for flexible payloads.

### 5.1 Identity and access

| Table | Key columns |
|---|---|
| `users` | `email citext unique`, `name`, `password_hash`, `status (invited/active/disabled)`, `is_owner bool`, `timezone`, `totp_secret_enc`, `totp_enabled`, `must_change_password`, `last_login_at`, `failed_login_count`, `locked_until` |
| `user_invites` | `email`, `role_ids uuid[]`, `token_hash`, `expires_at`, `accepted_at`, `invited_by` |
| `sessions` | `id` (the hash of a random token), `user_id`, `ip`, `user_agent`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `revoked_reason` |
| `roles` | `name unique`, `description`, `color`, `created_by`, `deleted_at` |
| `permissions` | `key` PK, `group`, `label`, `description`, `supports_scope bool`. **Synced from code on boot** (the catalog in Section 7.2). |
| `role_permissions` | `role_id`, `permission_key`, `scope (own/team/all)` nullable when not scoped. PK (`role_id`, `permission_key`). |
| `user_roles` | `user_id`, `role_id`. A user may hold several roles, and the effective permission is the **union** with the **widest scope**. |
| `teams` | `name`, `deleted_at` |
| `team_members` | `team_id`, `user_id`, `is_lead bool` |
| `role_field_access` | `role_id`, `field_id`, `access (hidden/view/edit)` |
| `recovery_codes` | `user_id`, `code_hash`, `used_at` |

### 5.2 Configuration (all admin-editable)

| Table | Key columns |
|---|---|
| `settings` | single row: `business_name`, `logo_asset_id`, `timezone`, `currency`, `default_country_iso`, `week_start`, `working_hours jsonb`, `digest_default_time`, `security jsonb` (session lengths, 2FA policy, IP allowlist, anomaly thresholds), `retention jsonb` |
| `pipelines` | `name`, `is_default`, `position`, `archived_at` |
| `stages` | `pipeline_id`, `name`, `color`, `position`, `kind (open/won/lost)`, `win_probability numeric(5,2)`, `sla_hours int null`, `required_field_ids uuid[]`, `on_enter jsonb` (automation rules, Section 10.5), `archived_at` |
| `field_definitions` | `entity ('lead')`, `key` (slug, unique, immutable), `label`, `type` (`text, long_text, number, currency, date, datetime, boolean, select, multi_select, phone, email, url, user, instagram`), `options jsonb` (select choices with id/label/color), `is_core bool`, `is_required`, `is_unique`, `is_searchable`, `position`, `archived_at` |
| `lost_reasons` | `label`, `position`, `archived_at` |
| `tags` | `label`, `color` |
| `products` | `name`, `default_value`, `currency`, `archived_at` (packages a lead can buy, used for revenue analytics) |
| `message_templates` | `name`, `category` (`first_touch/follow_up/reminder/re_engagement/custom`), `body` (with `{{variables}}`), `is_active`, `allowed_role_ids uuid[]` (empty = all roles with `templates.use`), `created_by` |
| `calendar_rules` | `kind` (`attendee_is_lead / calendly_event_type / title_contains / calendar_id / lume_created`), `value`, `enabled`, `position` |
| `industry_presets` | Code-defined, not a table. Seeds pipeline, fields, templates and lost reasons at first-run setup (Section 16.1). |

### 5.3 Leads and activity

| Table | Key columns |
|---|---|
| `leads` | `pipeline_id`, `stage_id`, `owner_id` (nullable = unassigned), `name`, `phone_raw`, `phone_e164` nullable, `phone_country_iso` nullable, `phone_status (valid/needs_country/invalid/missing)`, `email citext`, `instagram_handle`, `source_id`, `external_ref` (e.g. sheet row fingerprint), `value numeric(14,2)`, `currency`, `product_id`, `lost_reason_id`, `lost_note`, `won_at`, `lost_at`, `custom jsonb` (keyed by `field_definitions.key`), `lead_created_at` (the business date from the source, e.g. the sheet's date column), `last_activity_at`, `next_task_due_at`, `stage_entered_at`, `version int`, `deleted_at` |
| `lead_tags` | `lead_id`, `tag_id` |
| `lead_stage_history` | `lead_id`, `from_stage_id`, `to_stage_id`, `pipeline_id`, `changed_by`, `changed_at`. **Insert-only. This is the analytics backbone.** Written by the service layer in the same transaction as the stage change. |
| `lead_assignment_history` | `lead_id`, `from_user_id`, `to_user_id`, `changed_by`, `changed_at`, `reason` |
| `activities` | `lead_id`, `user_id`, `type` (Section 5.5), `payload jsonb`, `occurred_at`. Insert-only (edits create a new `note_edited` activity). |
| `tasks` | `lead_id` nullable, `assignee_id`, `created_by`, `type (follow_up/call/whatsapp/email/meeting_prep/custom)`, `title`, `notes`, `due_at timestamptz`, `all_day bool`, `reminder_offsets_min int[]` (e.g. `{0, 60, 1440}`), `template_id` nullable, `status (open/done/canceled)`, `completed_at`, `completed_by`, `snoozed_until`, `recurrence jsonb` (Section 10.3), `parent_task_id`, `auto_rule_id` nullable |
| `scheduled_notifications` | `task_id` / `meeting_id` / `lead_id`, `user_id`, `fire_at`, `kind`, `status (pending/fired/canceled)`, `fired_at`, `job_id`. Materialised per reminder offset, so the scheduler is dumb and reliable. |
| `notifications` | `user_id`, `kind`, `title`, `body`, `entity_type`, `entity_id`, `action jsonb` (e.g. `{type:'whatsapp_send', task_id}`), `priority (normal/high)`, `created_at`, `read_at`, `acted_at`, `dismissed_at` |
| `saved_views` | `user_id`, `name`, `entity`, `filters jsonb`, `sort jsonb`, `columns jsonb`, `shared_with_role_ids uuid[]` |
| `goals` | `scope (user/team/business)`, `scope_id`, `metric`, `period (month/quarter)`, `period_start`, `target numeric` |

### 5.4 Integrations

| Table | Key columns |
|---|---|
| `lead_sources` | `type (google_sheet/webhook/calendly/csv/manual)`, `name`, `config_enc bytea` (encrypted JSON: sheet id, tab, header row, webhook secret…), `mapping jsonb` (column → field + transform), `dedupe_rule jsonb`, `default_country_iso`, `default_pipeline_id`, `default_stage_id`, `default_owner_rule jsonb` (none / specific user / round-robin over users), `poll_interval_sec`, `enabled`, `last_synced_at`, `last_error`, `status` |
| `import_rows` | `source_id`, `fingerprint` (unique per source), `row_number`, `lead_id`, `result (created/merged/skipped/error)`, `error`, `raw_enc bytea`, `imported_at` |
| `integration_accounts` | `provider (google/calendly)`, `user_id` nullable (org-level when null), `account_email`, `scopes text[]`, `access_token_enc`, `refresh_token_enc`, `expires_at`, `status (active/needs_reauth/revoked)`, `meta jsonb` (calendar ids, sync tokens, watch channel ids and expiry) |
| `meetings` | `lead_id` nullable, `owner_user_id`, `source (google/calendly/lume)`, `external_id`, `calendar_id`, `title`, `start_at`, `end_at`, `status (scheduled/canceled/completed/no_show/rescheduled)`, `meeting_url`, `match_rule_id`, `calendly_event_type`, `outcome_logged_at`. **Only lead-matched events are stored** (Section 9.2). |
| `webhook_events` | `provider`, `external_event_id` unique, `received_at`, `processed_at`, `status`, `error`. Used for dedupe and replay protection. |

### 5.5 Security and ops

| Table | Key columns |
|---|---|
| `audit_log` | `bigserial id`, `at`, `actor_user_id`, `actor_ip`, `action` (e.g. `lead.view`, `lead.contact.reveal`, `lead.export`, `role.update`, `user.login.failed`), `entity_type`, `entity_id`, `diff jsonb`, `request_id`. **Append-only** (see 12.4). |
| `exports` | `user_id`, `kind`, `filters jsonb`, `row_count`, `watermark_code`, `file_path`, `expires_at`, `downloaded_at` |
| `security_alerts` | `user_id`, `kind`, `details jsonb`, `created_at`, `acknowledged_by`, `acknowledged_at` |
| `country_code_usage` | `country_iso` PK, `use_count`, `last_used_at` (feeds "frequently used") |
| `analytics_daily` | rollup tables, see Section 13.6 |

**Activity types (enum, extensible):** `note`, `whatsapp_opened`, `whatsapp_confirmed_sent`, `reply_logged`, `call_logged`, `email_logged`, `stage_changed`, `assigned`, `field_changed`, `meeting_booked`, `meeting_canceled`, `meeting_completed`, `meeting_no_show`, `task_created`, `task_completed`, `imported`, `merged_duplicate`, `contact_revealed`.

### 5.6 Indexes (minimum)

- `leads(owner_id, stage_id) where deleted_at is null`
- `leads(pipeline_id, stage_id, stage_entered_at)`
- `leads(phone_e164)`, `leads(lower(email))`, `leads(lower(instagram_handle))` for dedupe
- `pg_trgm` GIN on `leads(name)` and `leads(email)`, plus a digits-only generated column on phone for search
- `GIN(custom jsonb_path_ops)`
- `tasks(assignee_id, status, due_at)`
- `scheduled_notifications(status, fire_at)`
- `lead_stage_history(pipeline_id, to_stage_id, changed_at)`
- `activities(lead_id, occurred_at desc)`, `activities(user_id, type, occurred_at)`
- `meetings(owner_user_id, start_at)`, `meetings(lead_id)`

---

## 6. Custom fields and configurability

- **Core fields** (`name`, `phone`, `email`, `instagram`, `owner`, `stage`, `source`, `value`, `lead_created_at`) exist on every installation as real columns. They can be relabelled and hidden, not deleted.
- **Custom fields** live in `leads.custom` (jsonb). The API validates writes against `field_definitions` with a Zod schema built at runtime and cached, invalidated when definitions change.
- Changing a field's `type` on a field that already has data is only allowed through a guided migration endpoint that previews conversion failures. Deleting is always an archive, and data is preserved.
- `select` / `multi_select` options have stable ids. Renaming an option never rewrites data.
- Every custom field is automatically available in: table columns, filters, sort, bulk edit, CSV import mapping, sheet mapping, template variables (`{{lead.custom.<key>}}`), and analytics "group by" (Section 13).
- **Pipelines:** multiple pipelines supported (e.g. "Coaching sales" and "Corporate"). Stages can be reordered, recoloured, renamed and archived. A stage with leads in it can only be archived after its leads are moved (the UI offers bulk move). There must always be at least one `won` and one `lost` stage per pipeline.

---

## 7. Role-based access control (RBAC)

### 7.1 Model

- **Permissions** are defined in code (because each one corresponds to code that checks it). **Roles** are pure data: the admin creates, renames, clones and deletes roles and ticks permissions.
- Scoped permissions take a scope: `own` (records where I am the owner/assignee), `team` (records owned by members of any team I lead), or `all`.
- **Field-level access** per role: each field is `hidden`, `view` or `edit`. Hidden fields are removed from API responses server-side, not just hidden in the UI.
- **Owner account.** Exactly one user (created at first-run setup) has `is_owner = true`. The owner has every permission implicitly, cannot be disabled or demoted by anyone else, and can transfer ownership. This isn't a hardcoded role. It's a lockout safeguard so an admin can never delete the last way into the system. It is also why "Admin" can be an ordinary, deletable role.
- **Default seed** (editable after setup): role `Admin` (all permissions, scope `all`) and role `Sales` (see 7.3).
- **Deleting a role** that users hold requires choosing a replacement role for them, in the same transaction.
- Permission changes take effect on the **next request**. The permission set is cached per user for at most 30s and busted immediately via `NOTIFY` on any role or user change.

### 7.2 Permission catalog (v1)

| Key | Scoped | Meaning |
|---|---|---|
| `leads.view` | ✓ | See leads in scope (list, detail) |
| `leads.create` | | Create leads manually |
| `leads.edit` | ✓ | Edit leads in scope (subject to field access) |
| `leads.delete` | ✓ | Soft-delete leads |
| `leads.assign` | ✓ | Assign/reassign leads in scope to users |
| `leads.change_stage` | ✓ | Move leads between stages |
| `leads.contact.full` | ✓ | See full phone/email/Instagram. Without it, contact values are **masked** (`+971 50 ••• ••21`) |
| `leads.contact.reveal` | ✓ | May click "Reveal" to see one lead's full contact. Every reveal is audited and counted toward anomaly limits. |
| `leads.bulk_edit` | ✓ | Bulk stage/tag/field changes |
| `leads.export` | ✓ | Export leads to CSV. **Off for all non-admin roles by default.** |
| `leads.import` | | CSV import, manage lead sources |
| `messages.send` | ✓ | Use click-to-send WhatsApp on leads in scope |
| `messages.send_queue` | ✓ | Use the bulk send queue (10.6) |
| `templates.use` / `templates.manage` | | |
| `tasks.manage_others` | ✓ | Create/edit tasks assigned to other users |
| `calendar.view` | ✓ | See lead meetings in scope |
| `calendar.connect` | | Connect own Google Calendar |
| `analytics.view` | ✓ | `own` = my performance only; `team`; `all` = business-wide |
| `analytics.revenue` | | See revenue figures (can be withheld from reps) |
| `pipelines.manage`, `fields.manage`, `settings.manage` | | Configuration |
| `users.manage`, `roles.manage`, `teams.manage` | | People and access |
| `integrations.manage` | | Sheets, Calendly, webhooks |
| `audit.view`, `security.manage` | | Audit log, security alerts, session control |

### 7.3 Seeded "Sales" role (for Nupuur's install)

`leads.view:own`, `leads.edit:own`, `leads.change_stage:own`, `leads.contact.reveal:own` (**not** `contact.full`; see 12.2, pending owner confirmation), `messages.send:own`, `templates.use`, `calendar.view:own`, `calendar.connect`, `analytics.view:own`. Nothing else. No export, no assign, no delete, no unassigned leads.

### 7.4 Enforcement: three layers, all mandatory

1. **Route guard.** Every route declares its required permission in its route config (`config: { permission: 'leads.view' }`). A startup check fails the boot if any route under `/api/v1` lacks a declaration (explicit `public: true` is required for login etc.).
2. **Service layer.** Services receive an `Actor` (user id, effective permissions, scopes, team member ids) and build queries with scope filters. Field masking and field-level access are applied in one response serializer that every lead-returning endpoint must use.
3. **Postgres Row-Level Security (defence in depth).** RLS is enabled with `FORCE ROW LEVEL SECURITY` on `leads`, `activities`, `tasks`, `meetings`, `lead_stage_history`, `lead_assignment_history`, `notifications`.
   - The API connects as role `lume_app` (not a superuser, not the table owner, no `BYPASSRLS`).
   - Each request runs inside a transaction that begins with `SET LOCAL lume.user_id = …, lume.lead_scope = 'own'|'team'|'all', lume.team_member_ids = '{…}'`.
   - Policy on `leads` (read):
     `lume_scope() = 'all' OR owner_id = lume_user() OR (lume_scope() = 'team' AND owner_id = ANY(lume_team_members()))`
   - Child tables check visibility via `EXISTS (select 1 from leads l where l.id = lead_id)`, which inherits the leads policy.
   - The worker uses a separate role `lume_worker` with a `BYPASSRLS` grant **only** on the tables it must process system-wide, and never serves user-facing reads.
   - Result: even if a future endpoint forgets a `where owner_id = …`, the database still refuses to return other people's leads.
4. **Reassignment revokes access immediately.** When a lead moves from rep A to rep B, A can no longer see it (including its activities and tasks). A's historical activities keep A's name for attribution.

### 7.5 Mandatory RBAC test suite

An automated **permission matrix test** must: seed users with each seeded role plus a custom role with random permissions, enumerate **every** registered route, call it as each user against leads in and out of scope, and assert 200/404/403 against an expected matrix generated from the permission catalog. It also runs the same reads directly in SQL as `lume_app` with a sales scope set, to prove RLS alone blocks out-of-scope rows. **CI fails if any route is missing from the matrix.**

---

## 8. Lead intake

### 8.1 Google Sheets source (primary; SuperReply writes here)

**Auth:** use a **Google service account** per installation. The admin shares the sheet with the service account email as **Viewer**, and the UI shows that email with a copy button and a "Test access" button. Reasons: no user OAuth tokens that expire or get revoked when someone leaves, read-only by construction (which matches one-way pull), and no Google OAuth verification needed for Sheets.

**Setup flow (admin):**
1. Paste sheet URL → LUME extracts the spreadsheet id, lists the tabs, admin picks a tab and header row.
2. **Column mapping screen:** each sheet header → LUME field (core or custom), or "ignore", or "create new custom field from this column". Transforms per column: trim, lowercase, date format (auto-detect with override), phone (with default country), split name, value map for selects (e.g. "Y"/"N" → boolean).
3. **Dedupe rule:** match existing leads on any of phone (E.164), email, Instagram handle (configurable, ordered). On match: `merge` (append an `imported` activity "re-inquiry", update empty fields only, optionally move back to a stage), `skip`, or `create duplicate`. Default: merge.
4. **Defaults:** pipeline, entry stage, owner rule (unassigned / fixed user / round-robin across selected users), default country code.
5. **Preview:** dry-run on the first 20 rows, showing exactly what would be created or merged and any row errors.
6. **Backfill choice:** import all existing rows, or only rows added from now on.

**Sync mechanics (worker job `sheets.sync`):**
- Runs every `poll_interval_sec` (default 120s, min 60s) plus an on-demand "Sync now" button.
- Reads values in batches (`spreadsheets.values.get` on the mapped range). Respect Google quotas with exponential backoff on 429/5xx.
- Row identity: `fingerprint = sha256(normalised values of the mapped identity columns)`. The identity columns are configurable and default to timestamp + phone + email. **Do not rely on row numbers**, because people sort, insert and delete rows.
- New fingerprint → run the mapping → validate → dedupe → insert lead + `imported` activity + `import_rows` record, all in one transaction. Then enqueue `lead.created` automations.
- Existing fingerprint → ignore (LUME is the source of truth after import).
- Row-level failures never stop the batch. They land in `import_rows` with `result = error`, and the Source Health screen shows them with a "fix and retry" action.
- Header changes (renamed or removed column) → source status `needs_attention`, sync paused for that source, admin notified. Never import with a broken mapping.

**Security note for the client (put in onboarding copy):** once LUME is live, remove every sales team member's access to the Google Sheet. The sheet is the one place where the full lead list still exists outside LUME's access control.

### 8.2 Inbound webhook source (for SuperReply, Zapier, Make, website forms)

- `POST /webhooks/in/:sourceId`. HMAC-SHA256 signature in `X-Lume-Signature` over the raw body with a per-source secret, plus a timestamp header (reject if more than 5 min skew). Replay protection via `webhook_events`.
- The payload is mapped with the same mapping engine as sheets (JSON path → field).
- Rate limited per source (60/min default). The endpoint returns `202` immediately and processing is queued.
- Research gap: I could not confirm whether SuperReply can call arbitrary webhooks. If it can, prefer this over the sheet (real-time, and no copy of the lead list sitting in a sheet). See Section 18.

### 8.3 Other intake

- **Manual create** (permission `leads.create`), with the same phone normalisation and dedupe warning ("A lead with this phone already exists, owned by X". Show the owner's name only if the actor can see that lead; otherwise say "already exists").
- **CSV import:** same mapping and preview engine as sheets, one-off.
- **Calendly:** a booking by an unknown email can optionally create a lead (config on the Calendly integration). See 9.3.

### 8.4 Phone numbers and country codes

**Storage:** always keep `phone_raw` (as received) and, when parseable, `phone_e164` + `phone_country_iso`. `phone_status` is one of:
- `valid`: parsed and valid per libphonenumber
- `needs_country`: no `+`/international prefix and no default country, or the default country produced an invalid number
- `invalid`: unparseable garbage
- `missing`

**Normalisation on import:**
1. Strip spaces, dashes, dots and brackets. Convert a leading `00` to `+`.
2. If it starts with `+` → parse as international.
3. Else if the source or settings have a default country → parse with it. Accept only if `isValid()`.
4. Else → `needs_country`. **Never guess silently.**
5. **Suggestion engine (non-binding):** for `needs_country` numbers, compute the countries where the number is valid (try the installation's top 10 most-used countries first) and show them as one-tap suggestions, e.g. "Looks like 🇦🇪 UAE (+971) or 🇮🇳 India (+91)".

**Country picker component (used next to every phone input, and in the fix-up flow):**
- Full list of countries: flag emoji, country name (via `Intl.DisplayNames`, so it localises), ISO code and dial code, built from libphonenumber metadata. Ship it as static JSON with the web bundle.
- **Search matches** country name (prefix and fuzzy, e.g. "emir" → UAE), ISO code ("AE"), and dial code ("971", "+971", "+9"). Case-insensitive.
- **"Frequently used" section pinned at the top:** top 5 from `country_code_usage` (installation-wide, updated each time a code is applied) plus any admin-pinned countries in settings. Keyboard navigable, and it opens with the search field focused.
- Selecting a country re-parses `phone_raw` with that country. The number is saved only if it's valid; otherwise an inline error appears and the user can edit the digits.

**Bulk fix:** a "Needs country code" smart filter (count badge in the nav for users who can edit). Multi-select leads → pick a country → apply, which re-validates each number individually and reports how many were fixed and how many are still invalid.

**Display:** formatted international (`+971 50 123 4567`), masked per permissions (12.2).

---

## 9. Calendar integrations

### 9.1 Google Calendar: connection

- **Per-user OAuth** ("Connect my Google Calendar"). Scopes: `openid email` plus `https://www.googleapis.com/auth/calendar.events.readonly` (read events only). Add write scope later if LUME starts creating events.
- **One Google Cloud project owned by LUME** (Kedar), with the OAuth consent screen branded LUME and authorised redirect URIs per client subdomain. Calendar scopes are **sensitive**, which means:
  - The OAuth app must be **published (In production)**, not "Testing". Testing-mode refresh tokens expire after 7 days, which would silently break calendar sync weekly.
  - Until Google verification is done, users see an "unverified app" warning and the app is capped at 100 users in total. That's acceptable for the first clients. **Start Google verification early** (it needs a privacy policy and homepage on the LUME domain).
- Tokens are stored encrypted (12.5). Refresh failures → account `needs_reauth`, the user and admins get a notification, and meetings already stored remain.

### 9.2 "Lead meetings only" — feasible, and here's how

Tasneem's request is fully possible. LUME fetches events from the connected calendar(s) but **only stores and shows events that match a lead**, using ordered `calendar_rules` (admin-configurable, all on by default except title rules):

1. **`lume_created`:** events LUME created (future feature) carry `extendedProperties.private.lume_lead_id`.
2. **`calendly_event_type`:** event matches a meeting received via the Calendly webhook (same invitee email and start time within ±2 min). This is the most reliable rule.
3. **`attendee_is_lead`:** any attendee email equals a lead's email (case-insensitive).
4. **`title_contains`:** optional keyword rules (e.g. "Discovery Call", "Consultation"). These match events to leads by attendee email if possible; otherwise the event is stored as an "unlinked lead meeting" that the user can attach to a lead in one tap.
5. **`calendar_id`:** optional, e.g. "everything on the 'Sales Calls' calendar counts".

Non-matching events are **discarded, never persisted.** That means LUME never holds anyone's personal calendar data, which is good for privacy and for the leak concern.

**Sync:** `events.list` with **incremental `syncToken`** per calendar. Use **push notifications (`events.watch`)** to trigger a sync in near real time, with a 5-minute polling fallback. Watch channels expire, so a worker job renews them before expiry. On a `410 Gone` (invalid sync token) → full resync of the window (−30 days to +90 days).

**Calendar view in LUME:** day, week, month and agenda views. Filters: owner (scoped by `calendar.view`), pipeline, stage, meeting status, source. Clicking a meeting opens the lead drawer. After a meeting's end time, the owner gets a task **"Log outcome"** (completed / no-show / rescheduled + next step), which feeds analytics.

### 9.3 Calendly

- **Requirement to flag to the client:** Calendly webhooks need a paid plan (Standard or higher). On a free plan, LUME falls back to Google Calendar matching only (rules 3–5).
- Org-level connection (admin) via Calendly OAuth or personal access token. Create an **organization-scoped** webhook subscription for `invitee.created` and `invitee.canceled` (and `routing_form_submission.created` if the client uses routing forms).
- Verify the `Calendly-Webhook-Signature` header (HMAC with the signing key, timestamp tolerance of 5 min). Dedupe via `webhook_events`.
- `invitee.created` → find the lead by email, then phone (from custom questions if mapped), else optionally create a lead. Create a `meetings` row, add a `meeting_booked` activity, and **auto-move the lead to the stage configured as "on booking"** (e.g. "Call booked"), per the pipeline's automation config. Notify the lead owner.
- `invitee.canceled` → meeting `canceled`, activity, notify the owner, and optionally create a "Reschedule follow-up" task (configurable).
- Map the Calendly host → LUME user by email so that meetings land with the right rep.

---

## 10. Follow-ups, reminders and notifications (must never fail)

### 10.1 Definitions (use these names in the UI)

- **Follow-up:** a task for a *team member* to act on a lead at a time. It fires as an **in-app notification** (and appears in the email digest).
- **Reminder message:** a pre-written **WhatsApp template** meant for the *lead*. At its time, the owner gets a "Ready to send" notification that opens WhatsApp with the text pre-filled in one click. Examples: "Your call with Nupuur is tomorrow at 5 PM", or "Just checking in on your plan".

Both are `tasks` rows. A reminder message is a task with `type = whatsapp` and a `template_id`.

### 10.2 Custom time periods

- Due time presets: in 1h / 3h / tomorrow 10:00 / in 2 days / next Monday / custom date-time. **Presets are editable in settings.**
- Reminder offsets per task: any combination of "at time", "N minutes/hours/days before" (the user picks the values, e.g. 15 min, 1 h, 1 day).
- Meeting-relative reminders: "send lead reminder N hours before meeting" as an automation (10.5).
- All times are entered and shown in the **user's timezone**, and stored in UTC. The installation timezone is used for business rules (working hours, digests, analytics buckets). *(Nupuur is in Dubai; her team may be in India. This matters.)*
- **Working-hours awareness:** if an auto-created follow-up would land outside working hours, shift it to the next working-hours start (configurable on/off).

### 10.3 Recurrence

`recurrence` jsonb: `{ every: N, unit: 'day'|'week', until: date|null, stop_on: ['reply_logged','stage_kind:won','stage_kind:lost'] }`. On completion, or on firing for "nag" recurrences, the worker creates the next occurrence. The stop conditions are checked at creation time. Example: "Every 3 days until they reply."

### 10.4 Scheduling engine (reliability design)

1. When a task is created or updated, the same DB transaction (a) rewrites its `scheduled_notifications` rows (one per reminder offset) and (b) enqueues pg-boss jobs with `startAfter = fire_at` and `singletonKey = scheduled_notification.id`.
2. Job handler: lock the row `FOR UPDATE SKIP LOCKED`, and if `status = pending` and the task is still open: insert a `notifications` row, `NOTIFY lume_notifications`, and mark it `fired`. **Idempotent.** Running it twice does nothing the second time.
3. **Sweeper job every 60s:** any `pending` row with `fire_at < now() - 30s` gets fired immediately. This catches anything a crash, deploy or clock issue skipped. The two mechanisms together mean nothing is lost as long as the DB survives.
4. Snooze updates `snoozed_until` and reschedules. Completing or canceling a task cancels its pending rows.
5. **Overdue never disappears:** an unfinished task past due stays in the "Overdue" group on Today and in the panel until done, rescheduled or canceled.
6. **Escalation (configurable):** if a follow-up is overdue by more than X hours (default 24), notify the users who hold `tasks.manage_others` over that assignee (e.g. Tasneem).
7. **Observability:** an admin "System health" page showing the job queue depth, failed jobs, the last sweeper run, the last sheet sync per source, calendar sync status per user, and the last digest sent. Failed jobs retry with backoff (5 attempts), then raise a `security_alerts`-style ops alert to admins by email.

**Required tests:** fire-time accuracy (±60s), idempotency (double fire), crash recovery (kill the worker mid-batch → the sweeper recovers), timezone correctness across UTC+4 / UTC+5:30 / a DST zone, snooze/complete races, and recurrence stop conditions.

### 10.5 Automations (configurable per stage; keep v1 small and robust)

`stages.on_enter` rules:
- `create_task`: `{type, title, due_in: {n, unit}, template_id?, assignee: 'lead_owner'|userId}`, e.g. entering "Message sent" → follow-up in 2 days with the template "Gentle nudge".
- `cancel_open_tasks`: e.g. entering Won or Lost cancels pending follow-ups.
- `notify`: notify the owner or specific users.
- `meeting_reminders`: when a meeting is booked, create `whatsapp` reminder tasks at configured offsets before start (e.g. 24h and 1h) using a chosen template.
- Global rule: **"No-touch alert"**: a lead with no activity for N days in an open stage creates a follow-up for its owner.

Automations run in the worker, are logged as activities with `auto_rule_id`, and can never loop (a rule-created change does not re-trigger `on_enter` for the same stage).

### 10.6 Notification panel (in-app, real-time)

- Delivered over **Server-Sent Events** (`GET /api/v1/stream`, authenticated by session cookie). The API holds one Postgres `LISTEN` connection and fans out to the connected users. The client reconnects with `Last-Event-ID` and missed notifications are re-sent from the DB.
- Panel groups: **Overdue**, **Due now**, **Upcoming today**, **Updates** (assignments, bookings, cancellations, system).
- Every notification has actions inline: *Send on WhatsApp* (for reminder messages), *Open lead*, *Mark done*, *Snooze (15m / 1h / tomorrow / custom)*.
- Unread badge in the nav and in the document title (`(3) LUME`). Optional sound, toggled per user.

### 10.7 Email digest

- Per user, sent daily at a user-chosen local time (default 08:00), only on working days by default. Contents: overdue follow-ups, today's follow-ups, today's lead meetings, new leads assigned since yesterday. For admins, add: unassigned new leads, source errors, security alerts.
- **Emails contain lead first names and times only. No phone numbers or emails** (they leave LUME's access control). Every item deep-links into LUME, where login is required.
- Optional weekly performance summary (Section 13.8).
- Sent via SMTP with SPF/DKIM/DMARC set up on the sending domain. Failed sends retry, and are visible on System health.

---

## 11. WhatsApp click-to-send and templates

### 11.1 Templates

- Body with variables: `{{lead.first_name}}`, `{{lead.name}}`, `{{lead.custom.<key>}}`, `{{owner.first_name}}`, `{{business.name}}`, `{{meeting.date}}`, `{{meeting.time}}` (formatted in the **lead's** country timezone if known, else the business timezone), `{{meeting.link}}`.
- Editor with a variable picker, live preview against a real lead, a character count, and WhatsApp formatting (`*bold*`, `_italic_`) preview.
- Missing variable values → a warning before sending, with inline editing of the final text.
- Categories and per-role availability. Templates are versioned (edits don't change history).

### 11.2 Send flow

1. The user clicks **Send via WhatsApp** on a lead, task or notification → picks a template (the category matching context is suggested first) or writes freeform → edits the text.
2. The client calls `POST /api/v1/leads/:id/messages/prepare` → the server checks `messages.send` scope and a valid `phone_e164`, renders the template server-side, writes an `whatsapp_opened` activity + audit entry, and returns `https://wa.me/<digits>?text=<urlencoded>`.
3. The client opens it (new tab on desktop → WhatsApp Web/Desktop; the app on mobile).
4. When the user returns, a small non-blocking prompt asks: **"Sent?" → Yes / Not sent**. *Yes* logs `whatsapp_confirmed_sent`, completes the related task if any, and runs stage automations (e.g. auto-move "New" → "Message sent", configurable). Dismissing the prompt counts as unconfirmed.
5. **Never** show the full number in the URL preview for users without `contact.full`. The link is generated on demand and never listed.
6. **Log reply** quick action (one tap: "They replied") → `reply_logged` activity. This powers reply-rate analytics and stops "until reply" recurrences.

### 11.3 Bulk messages ("Send queue")

True bulk sending isn't possible with click-to-send, so LUME makes sequential sending fast instead:
- Select leads (e.g. everyone in "Message sent, no reply in 3 days", or "Lost — last 60 days" for re-engagement) → pick a template → **Send queue** opens a focused mode that shows one lead at a time with its rendered message. **Send** opens WhatsApp, and when the user comes back the next lead is already loaded. Skip, edit and pause are available. Progress is saved server-side so a queue can be resumed.
- Queue size cap per run (default 50, configurable) and per-user daily cap. Both protect against misuse and keep WhatsApp from flagging the number for spam.
- **Re-engagement for lost clients:** a saved view "Lost, reason ∈ {not now, price}, lost > 30 days ago" plus a re-engagement template plus the queue. Leads that reply can be reopened into a chosen stage in one click, and reopen events are tracked for analytics.

### 11.4 Future: WhatsApp Cloud API

Keep a `MessageChannel` interface (`prepare()`, `send()`, `capabilities`) with `ClickToSendChannel` implemented now. Do not build Cloud API code in v1.

---

## 12. Security

### 12.1 Authentication and sessions

- Email + password (Argon2id, memory ≥ 64 MB, parallelism tuned for 2 vCPU). Minimum 12 characters, checked against a local top-100k breached-password list. No composition rules.
- **2FA (TOTP)**: mandatory for the owner and for any role holding `users.manage`, `roles.manage`, `leads.export`, `security.manage` or `leads.contact.full` with scope `all`. Optional-but-enforceable per role for others (a setting). 10 single-use recovery codes.
- Server-side sessions: random 256-bit token in a cookie `__Host-lume_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`). Only the SHA-256 of the token is stored. Rotate on login and privilege change. Idle timeout 12h (configurable), absolute timeout 7 days (configurable).
- **Session management screen:** users see and revoke their own sessions, and admins can revoke anyone's. **Disabling a user kills all their sessions immediately** (critical when someone leaves or is suspected of leaking).
- Login throttling: per IP and per account, progressive delay, lockout for 15 min after 10 failures, admin notified on repeated lockouts. Generic error messages (no user enumeration). Password reset by emailed single-use token (30 min).
- Optional per-role restrictions: **IP allowlist** and **allowed login hours** (e.g. sales can only log in 09:00–21:00 business time).
- CSRF: SameSite cookie + `Origin`/`Sec-Fetch-Site` check on all state-changing requests + a double-submit token.
- No public self-signup, ever. Users exist only by admin invite (single-use, 72h link).

### 12.2 Contact-data protection (the anti-leak design)

This is the direct answer to Nupuur's leak. Each layer raises the cost of stealing the list and makes it traceable.

1. **Scope:** reps only ever receive their assigned leads (7.4, enforced down to RLS).
2. **Masking:** without `leads.contact.full`, phone/email/Instagram are masked in every API response. The WhatsApp button still works because the server builds the link, so reps can do their job without ever holding a copyable number list.
3. **Reveal is metered:** `leads.contact.reveal` shows one lead's contact on click. Each reveal is audited and counted.
4. **No bulk extraction paths for non-admins:** no export, no "select all + copy" of contact columns (the table omits contact columns for masked roles), no API pagination beyond 100, no search by partial phone for masked roles (prevents enumeration).
5. **Anomaly detection (worker, every 5 min):** alert admins when a user exceeds thresholds (configurable defaults): more than 30 reveals/hour, more than 200 lead views/hour, more than 3 send-queue runs/day, a login from a new country/IP range, or activity outside allowed hours. Option per rule: alert only, or **alert + auto-suspend sessions**.
6. **Exports (admins only by default):** generated as files, each carrying a **unique watermark** (a per-export code embedded as an extra column plus a canary row that's unique to that export). A leaked file can then be traced to the exporter and timestamp. Exports expire after 24h, and each download is audited.
7. **On-screen watermark (optional setting, on by default for masked roles):** a faint repeating overlay of the viewer's name and email on lead screens, which discourages screenshots and makes them traceable. Screenshots can't be prevented technically, so say that honestly in the admin docs.
8. **Offboarding checklist** in the UI when disabling a user: sessions killed → leads reassigned (bulk) → calendar integration revoked → a summary of their last 30 days of reveals/exports shown to the admin.

*Owner to confirm (Section 18):* whether sales reps get `contact.reveal` or no contact visibility at all (WhatsApp button only).

### 12.3 Application security

- Zod validation on every input, and response schemas on every output, so extra fields can't leak.
- Parameterised queries only. The lint rule bans string-built SQL except in the migrations package.
- Output encoding in the UI (React default). No `dangerouslySetInnerHTML`. Template previews render as text.
- Security headers via Caddy: strict **CSP** (`default-src 'self'`, no inline scripts; use nonces if Next.js needs them), `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` locking down camera/mic/geolocation, `frame-ancestors 'none'`.
- Rate limits at Caddy (global per IP) and at the API (per user per route class; stricter on auth, reveal, export and webhooks).
- File uploads (logo only in v1): images only, validated by magic bytes, max 2 MB, re-encoded server-side, and stored outside the web root.
- Dependency hygiene: `pnpm audit` in CI, Renovate/Dependabot, pinned Docker base images by digest, and weekly rebuilds.
- Secrets never in the repo. `.env` on the server is `chmod 600`, owned by the deploy user.

### 12.4 Database security

- Separate Postgres roles: `lume_owner` (owns the schema, runs migrations only), `lume_app` (DML on app tables, RLS enforced), `lume_worker`, and `lume_readonly_backup`.
- `audit_log`: `lume_app` has `INSERT` + `SELECT` only. `UPDATE`/`DELETE` are revoked, and a trigger blocks modification even by mistake. Audit retention is configurable (default 2 years).
- Postgres listens only on the Docker `backend` network, uses `scram-sha-256` auth, and `pg_hba` allows the app subnet only.

### 12.5 Encryption

- In transit: TLS 1.2+ everywhere (Caddy). Internal Docker network traffic stays on-host.
- At rest: OAuth tokens, sheet/webhook config, and raw import rows are encrypted with **AES-256-GCM**. The data key is wrapped by a master key from the `LUME_MASTER_KEY` env var. Key rotation script in `infra/scripts/rotate-keys.sh`.
- Backups encrypted before leaving the server (12.7).

### 12.6 Server hardening (`infra/scripts/bootstrap-server.sh`, idempotent)

- Ubuntu 24.04. Create a `deploy` user with sudo, SSH **key-only**, `PermitRootLogin no`, `PasswordAuthentication no`.
- UFW: allow 22 (optionally restricted to known IPs), 80 and 443, deny everything else. Also enable Hostinger's panel firewall with the same rules.
- `fail2ban` for sshd. `unattended-upgrades` for security patches. Time sync (chrony).
- Docker with `userns-remap` or rootless where practical. Containers run as non-root, with read-only root filesystems where possible, `no-new-privileges`, and dropped capabilities.
- 2 GB swap file (protects against OOM during builds).
- Log rotation for Docker (`max-size 20m`, `max-file 5`).

### 12.7 Backups and recovery

- `pg_dump` (custom format) **every 6 hours** → compressed → encrypted with `age` (public key on the server, private key kept offline by Kedar) → uploaded to off-site object storage (Backblaze B2 or Cloudflare R2, TBD) via `rclone`.
- Retention: 7 days of 6-hourly backups, 4 weekly, 6 monthly.
- Hostinger weekly snapshots stay on as a second layer.
- **Weekly automated restore test:** the worker restores the latest backup into a scratch database, runs sanity counts, drops it, and reports to System health. A backup that has never been restored isn't a backup.
- Document the RPO (≤6h) and RTO (≤2h) in `docs/runbooks/restore.md`.

### 12.8 Privacy and compliance

- Lead data here is personal data (UAE PDPL for Nupuur; India's DPDP Act for Indian clients). Provide: a per-lead **hard delete** (admin, audited, cascades to activities; audit keeps only the id), a data-retention setting (auto-anonymise lost leads after N months, off by default), and a per-lead data export (admin).
- No third-party analytics or trackers in the app. Error tracking (if any) must scrub PII before sending.

---

## 13. Analytics

Analytics must answer, at a glance: **Is the funnel healthy? Is the team following up? Where is revenue coming from, and where are we losing it?** Every number in it is clickable and drills down to the exact leads behind it, filtered by the viewer's permissions.

### 13.1 Global controls (every analytics screen)

- Date range (presets: today, 7d, 30d, this month, last month, quarter, custom) with **compare to previous period** (deltas shown as ▲/▼ %).
- Filters: pipeline, owner/rep, team, source, tag, and **any select/multi-select/boolean custom field** (e.g. "Struggles").
- "Group by" on any categorical field. This is what makes analytics general-purpose.
- Scope follows `analytics.view` (`own` → the rep sees only their own numbers; the leaderboard is hidden unless `team`/`all`). Revenue widgets are hidden without `analytics.revenue`.
- Every chart has "View leads" drill-down and (with `leads.export`) CSV export of the underlying aggregate.

### 13.2 Overview dashboard (default)

KPI tiles with period deltas: new leads · contacted % · reply rate · calls booked · calls held · won · win rate · revenue won · avg deal value · median speed-to-lead · follow-ups overdue now · pipeline forecast. Below the tiles: the funnel chart, a leads-over-time chart (by source), and "needs attention" lists (stuck leads, overdue follow-ups, unassigned leads, leads needing a country code).

### 13.3 Funnel and pipeline

- **Cohort funnel:** of leads created in the period, the % that ever reached each stage (from `lead_stage_history`, so skipped stages are handled correctly). Shows stage-to-stage conversion and drop-off.
- **Snapshot:** current count and value per stage.
- **Time in stage:** median and P75 per stage. **Stuck leads:** in a stage longer than its `sla_hours`.
- **Pipeline velocity:** (open leads × win rate × avg deal value) ÷ avg sales-cycle length.
- **Sales cycle length:** median days from created → won.
- **Forecast:** Σ(open lead value × stage `win_probability`), by expected month.

### 13.4 Team performance

Per rep (a table, plus a leaderboard for managers):
- Leads assigned, contacted, contact rate
- **Speed-to-lead:** median time from assignment → first `whatsapp_opened`/`call_logged`. % contacted within 1h / 24h.
- Replies, reply rate, calls booked, calls held, no-shows, won, win rate, revenue
- **Follow-up discipline:** follow-ups due, done on time %, avg lateness, currently overdue. **This is the metric that matters most for Nupuur.**
- Touches per won deal (average activities before winning)
- Activity volume by day (sparkline)
- **Goals:** progress bars against `goals` (e.g. "Won: 12 / 20 this month"), for each rep, team and business.

### 13.5 Other analytics modules

| Module | Metrics |
|---|---|
| **Sources** | Leads, conversion and revenue by source. Cost-per-lead if the admin enters monthly spend per source (optional field). |
| **Segments** | Conversion and revenue by any custom field value (e.g. which "struggles" convert best) |
| **Meetings** | Booked, held, canceled, no-show rate, booked → won rate, meetings per rep, **best booking slots** heatmap (day × hour) |
| **Lost analysis** | Lost by reason, by the stage where lost, by rep, by source. Re-engagement: lost → reopened → won counts and revenue recovered. |
| **Timing** | Heatmaps of when leads arrive, and when leads reply (from `reply_logged`), i.e. the best time to message |
| **Templates** | Per template: sends (confirmed), replies logged within 72h, reply rate, and wins attributed (lead won within 30 days of send). Noted in the UI as depending on reps logging replies. |
| **Revenue** | Won revenue over time, by product/package, by rep, by source, avg deal value, cumulative vs goal |
| **Data quality** (admin) | Leads needing a country code, invalid numbers, duplicates merged, import errors per source, unassigned leads age |
| **Security** (admin, `audit.view`) | Contact reveals per user per day, exports, failed logins, alerts triggered, active sessions |

### 13.6 Implementation

- **Instrumentation first:** analytics are only as good as the events. Stage history, assignment history, activities and task completion timestamps must be written from Phase 1, before the analytics UI exists.
- Queries: SQL over the event tables, bucketed with `date_trunc` **in the installation timezone** (`AT TIME ZONE settings.timezone`).
- **Rollups:** `analytics_daily_user` (date, user, metrics…), `analytics_daily_stage` (date, pipeline, stage, entered, exited, count_open, value_open), and `analytics_daily_source`. These are refreshed by a worker job every 10 minutes for "today" and nightly for full recomputation of the last 7 days (to catch backdated edits). Dashboards read rollups; drill-downs query live tables.
- At expected volumes (under 100k leads per installation), live queries are fine for drill-downs. Add `EXPLAIN` checks in tests for the heavy ones.
- RLS applies to analytics queries too: rollups are per-user, so a rep's `own` scope filters on `user_id = me`.

### 13.7 Analytics API

`GET /api/v1/analytics/:module?from&to&compare=1&filters=…&groupBy=…` returns `{ series, totals, previousTotals, drilldownToken }`. `GET /api/v1/analytics/drilldown/:token` returns a paginated lead list (with RLS and masking applied). Drilldown tokens are signed and short-lived, and encode the exact filter.

### 13.8 Scheduled reports

A weekly email (Monday 09:00 business time) to users with `analytics.view:all`: last week's KPIs vs the prior week, top rep, biggest drop-off stage, and overdue count. Aggregates only, no contact data.

---

## 14. Search, filters and views

- Global search (Cmd/Ctrl+K): name, email, Instagram, phone digits (full-contact roles only), across leads in scope. Uses trigram similarity, with results in under 200 ms.
- Filters from Tasneem's list, all built in: **name, contact number, email, "handled by", follow-up (due today / overdue / none scheduled)**, plus stage, owner, source, tag, date ranges, phone status and any custom field.
- **Saved views:** personal, or shared with roles. Seed useful ones: "My overdue", "New today", "No reply 3+ days", "Calls this week", "Lost — re-engage".
- The table supports column choose/reorder/resize, sort, inline edit (per field access) and bulk actions (per permission).
- The Kanban board per pipeline is drag-to-move (with required-field prompts on entering a stage, and lost-reason prompts on Lost).

---

## 15. Deployment and operations

### 15.1 Resource budget on KVM 2 (2 vCPU / 8 GB)

| Component | Memory limit | Notes |
|---|---|---|
| Postgres | 3 GB | `shared_buffers=2GB`, `effective_cache_size=5GB`, `work_mem=16MB`, `maintenance_work_mem=256MB`, `max_connections=50`, `wal_compression=on`, `random_page_cost=1.1` (NVMe) |
| api | 768 MB | `--max-old-space-size=512`, DB pool 10 |
| worker | 768 MB | pool 5, job concurrency 4 |
| web | 768 MB | Next.js standalone output |
| caddy | 128 MB | |
| Headroom | ~2.5 GB | OS, page cache, backups |

**Build images in CI (GitHub Actions), not on the VPS.** 2 vCPUs building Next.js while serving users is a bad time. Push to GHCR (private). Deploy = `docker compose pull && docker compose run --rm migrate && docker compose up -d`.

### 15.2 Environments and releases

- `main` → CI (lint, typecheck, unit, integration with Testcontainers, the RBAC matrix, Playwright smoke) → image tags by git SHA.
- Staging: a second compose project on the same VPS is **not** allowed (resources, and risk). Use a separate small VPS or local Docker for staging.
- Migrations are forward-only, reviewed, and run by a one-off `migrate` container using `lume_owner`. Every migration must be backwards-compatible with the previous app version (expand → migrate → contract), so a failed deploy can be rolled back by re-deploying the previous image.
- Release notes auto-generated per client installation. A version is shown in Settings → About.

### 15.3 Per-client installation

- `infra/.env.example` documents every variable. `packages/config` validates them at boot and refuses to start on anything missing or weak (e.g. a master key shorter than 32 bytes).
- **First-run setup wizard** (runs only when there are zero users, and only via a one-time setup token printed in the server logs): business name, timezone, currency, default country, **industry preset** (seeds pipeline, stages, fields, templates, lost reasons), then create the owner account + mandatory 2FA.
- **Nupuur preset ("Coaching / consulting"):** fields `struggles` (long text or multi-select, TBD), `handled_by` (user), plus the core fields. Stages: New → Message sent → Replied → Call booked → Call done → Won / Lost (+ Follow-up later, open). Templates: first touch, gentle nudge, call reminder (24h), call reminder (1h), post-call follow-up, re-engagement. *Final stage list to be confirmed with Tasneem.*

### 15.4 Monitoring

- `GET /healthz` (liveness) and `GET /readyz` (DB + job queue reachable), monitored externally (UptimeRobot or Better Stack) with email/WhatsApp alerts to Kedar.
- The System health page (10.4).
- Structured logs with request ids. Retain 14 days on disk.
- Disk usage alert at 75%.

---

## 16. UX requirements (behaviour; visuals are Claude Code's call)

Design with the `apple-design` skill. Brand inputs: the LUME 6-petal blue rosette logo and a colour system derived from the logo gradient. It must work well on a laptop (primary for Tasneem) **and** on a phone (reps on the go). Light and dark mode.

**Typography (decided):** **Inter** (variable, self-hosted as WOFF2 under `apps/web/public/fonts`, never loaded from Google Fonts, to keep the strict CSP). Poppins is explicitly rejected.
- Use the variable font's optical-size axis (`font-optical-sizing: auto`) so large headings get display letterforms and small UI text gets text letterforms. Apply the apple-design skill's tracking and leading rules on top.
- Enable tabular figures (`font-variant-numeric: tabular-nums`) for all tables, KPI tiles, timestamps, phone numbers and currency.
- Enable `cv11` (single-storey a) only if it tests better visually. Otherwise use defaults.
- Fallback stack: `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`.
- Do **not** bundle SF Pro or Google Sans. Neither is licensed for use as a webfont in a third-party product.

### 16.1 Required screens

1. **Today (home):** personal to the user. Overdue follow-ups, due today, today's lead meetings, new leads assigned to me, and quick stats. For admins, also: unassigned leads, source/sync issues, security alerts. **It answers "what do I do next?"**
2. **Leads:** table and Kanban toggle, filters, saved views, bulk actions, "Needs country code" smart view.
3. **Lead drawer/page:** header (name, stage, owner, primary actions: WhatsApp, Log reply, Add follow-up, Change stage), fields grouped, a timeline of activities, tasks, meetings. Every primary action must be reachable within 1 click from the lead.
4. **Calendar:** lead meetings only, with filters and log-outcome prompts.
5. **Notifications panel:** a slide-over reachable from anywhere.
6. **Send queue** focused mode.
7. **Analytics** (Section 13).
8. **Templates** library and editor.
9. **Settings:** business, pipelines & stages, fields, lost reasons, tags, products, sources (with health), integrations, users, roles & permissions (a matrix UI with scope pickers, plus field access), teams, notifications, security (2FA policy, sessions, IP/time restrictions, anomaly thresholds), audit log, system health, backups status.
10. **Onboarding:** first-run wizard, the sheet connection wizard, and a per-user welcome (connect calendar, set digest time, set timezone).

### 16.2 Interaction rules

- Keyboard shortcuts for power users (`/` search, `n` new lead, `f` follow-up, `w` WhatsApp, `j/k` navigate list), with a shortcut sheet on `?`.
- Optimistic UI for quick actions, with rollback and a clear error if the server rejects.
- Empty states always explain the next action.
- Destructive actions need confirmation; reversible ones use undo toasts instead.
- Everything the user can't do is **absent**, not disabled with a lock (don't advertise hidden capabilities to restricted roles). The one exception is the admin UI explaining permissions.

---

## 17. Build plan (phases with acceptance criteria)

Each phase ends with a demo-able build deployed to staging.

**Phase 0 — Foundations**
Monorepo, config validation, Docker Compose, Caddy, Postgres roles, migration pipeline, CI, bootstrap-server script, backups + restore test.
✅ `docker compose up` on a fresh Ubuntu VPS yields HTTPS, health checks pass, a backup is created, and the restore test passes.

**Phase 1 — Identity, RBAC, core data**
Setup wizard, auth, 2FA, sessions, invites, roles/permissions/field access, teams, RLS, audit log, settings, pipelines/stages, field definitions, lead CRUD with history tables, industry presets.
✅ The RBAC matrix test passes for every route. A sales user cannot retrieve an out-of-scope lead via any endpoint or via raw SQL as `lume_app`. Disabling a user ends their sessions within 1 request.

**Phase 2 — Intake and phone numbers**
Sheets source (service account, mapping, preview, dedupe, sync, health), webhook source, CSV import, phone normalisation, country picker, bulk fix.
✅ A 500-row test sheet with mixed number formats imports with zero duplicates, correct `phone_status`, and re-sync creates nothing new. Sorting the sheet creates nothing new. Renaming a mapped column pauses the source and alerts the admin.

**Phase 3 — Tasks, follow-ups, notifications**
Tasks, reminders, recurrence, the scheduling engine + sweeper, SSE panel, escalation, email digest, stage automations.
✅ The reliability test suite (10.4) passes, including killing the worker mid-run.

**Phase 4 — WhatsApp and templates**
Templates, prepare/send flow, sent confirmation, log reply, send queue with caps, re-engagement views.
✅ Messages render correctly with all variable types. Masked users can send without ever receiving the raw number in any response.

**Phase 5 — Calendar and Calendly**
Google OAuth, incremental sync + watch + renewal, matching rules, Calendly webhooks, meeting outcomes, calendar UI.
✅ A connected calendar holding 50 personal events and 5 lead events shows exactly the 5, and the personal events are not in the database. A Calendly booking moves the lead to "Call booked" within 30s.

**Phase 6 — Anti-exfiltration**
Masking, reveal metering, anomaly detection, watermarked exports, on-screen watermark, offboarding flow, security analytics.
✅ Simulated scraping by a sales user (rapid reveals/views) triggers an alert and, with auto-suspend on, kills the session.

**Phase 7 — Analytics**
Rollups, all modules in Section 13, drill-downs, goals, weekly report.
✅ Analytics numbers match hand-computed values on a seeded fixture dataset (write the fixture and expected numbers as tests).

**Phase 8 — Polish and hardening**
Performance pass (p95 API under 300 ms on KVM 2 with 50k seeded leads), accessibility pass, security review against the OWASP ASVS L2 checklist, runbooks, admin docs, and a handover checklist for Tasneem.

---

## 18. Open items (ask the owner when you reach them; do not guess)

1. **LUME domain name** and the client subdomain for Nupuur.
2. **SMTP provider** for digests and invites (Brevo / Resend / Amazon SES / Hostinger mail).
3. **Backup storage:** Backblaze B2 vs Cloudflare R2 (and who owns the account).
4. **Sales reps and contact data:** masked with metered reveal (current default), fully hidden (WhatsApp button only), or fully visible?
5. **SuperReply:** can it POST to a webhook directly? If yes, prefer the webhook source over the sheet.
6. **Calendly plan** on Nupuur's account (webhooks need Standard or higher).
7. **Final pipeline stages, lost reasons and templates** from Tasneem, plus whether "struggles" is free text or a fixed list.
8. **Currency** for Nupuur's install (AED or INR) and package names/prices for the `products` list.
9. Whether **teams / team-lead scope** is needed at launch, or roles with `own`/`all` are enough for now.
10. Whether reps work across **multiple timezones** (affects digest times and working-hours rules).

---

## Appendix A — Glossary

- **Lead:** a person who might buy. Belongs to exactly one pipeline and one stage at a time.
- **Owner:** the user the lead is assigned to. Drives `own` scope.
- **Follow-up:** a task for a team member.
- **Reminder message:** a WhatsApp template scheduled for a lead, sent by click.
- **Source:** where leads come from (sheet, webhook, Calendly, CSV, manual).
- **Scope:** own / team / all. How far a permission reaches.
- **Reveal:** a metered, audited one-time view of a masked contact.
