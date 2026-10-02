# Phase 6A — Watch: anomaly rules, alerts, suspend, Settings → Security, the rep's side — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native). Steps use checkbox (`- [ ]`) syntax for tracking. Tests are described in prose and written in full, first (standing ruling since 3B).

**Goal:** a sales person who scrapes leads (rapid contact reveals or lead opens) is caught. LUME tells the admins at once. With "pause access" on, it also ends that person's sessions and blocks sign-in until an admin restores them. Admins get Settings → Security (Overview with alerts, Rules, Access limits). The person being watched gets a watermark, one calm notice, and an honest paused screen. Built to the owner's canvas https://claude.ai/artifact/M8FauNrEgtF9T62PkF69ka (boards in brackets: [Main], [Rules], [Access], [RepView]).

**Architecture:**
- **One source of truth for counting: the append-only audit log.** Every counted act already writes one: `lead.contact.reveal` (a reveal), `lead.view` (`GET /leads/:id`, the drawer or page) and `queue.started` (a send-queue run). The rules count those rows over a rolling window, read through a new partial index. The audit log has no row-level security, so the request, the inline check and the 5-minute sweep all read it the same way.
- **The rules engine is pure** and lives in `@lume/core` (`security/rules.ts`): defaults, merging stored settings, who is watched, breach and near-limit maths. The API module `modules/security` holds the counts, alerts, suspend and restore, routes, and the sweep.
- **The inline check** runs inside the request's own transaction, right after the act's audit row: the count sees its own row. On a pause it answers `403 SUSPENDED` **without throwing**, so the transaction commits: the suspension, the alert and the crossing attempt's audit row all persist, and the contact or lead is not returned.
- **Suspended** is a new `users.status`. The session reader turns a suspended user's cookie into a distinct result, so every later request gets `403 SUSPENDED`, and the browser shows the paused screen.
- **Screens** reuse the Settings frame, UI kit and `lib/motion.ts` springs. Security's tabs are routes.

**Tech Stack:** Fastify, Postgres (raw SQL + Drizzle), Zod, Next.js app router, React, motion/react, CSS modules, vitest + Testing Library, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-01-phase-6-anti-exfiltration-design.md` §2 (6A) and §5–§6.

## Rulings taken while planning (cost if wrong)

- **R1. No `lead_opens` table.** Spec §2.1 proposed one, but `GET /leads/:id` already writes a `lead.view` audit row per open, with its exact time. Counting `count(DISTINCT entity_id)` over those rows gives the same "different leads" rule, with exact rolling windows rather than hour buckets. Send-queue runs come from `queue.started` the same way, which also avoids `send_queues`' forced row-level security. Cost if wrong: a later table, if the audit log ever stops recording opens.
- **R2. Who is watched:** not the owner, and not someone holding `leads.contact.full` at scope `all`. That is the same test `requiresTwoFactor` already uses for "sees every contact". A team-scoped holder is watched, because they can't see every contact. The watermark's "People who can't see every contact" uses the same test. Cost if wrong: team leads are watched too, against high limits.
- **R3. One alert per person, rule and window.** An open alert for the same person and rule extends while it's younger than the window (60 minutes, or the same business day for the queue rule): `observed` takes the higher count and `window_end` moves on. A newer breach after that opens a new alert. Cost if wrong: a long scrape shows as two alerts.
- **R4. The crossing act is refused.** The reveal (or open) that crosses a pause rule's threshold doesn't return the contact (or lead). It answers `403 SUSPENDED`, and its audit row is kept. An "alert only" rule never refuses. Cost if wrong: one fewer contact for a scraper, and nothing for an honest person, who is paused either way.
- **R5. Business hours for access limits follow Settings.** `LoginHours` gains `business?: true`. When it's set, the check uses the business's working hours at that moment, so a later change to working hours carries over. Cost if wrong: none meaningful.
- **R6. You can't lock yourself out.** Saving access limits that would refuse the editor right now (one of their own roles, their current network or time, and not the owner) is refused with `WOULD_LOCK_YOU_OUT`. Cost if wrong: an admin has to ask the owner.
- **R7. A paused person still holds their seat.** The licence's user count includes `suspended`. Cost if wrong: a seat freed by a pause could be used to slip past the licence.
- **R8. 6A's Overview** is the status card, the alerts list and the alert drawer. The canvas's stat tiles, the 14-day small multiples and live sessions are 6C's Security activity. The "Offboard" choice in the drawer arrives with 6C's flow. Cost if wrong: the canvas's full Overview waits for 6C.
- **R9. The near-limit notice** comes with the response that reaches 80% of a pause rule's threshold, or goes past it: `{ nearLimit: true }` on a reveal, and `watch: { nearLimit: true }` beside `lead` on `GET /leads/:id`. It shows once per business hour per browser tab, and it's dismissible. Cost if wrong: one more notice in an hour.
- **R10. Restore is per person, not per alert.** Restoring someone resolves every open alert of theirs as `restored`. "Keep paused" resolves the alert under review as `kept_suspended`, and the person stays suspended. An alert-only alert offers "Dismiss" instead, which resolves it as `dismissed`. Cost if wrong: none meaningful.

## Global Constraints

- **Copy speaks as LUME:** "LUME paused Rory Reid's access", never "the system". No thresholds or counts are ever shown to the person being watched.
- **The paused message, exactly:** "Your access is paused" / "LUME noticed unusual activity on your account and let your admins know. They can restore your access."
- **The near-limit message, exactly:** "You've opened a lot of contacts this hour" / "LUME tells your admins when activity looks unusual."
- **Defaults** (spec §2.2), all on:
  - reveals: more than 30 in the last 60 minutes, then alert and suspend;
  - different leads opened: more than 200 in the last 60 minutes, then alert and suspend;
  - send-queue runs: more than 3 in the business's day, then alert.
- **Stepper steps:** 5, 25 and 1 (canvas). Minimums: 5, 25 and 1. Maximums: 500, 5000 and 50.
- **Colour:**
  - amber means an open alert, or "needs you";
  - red means suspended, or can't be undone;
  - green means all quiet, restored, or a rule that's on (switches are green when on, grey when off);
  - blue is the action;
  - no violet anywhere.
- **Dates:** month first, from `lib/dates.ts` ("Oct 1, Thu", "9:41 am"), on the business's clock.
- **Motion and accessibility:**
  - the alert HUD arrives once, from the bottom;
  - the burst chart's bars draw in, staggered;
  - Reduce Motion gets cross-fades;
  - every control works by keyboard, with a visible focus ring;
  - hover effects only where there's a pointer;
  - **no sound** (alerts aren't achievements).
- **The watermark** is CSS-only and `pointer-events: none`, sits under the text in contrast, and is `aria-hidden`.
- **Generic data only** in tests, seeds and screenshots (CLAUDE.md). Nothing leaves the server.
- **Process:**
  - tests run on the dev box (`scripts/dev.sh run`);
  - each task ends with its tests green, a commit, a push to main, and CI read;
  - the ledger is updated after every commit;
  - **don't run `dev.sh run|up` while the owner is recording** (app.lumecrm.in is served from the dev box; verification is submitted, so it's allowed again, but check with the owner if a Google reviewer is expected to visit).

## Review Focus

1. **The transaction on a pause.** A reveal that crosses the line with "pause" on leaves the user `suspended` and the sessions revoked, with an open alert and the crossing audit row, all committed, while the response holds no contact. (Task 3 test: after the 403, a fresh pool query sees all four.)
2. **A suspended person's live cookie.** The next request, on any route including SSE `/notifications/stream`, gets `403 SUSPENDED`, not a generic 401. A public route (sign-in page data) treats them as signed out. (Task 4 tests.)
3. **Honest people aren't paused by their own screen.** A drawer refetching the same lead 300 times counts 1 different lead. An owner or admin revealing 100 contacts is never counted. (Task 3 tests.)
4. **Restore actually lets them back in.** After Restore, signing in works, the actor cache is fresh (no 30-second stale `null`), and the next rule check doesn't immediately re-pause on the same old burst: a restore marks the window, and counts only acts after it. (Task 3/5 tests.)
5. **Access limits can't strand the editor.** Saving an IP list without the editor's own network, for a role the editor holds, is refused with a clear way out ("Add this network"). (Task 5 test, Task 7 UI test.)

---

### Task 1: The rules, the data and the suspended status

**Files:**
- new `packages/db/migrations/0042_security_watch.sql`
- `packages/db/src/schema/identity.ts` (`users.status`, `SecuritySettings`, `LoginHours`), new `packages/db/src/schema/security.ts` (+ index export)
- new `packages/core/src/security/rules.ts` (+test), exported from `@lume/core` and `@lume/core/shared`
- `apps/api/src/licence/keeper.ts` and every seat or active-user count found by `grep -rn "status = 'active'"` that means "a member" (R7)
- `apps/api/src/auth/sessions.ts` (`LiveSession.user.status` type)
- schema drift test fixtures

**Interfaces (produces):**
- `RuleId = "reveals" | "leadsOpened" | "queueRuns"`; `RuleAction = "off" | "alert" | "suspend"`
- `AnomalySettings = Record<RuleId, { action: RuleAction; threshold: number }>`
- `WatermarkMode = "masked_roles" | "everyone" | "off"`
- `SecuritySettings` gains `anomaly?: Partial<AnomalySettings>` and `watermark?: WatermarkMode`
- `RULES: Record<RuleId, { window: "hour" | "day"; step: number; min: number; max: number; default: { action, threshold }; audit: "lead.contact.reveal" | "lead.view" | "queue.started"; distinct: boolean }>`
- `mergeAnomaly(stored: unknown): AnomalySettings` (unknown or garbage keys fall back to defaults; a threshold is clamped to its min and max)
- `anomalySchema` (zod, for PUT)
- `isWatched(actor: Pick<Actor, "isOwner" | "perms">): boolean` (R2)
- `breached(observed, threshold): boolean` is `observed > threshold`; `nearLimit(observed, threshold): boolean` is `observed >= Math.ceil(threshold * 0.8)`
- `showsWatermark(mode: WatermarkMode | undefined, actor): boolean` (default `masked_roles`)
- DB: `security_alerts` (spec §2.4 columns plus `restored_after timestamptz`, see Review Focus 4); `users.status` CHECK adds `'suspended'`; `users.watch_from timestamptz` (acts before it aren't counted, set on restore); partial index `audit_log_watch ON audit_log (actor_user_id, action, at DESC) WHERE action IN ('lead.contact.reveal','lead.view','queue.started')`

- [ ] **Step 1: Write the failing tests** (`rules.test.ts`):
  - `mergeAnomaly({})` returns the three defaults;
  - `mergeAnomaly({ reveals: { action: "alert", threshold: 2 } })` clamps the threshold to 5 and keeps "alert";
  - `mergeAnomaly({ reveals: { action: "explode" } })` falls back to "suspend";
  - `isWatched`: the owner is false; `leads.contact.full: "all"` is false; `"team"` is true; no grant is true;
  - `breached(30, 30)` is false and `breached(31, 30)` is true;
  - `nearLimit(24, 30)` is true and `nearLimit(23, 30)` is false;
  - `showsWatermark(undefined, sales)` is true; `showsWatermark("masked_roles", admin)` is false; `showsWatermark("everyone", admin)` is true; `showsWatermark("off", sales)` is false.
- [ ] **Step 2: Run them, and see them fail** (module missing).
- [ ] **Step 3: Write the migration:**
  - `ALTER TABLE users DROP CONSTRAINT …status check, ADD CHECK (status IN ('invited','active','disabled','suspended'))` (find the generated constraint name in 0005 and drop it by name);
  - `ALTER TABLE users ADD COLUMN watch_from timestamptz`;
  - create `security_alerts`, with CHECKs on `rule`, `action`, `status` and `resolution`, `observed int`, `threshold int`, `window_start` and `window_end`, an FK to `users`, and indexes `(status, created_at DESC)` and `(user_id, rule, created_at DESC)`;
  - GRANT SELECT, INSERT, UPDATE to lume_app;
  - the partial audit index.
- [ ] **Step 4: Update Drizzle**, add `rules.ts`, export both, and make the R7 count changes.
- [ ] **Step 5: Run the core tests and the db drift and migrate tests until green**, then the whole suite on the dev box.
- [ ] **Step 6: Commit** `feat(security): the watch rules, suspended status and alerts table`, push, read CI, update the ledger.

### Task 2: Counting, alerts, suspend and restore (server core)

**Files:**
- new `apps/api/src/modules/security/{counts,alerts,suspend}.ts`, with `security.test.ts` (integration, real Postgres, as other module tests)
- `apps/api/src/modules/notifications/notify.ts` (kind `security_alert`)

**Interfaces (produces):**
- `countFor(db: Db | pg.PoolClient, userId: string, rule: RuleId, now: Date, tz: string): Promise<{ observed: number; windowStart: Date }>`
  - the hour rules: `windowStart = max(now - 60 min, users.watch_from)`;
  - the day rule: `windowStart = max(business-day start in tz, watch_from)`;
  - `distinct` rules count `DISTINCT entity_id`.
- `raiseAlert(db, a: { userId, rule, observed, threshold, action: "alerted" | "suspended", windowStart, now }): Promise<{ id: string; isNew: boolean }>` (R3)
- `suspendUser(db, userId, now): Promise<{ sessionsEnded: { id: string; device: string }[] }>`:
  - status becomes `suspended`;
  - sessions are revoked with reason `suspended`, and `sayRevoked` fires afterCommit;
  - `pg_notify('lume_rbac', userId)`;
  - audit `security.suspended` with the session devices in `diff`.
- `restoreUser(req, userId): Promise<void>`:
  - only from `suspended`, else `409 NOT_SUSPENDED`;
  - status becomes `active` and `watch_from = now`;
  - every open alert of theirs is resolved as `restored`;
  - rbac notify; audit `security.restored`.
- `tellAdmins(app, alert)`: afterCommit, `notify` every active holder of `security.manage` (the owner included) with kind `security_alert`, title "LUME paused {Name}'s access" or "{Name} opened a lot of contacts" (by rule and action, no numbers in the title: the body carries them, for admins), and `data: { alertId }`.

- [ ] **Step 1: Write the failing tests** (integration, seeded generic users "Rory Reid" Sales and "Maya Kapoor" owner):
  - 31 `lead.contact.reveal` audit rows in the last 59 minutes give observed 31; rows 61 minutes old aren't counted;
  - 300 `lead.view` rows for one lead give observed 1, and for 201 leads give 201;
  - `queue.started` counts from the business-day start in `Asia/Dubai`, not UTC midnight: a run at 23:30 UTC the previous day, which is 03:30 Dubai, counts today;
  - `watch_from` 10 minutes ago excludes older rows;
  - `raiseAlert` twice within 60 minutes for the same rule updates one row (observed is the max) and returns `isNew` false; 61 minutes after `window_end`, a new row;
  - `suspendUser`: status `suspended`, every live session revoked with reason `suspended`, the audit row lists their devices;
  - `restoreUser` on an active user gives 409; on a suspended one gives active, `watch_from` set, open alerts `restored`;
  - `tellAdmins` notifies the owner and a `security.manage` admin, never the Sales person, and the title has no digits.
- [ ] **Step 2: Run them, and see them fail.**
- [ ] **Step 3: Implement** `counts.ts`, `alerts.ts` and `suspend.ts`. Business-day start: reuse the tz helpers in `packages/core/src/tasks/time.ts` (the `local()` wall clock), and add `startOfBusinessDay(now, tz)` there with its own test if none exists.
- [ ] **Step 4: Run until green**, then the full suite.
- [ ] **Step 5: Commit** `feat(security): count, alert, suspend and restore`, push, read CI, update the ledger.

### Task 3: The inline check on reveal, open and queue start (and the near-limit notice)

**Files:**
- new `apps/api/src/modules/security/watch.ts`
- `apps/api/src/modules/leads/{reveal,service,routes}.ts`
- `apps/api/src/modules/queues/service.ts` (after `queue.started`)
- tests in `security.test.ts` and `leads.test.ts`

**Interfaces:**
- **Consumes:** Task 1 and Task 2.
- **Produces:** `watchAct(req, rule: RuleId): Promise<{ outcome: "ok" | "suspended"; nearLimit: boolean }>`:
  - it reads settings (`security`, `timezone`) through the existing settings loader;
  - it returns `ok` at once for an actor who isn't watched, or whose rule is `off`;
  - otherwise it counts, raises an alert on a breach, and suspends when the action is `suspend`;
  - `nearLimit` applies only to `suspend` rules (R9).

- [ ] **Step 1: Write the failing tests** (through the HTTP app, as `leads.test.ts` does):
  - **Review Focus 1:** a Sales user's 31st reveal within an hour, with `reveals.action = suspend`:
    - it gets `403 { error: { code: "SUSPENDED" } }` with no phone in the body;
    - afterwards a separate pool query sees status `suspended`, 0 live sessions, 1 open alert (observed 31, action `suspended`), and 31 `lead.contact.reveal` audit rows;
    - the owner and the security admin each have a `security_alert` notification.
  - With `reveals.action = alert`: the 31st reveal returns the contact; the user is still active; there is 1 open alert with action `alerted`.
  - The 24th reveal returns `nearLimit: true`; the 23rd returns `nearLimit: false`.
  - 201 different lead opens give the same pause on the 201st (`403 SUSPENDED`, no lead in the body).
  - **Review Focus 3:** 300 opens of one lead never pause. The owner, and an Admin with full contacts, revealing 100 times are never counted (no alert).
  - The 4th `queue.started` in a business day raises an `alerted` alert and the run still starts.
  - **Review Focus 4:** a restored user's next reveal (one more after the restore) doesn't re-pause.
  - A rule switched `off` never alerts.
- [ ] **Step 2: Run them, and see them fail.**
- [ ] **Step 3: Implement:**
  - **Reveal:** `revealContact` calls `watchAct(req, "reveals")` after its audit. On `suspended` it returns the marker `{ suspended: true }`. The route then sends `reply.code(403).send({ error: { code: "SUSPENDED", message: PAUSED_MESSAGE } })`: sent, not thrown, so the transaction commits (R4). Otherwise it returns the contact plus `nearLimit`.
  - **Open:** `getLead` does the same with `"leadsOpened"`, and returns `{ lead, watch?: { nearLimit: true } }` (R9).
  - **Queue start:** `watchAct(req, "queueRuns")` after `queue.started`. That rule's maximum action is alert (`RULES.queueRuns` allows only `off | alert`, enforced in `anomalySchema`).
  - `PAUSED_MESSAGE` lives in `@lume/core/shared` (`security/copy.ts`) for the API and the web to share.
- [ ] **Step 4: Run until green**, then the full suite. The existing leads, queue and e2e tests must stay green: they run as people under the thresholds.
- [ ] **Step 5: Commit** `feat(security): stop a burst at the act that crosses the line`, push, read CI, update the ledger.

### Task 4: Suspended at sign-in and on every request

**Files:**
- `apps/api/src/auth/{sessions,plugin}.ts`, `apps/api/src/modules/auth/service.ts`
- `apps/api/src/modules/users/service.ts` (disabling a suspended person works, and resolves their open alerts as `offboarded` when disabled from People; enabling sets active)
- tests `login.test.ts`, `server.test.ts` or plugin tests, `users.test.ts`

**Interfaces (produces):**
- `readSession` returns `LiveSession | { suspended: true } | null`. It returns `{ suspended: true }` when the user's status is `suspended`, whether or not that session was already revoked with reason `suspended`, as long as it isn't expired.
- The plugin, on a non-public route, throws `forbidden("SUSPENDED", PAUSED_MESSAGE)`. A public route treats it as no session.
- Login with a correct password and a suspended user returns `403 { error: { code: "SUSPENDED", message } }`. It creates no session and clears the throttle, like a success does. A wrong password for a suspended user still gives `INVALID_CREDENTIALS` and records a failure (no account probing).

- [ ] **Step 1: Write the failing tests:**
  - **Review Focus 2:** after a suspension, the old cookie gets `403 SUSPENDED` on `GET /api/v1/auth/me`, on a mutation, and on the SSE stream route;
  - `GET /api/v1/setup/status` (public) with that cookie answers as signed out;
  - login with the right password gives 403 SUSPENDED and no `Set-Cookie`; the wrong password gives 401 INVALID_CREDENTIALS;
  - a disabled user's cookie still gives a plain 401 (unchanged);
  - disabling a suspended person gives `disabled`, and their open alerts become `offboarded`;
  - restoring, then signing in, works within the same second (actor cache invalidated: Review Focus 4).
- [ ] **Step 2: Run them, and see them fail.**
- [ ] **Step 3: Implement.** Grep every `readSession` caller (`grep -rn "readSession(" apps/api/src`) and handle the new result in each. Keep the `user_disabled` revoke path for `disabled` only.
- [ ] **Step 4: Run until green**, then the full suite.
- [ ] **Step 5: Commit** `feat(security): a paused person can't sign in, and is told why`, push, read CI, update the ledger.

### Task 5: The Security API: settings, alerts, access limits, the sweep, the digest

**Files:**
- new `apps/api/src/modules/security/{routes,service,sweep}.ts`, registered in `app.ts` beside the other modules
- `apps/api/src/modules/tasks/queue.ts` (the sweep every 5th minute, beside the others)
- `apps/api/src/modules/tasks/digest.ts` (one line for `security.manage` holders)
- `apps/api/src/auth/restrictions.ts` (R5)
- `apps/api/src/modules/settings/service.ts` (`AuthSettings` gains `workingHours`)
- `apps/api/src/modules/auth/routes.ts` (`/auth/me` gains `watermark: boolean`)
- tests

**Routes** (all `security.manage`, except as noted):

| Route | What |
|---|---|
| `GET /api/v1/security/settings` | `{ anomaly: AnomalySettings, watermark: WatermarkMode }` |
| `PUT /api/v1/security/settings` | the same shape. It validates with `anomalySchema` (queue rule: `off | alert` only), merges into `settings.security` (session keys kept), and is audited as `security.settings_changed` with the diff |
| `GET /api/v1/security/alerts?status=open\|recent` | open alerts, or the last 30 days. Each has `id, user {id,name,initials}, rule, action, observed, threshold, windowStart, windowEnd, status, resolution, createdAt`, newest first |
| `GET /api/v1/security/alerts/:id` | the alert, plus: `burst` (per-minute counts from `windowStart − 10 min` to `windowEnd`, as `{ at, n }[]`, with distinct counting for opens); `timeline` (what LUME did, from audit rows `security.alert`, `security.suspended` and `security.notified` in order, each `{ at, words }`, with session devices and admin names in words); `person` (`roles: string[]`, `joined`, `leadCount`, `usualPerDay`: the mean daily count of this rule's act over the previous 30 days, excluding today, one decimal); `last30` (daily counts) |
| `POST /api/v1/security/alerts/:id/resolve` | `{ resolution: "restored" \| "kept_suspended" \| "dismissed" }`. `restored` calls `restoreUser` (R10); `kept_suspended` needs the person suspended; `dismissed` only for an `alerted` alert. A resolved alert gives `409 ALREADY_RESOLVED` with who and when |
| `GET /api/v1/security/access` | `{ roles: [{ id, name, people, loginHours, ipAllowlist }], workingHours, timezone, yourIp }`. The system owner role is excluded: "the owner is never limited" |
| `PUT /api/v1/security/access/:roleId` | `{ loginHours: LoginHours \| null, ipAllowlist: string[] \| null }`. A bare IP is normalised to `/32` or `/128`; at most 50 entries. R6 is checked with `checkLoginRestrictions` against the editor's own roles after the change. Audited as `security.access_changed`, with rbac notify |

- **The sweep:** `securitySweep({ pool, app })`:
  - every 5th minute, beside the follow-up clock (`busy.security`);
  - for each rule not `off`, one grouped query over the audit index (`GROUP BY actor_user_id HAVING count > threshold`, per user's `watch_from`), filtered to active, watched users (R2, through `loadActor`);
  - it calls the same `raiseAlert` and `suspendUser`, and `tellAdmins` only for a new alert;
  - it runs as lume_app on the job pool, in one transaction per breach.
- **The digest:** for a `security.manage` holder, a line "1 security alert needs you" or "{n} security alerts need you", with a link to `/settings/security`, when there are open alerts. Nothing when quiet.
- **`/auth/me`:** `watermark: showsWatermark(settings.security.watermark, actor)` and `today` (the business date, `YYYY-MM-DD`).

- [ ] **Step 1: Write the failing tests:**
  - a PUT then GET round-trips; a PUT with `queueRuns.action = "suspend"` gives 400; a Sales user gives 403; the session keys survive a PUT;
  - the alerts list and detail: burst minutes sum to the observed count; `usualPerDay` excludes today; the timeline reads "Ended Rory's 2 sessions (Chrome on Windows, iPhone)"-style words from the device helper in `lib/settings/device.ts`'s server twin, or a new shared one in core if none exists server-side;
  - resolve: restored, kept, dismissed, and 409 on a second resolve;
  - access: GET excludes the owner role; a PUT with `86.98.40.12` stores `86.98.40.12/32`; **Review Focus 5:** an admin holding the role, saving a list without their IP, gets 409 WOULD_LOCK_YOU_OUT and nothing is saved; with their IP, 200;
  - R5: a `business: true` role is refused at 20:00 on a working day whose hours end at 19:00, and allowed at 10:00;
  - sweep: 31 reveals inserted directly (no inline check) give one alert and a suspension on the first sweep, and no new alert on the second;
  - the digest line appears only for admins with open alerts;
  - `/auth/me` watermark: true for Sales and false for Admin under `masked_roles`.
- [ ] **Step 2: Run them, and see them fail.**
- [ ] **Step 3: Implement**, and add `security_alert` to the notification centre's server copy if any.
- [ ] **Step 4: Run until green**, then the full suite.
- [ ] **Step 5: Commit** `feat(security): the Security API, the 5-minute sweep and the digest line`, push, read CI, update the ledger.

### Task 6: Settings → Security: the frame and the Rules tab [Rules]

**Files:**
- `apps/web/src/lib/settings/areas.ts` (area `security`: "Security", "Alerts, rules and who can sign in when", `/settings/security`, `security.manage`, group `people`)
- new `apps/web/src/lib/settings/security.ts` (the client: types and calls)
- new `apps/web/src/components/settings/security/{SecurityTabs,RulesTab,RuleRow,WatermarkChoice}.tsx` and `security.module.css`
- new pages `app/(app)/settings/security/{page,rules/page}.tsx`. Until Task 8 builds the Overview, `/settings/security` redirects to `/rules`, and the tab strip lists only the tabs that exist (Access joins in Task 7, Overview in Task 8). Every task is pushed: nothing half-built is ever shown
- tests

**Design (canvas [Rules], apple-design):**
- **The frame:**
  - the Settings frame titled "Security", with the lede "LUME watches for anyone taking more lead data than their work needs, and tells you.";
  - a tab strip (Overview, Rules, Access limits) as links with `aria-current`, an underline that glides between tabs (`layoutId`, spring `SPRINGS.snappy`), and a cross-fade under Reduce Motion.
- **Rules:**
  - the heading "Tell me when someone…", with the sub "Applies to everyone who can't see every contact. Never to you. Counted over the last 60 minutes, so a burst across the hour still counts.";
  - **each rule is a row:** a green switch; its sentence ("More than 30 contacts opened in an hour", "More than 200 different leads opened in an hour", "More than 3 WhatsApp send-queue runs in a day"); a summary ("Off", "LUME tells you", or "LUME tells you, ends their sessions and pauses sign-in"); and "Edit", which becomes "Done";
  - **an open row expands** with a height spring. It holds a stepper (− value +, with that rule's step and min/max; the value ticks with the Odometer, buttons disabled at the limits, and keyboard ArrowUp/ArrowDown on the value) and "Then LUME": two option cards, "Tells you" ("An alert for you and other admins. Nothing changes for them.") and "Tells you and pauses their access" ("Their sessions end and they can't sign in until an admin restores them."). The queue rule shows only the first;
  - **saving:** each change saves at once (optimistic, a PUT of the whole settings object). On failure it reverts with an error toast. While saving, a small "Saved" tick fades in beside the row title, with no sound.
- **On-screen watermark:**
  - "A faint name and email across lead screens. It can't stop a screenshot, but it shows whose it was.";
  - three option cards ("People who can't see every contact": Recommended. Sales see it; admins don't. / "Everyone": Admins too. / "Nobody": No watermark on lead screens.);
  - a live preview tile: a mini lead row with the real overlay component from Task 8 (built here as `components/security/Watermark.tsx`, Task 8 then mounts it on lead screens) showing the viewer's own name and email and today's date, cross-fading out for "Nobody".
- **Phone:** the rows stack, the stepper stays at 44 px targets, and the tabs scroll horizontally.

- [ ] **Step 1: Write the failing tests** (Testing Library):
  - the area appears for `security.manage` and not for Sales;
  - the tabs mark the current route;
  - flipping a switch sends a PUT with `action: "off"` and the summary says "Off";
  - the stepper doesn't go below 5 for reveals, and + adds 5;
  - the queue rule offers no "pauses their access";
  - a failed PUT reverts the switch and shows the error;
  - choosing "Nobody" hides the preview mark;
  - every control is reachable by Tab, with a name.
- [ ] **Step 2: Run them, and see them fail.**
- [ ] **Step 3: Implement**, then check it in both themes in the browser (Porcelain and Obsidian).
- [ ] **Step 4: Run until green.** Commit `feat(security): Settings → Security and its Rules`, push, read CI, update the ledger.

### Task 7: Access limits [Access]

**Files:** new `components/settings/security/{AccessTab,RolePicker,HoursChoice,NetworkList}.tsx`; `app/(app)/settings/security/access/page.tsx`; tests

**Design (canvas [Access]):**
- **The role list on the left:** each role with "1 person" or "3 people", and the note "The owner is never limited." On a phone it's a select.
- **"When can {Role} sign in?"** offers three cards:
  - "Any time" (No limit);
  - "Business hours" (the business's actual working hours in words, e.g. "Mon – Sat, 9 am – 7 pm", from `/security/access` `workingHours`);
  - "Custom" (Pick the days and hours), which reveals with a height spring: seven day chips (toggle, `aria-pressed`, each showing its hours or "Off") and From/To time selects in 30-minute steps, with "business time ({tz city})".
  - Under them: "Outside these hours they can't sign in, and anyone still signed in is signed out."
- **"Where can {Role} sign in from?"** offers "Anywhere" (Office, home, phone) or "Only these networks" (Such as your office Wi-Fi), which reveals:
  - the list rows (a label field, the CIDR in mono, "Remove");
  - an add row (label + address, validated live: a single IPv4/IPv6 or CIDR);
  - "You're on {yourIp} right now." with "Add this network", which adds `{yourIp}` as "Where you are now". It's disabled once added.
- **Saving:** a sticky footer "Save changes" appears only when the form differs from the server (a spring rise), with "Discard". A 409 WOULD_LOCK_YOU_OUT shows inline, in amber: "Saving this would sign you out: you're on {ip}. Add this network first.", with the add button focused.

- [ ] **Step 1: Write the failing tests:**
  - picking "Business hours" saves `{ business: true, … }`;
  - custom days and times save `{ days, from, to }`;
  - an invalid address shows "That isn't a network address" and blocks Save;
  - a bare IP saves as given and is shown back as `/32` from the server;
  - "Add this network" adds and disables itself;
  - **Review Focus 5:** a 409 shows the amber message and focuses Add;
  - Discard restores;
  - switching role with unsaved changes asks "Discard changes to {Role}?" (an inline confirm, not `window.confirm`).
- [ ] **Step 2: Run them, and see them fail.** **Step 3: Implement**, in both themes. **Step 4: Run until green.** Commit `feat(security): access limits per role`, push, read CI, update the ledger.

### Task 8: The Overview, the alert drawer, the HUD, and the rep's side [Main], [RepView]

**Files:**
- **Admins:** new `components/settings/security/{OverviewTab,StatusCard,AlertList,AlertDrawer,BurstChart}.tsx`; `components/notifications/NotificationCentre.tsx` (`security_alert` item: amber shield icon, "Review" opens `/settings/security?alert=<id>`); new `components/security/AlertHud.tsx` mounted in `AppShell` for `security.manage` (it listens on the existing notification stream); `components/settings/PeopleAdmin.tsx` (a red "Paused" chip and a "Restore access" action)
- **The rep:**
  - `components/security/Watermark.tsx`, mounted in `LeadsScreen`, `LeadDrawer` and `BoardScreen` when `me.watermark`;
  - `components/leads/drawer/ContactBox.tsx` (the near-limit notice; SUSPENDED handling);
  - `lib/api.ts` (any `SUSPENDED` sends the browser to `/sign-in?paused=1`, once);
  - `components/auth/{SignInForm,SignInScreen}.tsx` and `lib/auth-client.ts` (the `suspended` result and the paused card);
- tests; e2e `apps/web/e2e/security.spec.ts`; baselines for the new screens only.

**Design:**
- **Status card [Main]:**
  - amber "1 alert needs you" with "LUME paused Rory Reid's access at 9:41 am." and "Review" (blue);
  - or green "All quiet" with "LUME is watching. Nothing unusual in the last 30 days." (or the last restore's words);
  - the change cross-fades, and the icon morphs from a shield with "!" to a shield with a tick.
- **The alerts list:** open alerts first, then "Earlier" (the last 30 days, resolved, each with its outcome in words: "Restored by Maya Kapoor · Oct 1, Thu"). Each row: avatar, the sentence ("Rory Reid opened 34 contacts in 52 minutes"), role, a "Paused" or "Told you" chip, "Review".
- **The alert drawer [Main]** slides from the right on a spring, with the scrim fading. It's a `Dialog` with a focus trap, Esc closes, and focus returns to the row. Contents:
  - a header with the person, role, "joined in March" and "214 leads";
  - the sentence, with the count in bold and "Your limit is 30 an hour; Rory usually opens about 4 a day.";
  - the burst chart: bars per minute, the bars over the threshold in amber, a dashed "Limit reached" marker at the crossing minute, x labels at four ticks; the bars draw in staggered (`--j` delay), and under Reduce Motion they appear at once;
  - "What LUME did": the timeline rows with times;
  - the choices: Restore access ("It was work. {Name} can sign in again."), Keep {Name} paused ("Look into it first. Their leads stay theirs."), and for alert-only alerts "Dismiss";
  - on a choice, the cards fold into one result line ("{Name} has access again", green, with the approved check pop; or "{Name} stays paused"); the drawer closes after 1.3 s; the status card updates;
  - "Open {Name}'s audit log" links to `/settings/audit?actor=<id>` (check the Audit log's existing filter param and use it).
- **The HUD:** when a `security_alert` notification arrives live, a dark capsule rises once from the bottom centre: shield, "LUME paused Rory Reid's access", the body line, then "Review" and ×. It stays 7 s, pauses on hover or focus, and is announced once via `role="status"`. It's not shown on a phone (the badge is enough) and never shown twice for one alert id (sessionStorage).
- **The watermark [RepView]:**
  - a fixed layer over the lead area only (not the sidebar);
  - a rotated (−24°) repeating grid of "{Name} · {email} · {Oct 1}" in 12 px;
  - opacity .06 in Porcelain and .07 in Obsidian, `color: var(--text)`, `mix-blend-mode: normal`;
  - `user-select: none`, `pointer-events: none`, `aria-hidden`, and printed too (`@media print` keeps it);
  - made with a CSS `background-image` of an inline SVG data URL generated in JS from the text (no DOM per tile).
- **The near-limit notice [RepView]:** a quiet inline card above the contact rows in the drawer, with an info icon (not amber), the two lines, and ×. It shows once per business hour (key `lume.watch.notice.<YYYY-MM-DD-HH>` in sessionStorage).
- **The paused card [RepView]:** `/sign-in?paused=1`, or a sign-in answering SUSPENDED, swaps the form for a calm card: a lock-pause glyph, "Your access is paused", the message, and "Back to sign in" (which clears the flag). No numbers, no shake.

- [ ] **Step 1: Write the failing tests** (Testing Library):
  - the status card is amber with one open alert and green with none;
  - the drawer renders the burst and the timeline; Restore posts `restored`, folds into "Rory has access again" and refetches; Keep posts `kept_suspended`; Esc closes and focus returns;
  - the burst chart marks the crossing bar;
  - the HUD shows once per id and not again after a reload (sessionStorage);
  - People shows "Paused" and Restore calls the resolve route through the person's open alert, or `POST /api/v1/security/people/:id/restore` (add that route in this task, `security.manage`, calling `restoreUser`, if People has no alert id at hand);
  - the watermark renders for `me.watermark` and not otherwise, and contains the name, email and date;
  - ContactBox shows the notice on `nearLimit` once per hour key, and a SUSPENDED reveal sends to `/sign-in?paused=1`;
  - SignInForm shows the paused card on `suspended`;
  - the e2e (`security.spec.ts`), against the real API, with the thresholds set low through the API for speed (reveals = 5):
    - a Sales user reveals 6 contacts; the 6th lands on the paused card;
    - signing in as them shows the paused card;
    - the owner sees the HUD and the amber status card, opens the drawer, and restores;
    - the Sales user signs in again;
    - a review copy of each screen (`reviewCopy`), both themes.
- [ ] **Step 2: Run them, and see them fail.** **Step 3: Implement.** Check each screen in both themes and at phone width in the browser, applying apple-design (hierarchy, springs, materials, reduced motion).
- [ ] **Step 4: Run** the unit suite, the e2e suite and the visual baselines (review every new baseline before accepting it; restore untouched aria YAML).
- [ ] **Step 5: Commit** `feat(security): alerts for admins, and the rep's side`, push, read CI, update the ledger.

### Task 9: Audit words, docs, acceptance, review

**Files:** `apps/web/src/lib/settings/audit.ts` (words for `security.suspended`, `security.restored`, `security.alert`, `security.notified`, `security.settings_changed`, `security.access_changed`, and the alert resolutions); `docs/runbooks/acceptance.md` (a 6A section); new `docs/runbooks/security.md` (admin docs: what is counted, what a pause does, what the watermark can't do, "screenshots can't be prevented, only traced"); `CHANGELOG.md`

- [ ] **Step 1:** Write the audit-words tests first (every new action has words, the existing "every action has words" test passes), then add the words.
- [ ] **Step 2:** Write the docs and the acceptance section with the spec §6 test, step by step (31 reveals, with pause on and with alert only; 201 opens).
- [ ] **Step 3:** Live acceptance on the dev box: reset the dev DB only with the owner's go-ahead (app.lumecrm.in is the owner's verification instance and now holds their account), else run against a second, throwaway compose project.
- [ ] **Step 4:** One fresh reviewer (the most capable model) over the whole 6A diff, then one fix pass. Commit, push, read CI, close the ledger with "Final review", and write the summary with every ruling for the owner.
