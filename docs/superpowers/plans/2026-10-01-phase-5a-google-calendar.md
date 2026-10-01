# Phase 5A — Google Calendar (lead meetings only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native). Steps use checkbox (`- [ ]`) syntax for tracking. Tests are described in prose and written in full, first (standing ruling since 3B).

**Goal:** A person connects their Google Calendar through LUME's relay; LUME reads it every five minutes and keeps only the events that are meetings with leads (by the admin's rules), never anyone's personal events; the meetings are there for the API to show (the Calendar screen, the drawer and Log outcome are built in Task 7, after the owner approves their designs).

**Architecture:**
- **Connect** reuses 2B-2's relay: `GET /start` gains a signed `k=calendar` that asks Google for read-only calendar scopes and, with no Picker, hands the sealed grant straight back to the instance's `/calendar/connected`. The instance keeps the grant sealed in `calendar_connections`.
- **Sync** runs in the API process (as sheets do): every 5 minutes per connection, plus Sync now. `events.list` per chosen calendar with an incremental `syncToken`; `410 Gone` resyncs −30…+90 days. Each event goes through the rules; a match becomes (or updates) a `meetings` row; a non-match is dropped without a trace beyond the sync token.
- **Meetings** are rows with row-level security that follows their lead (as tasks); an unlinked meeting is its owner's alone.

**Tech Stack:** Fastify, Drizzle + raw SQL, pg-boss, the relay (`apps/connect`), the fake Google (`apps/api/test/google-fake.ts`), vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-phase-5-calendar-design.md` (§2).

## Global Constraints

- CLAUDE.md: Google Calendar is an optional module; LUME works with it off. No client names. Lead data leaves the instance only to integrations the client enabled — and this one only *reads*.
- Read-only scopes only: `https://www.googleapis.com/auth/calendar.events.readonly` and `https://www.googleapis.com/auth/calendar.calendarlist.readonly`.
- A non-matching event is never written anywhere (no table, no log line with its title or attendees).
- Grants are sealed with the instance keyring, bound to their row (`calendar-connection:<id>`), as a sheet's are.
- New migrations only, numbered after the last (`0035`…). Every new table has row-level security from its first migration.
- Copy speaks as "LUME"; no sound for syncing.
- Tests run on the dev box through `scripts/dev.sh run`; the access matrix (`apps/api/test/probes.ts`) gets a probe for every new route.

## Review Focus

1. 50 personal events and 5 lead events in a calendar: after a sync, exactly 5 meetings, and no table holds a personal event's title, time or attendee (a test reads every text column of every table).
2. A rep sees only meetings with leads they may see; another person's unlinked meeting is invisible.
3. A grant Google refuses (revoked) marks only that connection "needs reconnecting"; others keep syncing.
4. An event moved, retitled, cancelled, or no longer matching updates or removes its meeting at the next sync.
5. Disconnecting removes the connection's grant and every meeting it brought.

---

### Task 1: The relay's calendar kind

**Files:** `apps/connect/src/relay.ts`, `apps/connect/src/relay.test.ts`, `packages/core/src/relay/protocol.ts` (+ test).

- `Handoff` gains `kind?: "sheet" | "calendar"`; `file` becomes optional (a calendar has none).
- `GET /start?i&n&s&k=calendar`: the signature covers `n` and `k` (`sign(token, "n.calendar")`), so a sheet link can't be turned into a calendar one. Scope: the two read-only calendar scopes. State carries the kind.
- `GET /callback` for a calendar: exchange the code, then redirect at once to `<instance>/calendar/connected?p&s` with the sealed `{ nonce, refreshToken, kind: "calendar", exp }`. Consent turned down: the words page, as for sheets.
- Tests (prose, written first): a calendar start asks Google for exactly the two scopes and nothing else; a tampered `k` is refused (400); the callback hands a sealed calendar grant to that instance's `/calendar/connected` with no Picker page; a sheet start is unchanged (existing tests stay green).

### Task 2: Data

**Files:** `packages/db/migrations/0035_calendar.sql`, `packages/db/src/schema/calendar.ts`, schema index, `packages/core/src/calendar/*` (types, rules).

- `calendar_connections`: `id`, `user_id` (unique: one per person), `google_email`, `grant_enc`, `calendars` jsonb (`[{ id, name, chosen, syncToken }]`), `status` (`active` | `needs_reconnect`), `last_synced_at`, `next_sync_at`, `failures`, `last_error`, timestamps. RLS: a person's own row; LUME's sync reads as `lume.lead_scope = all` with the user set (as sheets' run-as).
- `meetings`: as spec §2.4 (`lead_id` nullable, `owner_id`, `connection_id` nullable — Calendly's have none, `source`, `external_id`, unique `(source, owner_id, external_id)`, `title`, `starts_at`, `ends_at`, `link`, `location`, `status`, `outcome`, `outcome_note`, timestamps). RLS: linked → the lead's visibility (as tasks); unlinked → its owner only.
- `settings.calendar` jsonb: `{ rules: { attendeeIsLead: true, titleWords: [], calendarIds: [] } }`.
- `packages/core/src/calendar/rules.ts`: `matchEvent(event, { leadsByEmail, rules, calendarId })` → `{ leadId | null, why: "attendee" | "title" | "calendar" } | null`.
- Tests: the rules in isolation (each rule on and off, case-insensitive emails, a title word inside another word doesn't match, the organiser counts as an attendee); RLS (a rep can't read a meeting with another's lead; an unlinked meeting is its owner's only).

### Task 3: Connecting on the instance

**Files:** `apps/api/src/modules/calendar/{routes,connect,service}.ts`, tests; `apps/api/src/capabilities.ts`.

- `POST /api/v1/calendar/connect` (`calendar.connect`): reuses `oauth_connects` (kind `calendar`) and returns the relay URL.
- `POST /api/v1/calendar/complete` `{ p, s }`: the hand-back checked as sheets' is (signed, sealed, fresh, the same person's open connect, once — locked); the grant sealed into `calendar_connections`; the calendar list read; the primary chosen; a first sync queued.
- `GET /api/v1/calendar/connection`, `PATCH` (which calendars), `POST …/sync`, `DELETE` (disconnect: the grant and every meeting it brought gone; audit).
- `CAPABILITIES.calendar` true when Connect with Google is configured here.
- Tests: the whole connect with the relay and the fake (as `connect.test.ts`); someone else's or a replayed hand-back refused; disconnect leaves no grant and no meetings; without `calendar.connect`, 403; with the module off (no relay), the routes say so (409).

### Task 4: The calendar client and the fake

**Files:** `apps/api/src/modules/calendar/google.ts`, `apps/api/test/google-fake.ts` (calendarList, events with `syncToken`, `410`).

- `calendarList()`, `events(calendarId, { syncToken } | { timeMin, timeMax })` with paging; `410` → a typed `SyncTokenGone`; transient errors as sheets' (`isTransient`).
- Fake: per-calendar events, a `nextSyncToken` that returns only what changed since, `410` on demand, attendees, cancelled events (`status: cancelled`).
- Tests: paging, incremental tokens, 410, cancelled events come through incremental reads.

### Task 5: The sync

**Files:** `apps/api/src/modules/calendar/sync.ts`, `queue.ts`, tests; `apps/api/src/main.ts` wiring.

- Per connection, under its own lock: for each chosen calendar, read since its token (or the window), match each event, upsert matched meetings, delete a meeting whose event was cancelled or no longer matches, store the new token. A grant refused → `needs_reconnect` (the person and admins hear once); transient → back off as sheets do.
- Every 5 minutes for due connections; Sync now; a licence lock holds it (`heldBack(app, "calendar syncs")`).
- Tests: Review Focus 1 (50 + 5, every text column scanned), 3, 4; a lead whose email changes later is matched at the next full read; two syncs at once make one.

### Task 6: Meetings in the API

**Files:** `apps/api/src/modules/meetings/{routes,service}.ts`, tests.

- `GET /api/v1/meetings?from&to&ownerId&pipelineId&stageId` (`calendar.view`, scoped), `GET /api/v1/leads/:id/meetings`, `PATCH /api/v1/meetings/:id` (attach an unlinked meeting to a lead; outcome + note), audit.
- After a meeting ends, its owner gets a "Log outcome" follow-up (the tasks sweeper's next pass; once per meeting).
- Tests: Review Focus 2; outcome recorded once; the Log outcome follow-up appears once, after the end.

### Task 7: Screens (after the owner approves the Calendar artboards)

The Calendar page (agenda, week), the drawer's meeting card and history lines, Log outcome, Settings → My account → Calendar, and the Settings → Calendar rules panel — built to the canvas once it's approved. **Not started until then.**
