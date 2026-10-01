# Phase 5B + 5C (backend) — Calendly, and meetings in messages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native). Steps use checkbox (`- [ ]`) syntax for tracking. Tests are described in prose and written in full, first (standing ruling since 3B).

**Goal:** Everything 5B and 5C need on the server, so the screens can follow the owner's designs. Plus the one 5A piece still missing on the server, the admin's Calendar rules.
- **Calendly:**
  - An admin connects the business's Calendly. A booking arrives by webhook and finds or makes its lead, records the meeting, moves the lead to its pipeline's "on booking" stage and tells its owner, within 30 s.
  - A cancellation marks the meeting, tells the owner and (a switch) sets a Reschedule follow-up.
- **Meetings in messages:**
  - Templates' meeting variables render from the lead's next meeting.
  - A stage automation reminds the lead before their meeting.
  - Today lists today's calls.

**Architecture:**
- **Calendly is a lead source** (`lead_sources.type = 'calendly'`), as a webhook is. It reuses what 2C built:
  - the sealed config;
  - the accepted-post store (`webhook_events`, sealed, deduped by key);
  - the replay table;
  - the processing queue;
  - the intake engine, which matches a lead by email or phone, or makes one, under the source's rules.
- Its own receive route checks Calendly's signature.
- The processor (`calendly/process.ts`) runs from the webhook queue when the event's source is Calendly.
- The connection uses Calendly's API (`/users/me`, `/webhook_subscriptions`) through a small client. The tests use a fake Calendly, as Google's.

**Tech Stack:** Fastify, Drizzle + raw SQL, pg-boss (the webhook queue), the intake engine (`imports/row.ts` `writeRow`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-phase-5-calendar-design.md` (§2.2 rules, §3 5B, §4 5C).

## Global Constraints

- CLAUDE.md:
  - Calendly is an optional module: off until an admin connects it; LUME works without it.
  - No client names.
  - Lead data leaves the instance only to integrations the client enabled. LUME only reads from Calendly (and creates or deletes its own webhook subscription).
- The personal access token and the webhook signing key are sealed with the instance keyring, bound to their source (`lead-source:<id>`), as a webhook's secret is. Neither ever reaches a log line, an error, an audit diff or a response.
- The signature: `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(signing key, "<t>.<raw body>")>`, accepted within 5 minutes; a signature works once.
- New migrations only, numbered after the last (`0038`…). Every new table has row-level security from its first migration.
- Copy speaks as "LUME". No screens in this plan: they follow the owner's designs.
- Tests run on the dev box through `scripts/dev.sh run`. The access matrix (`apps/api/test/probes.ts`) gets a probe for every new route. Every new audit action gets its words in `apps/web/src/lib/settings/audit.ts` and the `WRITTEN` list.

## Review Focus

1. A booking for someone already a lead (same email, any case, or the same phone from the mapped question) updates that lead, never makes a second.
2. The same booking delivered twice, or replayed with its signature, makes one meeting and one history line.
3. A Calendly reschedule (a cancel with `rescheduled: true`, then a new booking) leaves one cancelled-as-rescheduled meeting and one new one, with no Reschedule follow-up and no "cancelled" alarm.
4. Required fields on the "on booking" stage, or a lead already past it (won or lost), never lose the booking: the meeting is kept and the event says why the lead didn't move.
5. A token Calendly stops honouring, or a plan without webhooks, is said in LUME's words, never with the token or Calendly's raw error.

---

### Task 1: The admin's Calendar rules (5A's missing API)

**Files:** `apps/api/src/modules/calendar/rules.ts` (service), `routes.ts`, tests in `calendar/rules.test.ts`; `apps/web/src/lib/settings/audit.ts` (+test).

- `GET /api/v1/settings/calendar` (`settings.manage`) → `{ rules: { attendeeIsLead, titleWords, calendarIds } }` (defaults when unset).
- `PUT /api/v1/settings/calendar` `{ rules }`, validated by core's `calendarRulesSchema`:
  - title words are trimmed, blanks dropped, repeats dropped (any case);
  - audited `settings.calendar` with the counts (never the words).
- Tests (written first):
  - the defaults;
  - a put round-trips, trims and drops blanks and repeats;
  - an invalid shape → 400;
  - without `settings.manage` → 403;
  - the sync reads the new rules at its next run (a title word set through the API keeps an event).

### Task 2: Data — Calendly as a source, and the "on booking" stage

**Files:** `packages/db/migrations/0038_calendly.sql`, `packages/db/src/schema/{intake,config}.ts`, `apps/api/src/modules/pipelines/{service,routes}.ts`, tests.

- `lead_sources.type` gains `'calendly'` (the CHECK replaced).
- `pipelines.booking_stage_id uuid REFERENCES stages ON DELETE SET NULL`: a lead booked through Calendly moves there. Null means no move.
- `PATCH /api/v1/pipelines/:id` accepts `bookingStageId: uuid | null`. It must be a live stage of that pipeline (400 `UNKNOWN_STAGE` otherwise), and is shown in the pipeline list.
- Tests (written first):
  - a booking stage set, shown and cleared;
  - another pipeline's stage → 400;
  - archiving the stage leaves no booking stage;
  - the drift test passes.

### Task 3: The Calendly client and the fake

**Files:** `apps/api/src/modules/calendly/client.ts`, `apps/api/test/calendly-fake.ts`, `calendly/client.test.ts`.

- `createCalendly({ token, endpoint? })`:
  - `me()` → `{ uri, name, email, organization }`;
  - `subscribe({ url, signingKey, organization, user })`:
    - organization scope first;
    - user scope when Calendly refuses organization scope (the token's person isn't an org admin);
    - a subscription already at that URL is found (list), deleted and made again, so LUME holds its signing key;
  - `unsubscribe(uri)`.
- Errors are a typed `CalendlyError` with a kind:
  - `token`: 401;
  - `plan`: 403 saying the plan needs upgrading;
  - `forbidden`: another 403;
  - `unavailable`: 5xx or the network, retried 1-2-4 s as Google's.
- The fake:
  - tokens, users, an organization;
  - subscriptions with their URL, scope and signing key;
  - a "free plan" mode;
  - org-admin or not;
  - `post(event, payload)`, which signs and delivers to a subscription's URL as Calendly does;
  - `calls`.
- Tests (written first):
  - `me()`;
  - organization scope when allowed, user scope when not;
  - an existing subscription is replaced;
  - each error kind;
  - a 503 retried, then `unavailable`.

### Task 4: Connecting Calendly

**Files:** `apps/api/src/modules/calendly/{service,routes}.ts`, tests `calendly/connect.test.ts`; `sheets/service.ts` `integrationsView`; probes; audit words.

- `POST /api/v1/integrations/calendly` `{ token }` (`integrations.manage`):
  - reads `me()`, then makes the source (`type = 'calendly'`, name "Calendly", run as the admin);
  - rules: the default pipeline's first open stage, `matchOn: ["email", "phone"]`, `onMatch: "merge"`, owner unassigned, with the host's email mapped to the owner (falling back to the rule), the business's country;
  - a fixed mapping: name, email, phone, host email → owner;
  - subscribes with a new signing key to `<publicUrl>/webhooks/calendly/<id>`, then seals `{ token, signingKey, subscription, organization, user, scope }`;
  - audit `calendly.connected` (the Calendly account's name only).
- Refusals:
  - one Calendly per instance (409 `CALENDLY_CONNECTED`);
  - `token` → 400 `CALENDLY_TOKEN` "Calendly didn't accept that token…";
  - `plan` → 409 `CALENDLY_PLAN` "Calendly sends bookings to other apps only on its Standard plan or higher…";
  - `unavailable` → 503.
  - Nothing is kept on a refusal.
- `GET /api/v1/integrations/calendly`:
  - `{ connected: false }`, or `{ connected: true, account: { name, email }, scope, status, settings, lastEventAt, lastError }`;
  - never the token or the key.
- `PATCH …/calendly` `{ createLeads?, rescheduleFollowUp?, phoneQuestion?: string | null }`:
  - the settings live in the source's sealed config;
  - `createLeads` and `rescheduleFollowUp` default on.
- `DELETE …/calendly`:
  - unsubscribes, best effort; a Calendly that's down doesn't stop LUME forgetting;
  - archives the source;
  - meetings and leads stay;
  - audit `calendly.disconnected`.
- `integrationsView` gains `calendly: { connected }`.
- Tests (written first):
  - a connect makes one source and one subscription with the instance's URL;
  - the token and key are sealed: no column, response or audit row holds them;
  - each refusal and what's kept (nothing);
  - user scope when not an org admin;
  - a second connect → 409;
  - disconnect unsubscribes and archives, and survives Calendly down;
  - 403 without `integrations.manage`.

### Task 5: Receiving Calendly's webhooks

**Files:** `apps/api/src/modules/calendly/receive.ts`, `calendly/signature.ts`, tests `calendly/receive.test.ts`; `app.ts` registration.

- `POST /webhooks/calendly/:id`:
  - public, outside the session scope (as 2C's), under the licence guard and the same limiter;
  - raw body, 64 KB limit.
- Checks, in order: a live Calendly source; the signature (`t`, `v1`, 5-minute tolerance, timing-safe); the signature not seen before (`webhook_signatures`).
- Then the post is kept sealed in `webhook_events`:
  - the key is `<event>:<payload.uri>`, so the same delivery is one row;
  - it's queued, and the answer is 202;
  - a stranger, a bad signature or a stale one gets 401, said the same way, and is counted as refused.
- Only `invitee.created` and `invitee.canceled` are kept; any other event → 202, not kept.
- Tests (written first):
  - a signed booking is accepted and queued once;
  - the same delivery again → 202 duplicate, one row;
  - a replayed signature → duplicate;
  - a bad, missing or stale signature → 401, counted;
  - an unknown or archived source → 401;
  - another event type is ignored;
  - a locked licence → refused;
  - nothing in the row is readable without the keyring.

### Task 6: A booking and a cancellation

**Files:** `apps/api/src/modules/calendly/process.ts`, tests `calendly/process.test.ts`; `webhooks/process.ts` (dispatch by source type); notification kinds; audit and activity.

- **`invitee.created`**:
  - The cells (name, email, phone from `text_reminder_number` or the answer to `phoneQuestion`, host email) go through `writeRow` under the source's rules, so the lead is matched (email, phone) or made, and the source and owner rules apply.
  - With `createLeads` off and no match, there's no lead: the meeting is kept unlinked for the host.
  - The meeting:
    - `source = 'calendly'`;
    - `external_id` = the invitee's URI;
    - owner = the host, mapped to a LUME person by email; else the lead's owner; else the person the source runs as;
    - title = the event type's name;
    - times, the join URL or location;
    - `matched_by = 'calendly'`.
  - History: `meeting_booked` on the lead, with when and the event type.
  - The lead moves to its pipeline's booking stage, as the source's person, with the stage's automations:
    - not when it's already there, or won or lost;
    - a refusal (required fields) is the event's problem, with the meeting kept.
  - The lead's owner (else the host) hears it: `meeting_booked`, "<lead> booked <event type>, <day time>".
- **`invitee.canceled`**:
  - The meeting becomes `cancelled`, or `rescheduled` when `rescheduled: true`.
  - History: `meeting_cancelled` (or `meeting_rescheduled`), with the reason Calendly gives.
  - When not a reschedule:
    - the owner hears it (`meeting_cancelled`);
    - with `rescheduleFollowUp` on, a follow-up "Reschedule: <lead>", due now, goes to the owner;
    - a Log outcome follow-up for that meeting is closed.
- Done within the queue's first pass: the booking-to-stage target is under 30 s.
- Tests (written first):
  - Review Focus 1–4;
  - a new lead in the first stage, then moved to the booking stage, its automations run;
  - an unknown host → the lead's owner's meeting;
  - `createLeads` off: an unlinked meeting, no lead;
  - a cancellation: status, history, notification, Reschedule follow-up once;
  - a cancellation for a booking LUME never saw → nothing to change, done;
  - the time from accepted to moved, under 30 s with the queue running at once.

### Task 7: Meeting variables in messages

**Files:** `packages/core/src/messaging/render.ts` (+test), `apps/api/src/modules/leads/sending.ts` (and wherever the render context is built), tests.

- `RenderContext.meeting?: { startsAt: string; link: string | null } | null`.
- The variables:
  - `{{meeting.date}}`: "Thursday 3 October", in the business's zone;
  - `{{meeting.time}}`: "4:30 pm", in the business's zone;
  - `{{meeting.link}}`;
  - with no meeting, or no link, they're "missing", as today.
- The context's meeting is the lead's next scheduled meeting from now, of any source, as row-level security lets the sender see it.
- Tests (written first):
  - render with a meeting (date and time in the zone, across midnight);
  - no meeting → missing;
  - the send path uses the next meeting, not a past or cancelled one.

### Task 8: "Remind the lead before their meeting" (a stage automation)

**Files:** `packages/core/src/tasks/rules.ts` (+test, `describeRule`), `apps/api/src/modules/tasks/automations.ts` (+test).

- A new stage rule `{ id, type: "remind_before_meeting", hoursBefore: 1–72, templateId }`.
- When a lead enters the stage it sets the lead's owner a WhatsApp follow-up (4A's reminder messages):
  - with the template;
  - due `hoursBefore` before the lead's next meeting;
  - its title is "Remind <lead> about <event or meeting>".
- It does nothing (said in history) when:
  - there's no upcoming meeting;
  - the time is already past;
  - the template is gone;
  - the lead has no owner.
- Tests (written first):
  - the follow-up's due time and template;
  - each "does nothing" with its history line;
  - a Calendly booking moving the lead into a stage with this rule sets it (Task 6 + 8 together);
  - `describeRule` words.

### Task 9: Today's calls

**Files:** `apps/api/src/modules/tasks/today.ts` (+test).

- `GET /api/v1/today` gains `meetings`:
  - the caller's own meetings (as owner) starting today in their zone;
  - not cancelled, earliest first;
  - id, title, times, link, status, and the lead (id, name) if linked;
  - row-level security as everywhere.
- Tests (written first):
  - today's meetings in the caller's zone (an 11 pm one belongs to the right day);
  - another person's meetings never;
  - cancelled left out.
