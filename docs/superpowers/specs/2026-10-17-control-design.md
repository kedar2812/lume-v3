# Control each client: places and modules in the signed answer (design)

Project B, part 3 of 5 (feedback → fleet → **control each client** → get paid → win clients). Canvas:
https://claude.ai/artifact/32HRBdpQw1i356NZzGeHhu (page "3 · Control each client"). Written under the owner's full
authority (2026-10-16): decided and recorded here; the owner reviews at the end.

## 0. What it's for

Clients pay for different plans. Today every LUME can add as many people as it likes and switch on every module.
The owner wants, per client, a number of **places** (people who can use their LUME) and which **modules** are in
their plan (Google Sheets, Webhooks, Google Calendar, Calendly), set on license.lumecrm.in and kept by the client's
LUME — without ever deleting anything, locking anyone out of their data, or surprising the client.

Success: the owner sets "5 places; Calendly not included" on a client's page; within 6 hours their LUME says
"5 of 5 places" in Settings → People, refuses a sixth invite in plain words, and shows Calendly as not in its plan.

Rules that bind: nothing is ever removed (no person, no lead, no setting); export always works; an install on an
older LUME keeps working exactly as today (unlimited); the dashboard's and LUME's existing look; LUME's voice.

## 1. The plan, signed

- The licence server keeps, per client, `places` (1–10,000, or null = no limit) and `modules` (a map of the four
  module keys to included true/false; absent = included). Default for every client: no limit, all included.
- `/v1/check`: when the install lists `accepts: ["plan"]`, the signed payload gains `plan: { places: number | null,
  modules: { googleSheets, webhooks, googleCalendar, calendly } }` (each boolean). An install that doesn't list it
  gets no `plan` key (an older LUME refuses unknown keys).
- LUME from this release sends `accepts: ["announcements", "plan"]` and, in its health, `modulesOn`: which of the four
  are switched on now (fixed keys only) so the dashboard can warn before taking one away.
- No `plan` in the answer (older licence server, or a LUME from before it) = no limits.

## 2. In a client's LUME

### 2.1 Places
- Taken places = people active or paused, plus invites not yet accepted (so invites can't run past the limit).
- **Invite** when every place is taken: the Invite sheet says so as soon as it opens, before anyone types, and Send
  invite is disabled: "Every place on this LUME's plan is taken (5 of 5). Pause someone, or ask LUME's team about
  more places." The API refuses it too (409 `PLAN_PLACES`), for a stale screen.
- **Restore** a disabled person when full: refused the same way.
- Over the limit after the plan shrinks: nobody is removed or paused. Admins see one line in Settings → People:
  "7 people use this LUME and its plan has 5 places. Nobody loses access; new people can be added once there's
  room."
- Settings → People shows "4 of 5 places" (or nothing when there's no limit).

### 2.2 Modules
- A module not in the plan: its card in Settings → Integrations says "Not in this LUME's plan" and its switch is off
  and disabled; switching it on is refused (409 `PLAN_MODULE`).
- A module that is on when the plan takes it away: LUME switches it off at that check-in (the same as an admin
  switching it off: syncs stop, a webhook's posts are refused, Calendly's connection is kept but paused), writes the
  audit log ("integration.disabled", by the plan), and tells admins in the notification centre once: "Calendly was
  switched off: it isn't in this LUME's plan any more. Its settings are kept."
- Put back in the plan: nothing switches on by itself; an admin switches it on again.

### 2.3 What everyone else sees
Nothing changes for people who don't manage settings, apart from what a switched-off module no longer does.

## 3. The licence server

### 3.1 Storage — migration `0007_plan.sql`
`licences.places integer` (null = no limit, 1–10000) and `licences.modules jsonb NOT NULL DEFAULT '{}'` (only
`false` entries are meaningful); `events` gain kind `plan` with the change.

### 3.2 Admin API
- `GET /api/clients/:id` gains `plan: { places, modules }` and `usage: { people, modulesOn, knows }` (from the newest
  check-in; `knows` false on an older LUME, which can't be held to a plan).
- `PATCH /api/clients/:id/plan` `{ places: number | null, modules: { …: boolean } }`: validated, saved, a history line
  ("Plan: 5 places; Calendly not included"). Answers the client view.

### 3.3 The client's page
A **Plan limits** card under Plan and price:
- **Places**: No limit · a number (stepper), with "4 people use it now".
- **Modules**: four rows with the module's official mark and a switch; a module that is on at the client right now
  says so ("On at Kestrel Logistics now — switching it off stops it at their next check-in").
- **Save** (disabled until something changed); after it: "Saved. Their LUME keeps it from its next check-in, within
  6 hours."
- On an older LUME: "Their LUME (1.4.2) can't keep a plan yet; it will once it's updated." The card still saves.
- Clients list: a places column is not added (the card is the one place to set it); Fleet's table shows "5 of 5"
  under People when a limit is set.

## 4. Errors, security, testing
- Strict schemas on both sides; places 1–10000 or null; module keys from the fixed four.
- The plan rides inside the Ed25519-signed payload: a client can't raise their own limits.
- Tests first: core payload with `plan` (verifies; unknown module key refused); the server signs `plan` only with
  `accepts`; PATCH validation and history; LUME: invite and restore refused when full (pending invites count),
  nothing removed when over, the module switched off once with an audit row and one notification, turning on refused,
  older licence server = no limits; web: People's places line, the Invite refusal words, Integrations' "Not in this
  LUME's plan"; e2e: the dashboard's Plan limits card, and LUME refusing a sixth invite after the fake licence server
  signs places 5.

## 5. Out of scope
Plan presets (Starter/Growth), a lead-count cap, per-module usage metering, billing tied to places (part 4 invoices
read the price as today).
