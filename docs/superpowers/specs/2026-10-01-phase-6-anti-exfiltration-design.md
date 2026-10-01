# Phase 6 — Anti-exfiltration: design

**Status:** draft for the owner's review. Written 2026-10-01 under the overnight authority. Every decision taken on the
owner's behalf is marked **Decided:**, with what it costs if wrong.

**Sources:** `docs/LUME_PROJECT_REPORT.md` §12.1 (sessions, per-role restrictions), §12.2 (contact-data protection),
§13 (Security analytics module) and §17 Phase 6.

**Goal (§17):** simulated scraping by a sales user (rapid reveals or views) raises an alert. With auto-suspend on,
it also ends their session.

LUME exists because a sales team member leaked a client's lead list (§1). Every layer here makes stealing the list
cost more, and makes a leak traceable to a person. LUME is licensed to many businesses, so every threshold, switch
and default lives in admin settings. Nothing is tuned for one client.

## 0. What already exists

- **Masking** (§12.2 #2). Without `leads.contact.full`, phone, email and Instagram are masked in every response.
  The server builds the WhatsApp link. The leads table leaves out contact columns for masked roles.
- **Metered reveal** (§12.2 #3). `POST /leads/:id/contact/reveal` is audited, writes a `contact_revealed`
  activity and counts in `reveal_counters (user_id, hour)`.
- **Per-role restrictions.** `roles.login_hours` and `roles.ip_allowlist` are enforced at login and on each
  request (`apps/api/src/rbac/actor.ts`). There is no screen for them yet.
- **Disabling a person.** It ends their sessions at once and can hand every lead they own to one colleague
  (`reassign_all_leads`). It is audited.
- **Sessions.** Each person can see and revoke their own (My account). An admin can sign someone out
  everywhere (People).
- **Other foundations:**
  - an append-only `audit_log` and the Audit log screen;
  - the permissions `leads.export`, `security.manage` and `audit.view`;
  - `settings.security jsonb`, which is empty today.
- **The whole-instance export** (licensing: an owner's offboarding archive). It is unrelated to lead exports and
  stays as it is.

## 1. Split

There are three plans. Each one ships on its own.

| Plan | What | Depends on |
|---|---|---|
| **6A Watch** | View counting; the anomaly rules and the 5-minute worker; alerts; suspend and restore; Settings → Security (rules, access limits per role, on-screen watermark); the watermark overlay; the rep's side (a near-limit notice, a suspended sign-in) | — |
| **6B Exports** | Watermarked lead exports (CSV or Excel) for `leads.export`: a unique code column, a canary row, 24-hour expiry, audited downloads; the Exports list; Trace a file | — |
| **6C Offboarding and activity** | The offboarding flow when disabling someone (sessions → leads → calendar → summary); the Security activity view (§13's Security module) | 6A's counters and alerts, 6B's exports |

## 2. 6A — Watch

### 2.1 What is counted

- **Reveals.** `reveal_counters` already counts these.
- **Lead views.** A new `view_counters (user_id, hour, count)` counts a view whenever someone opens one lead (the
  drawer or the page: `GET /leads/:id`). It is written the same way as reveals: one upsert per open.
  - **Decided:** list pages don't count, only opening a lead. A list shows at most 100 rows and never contact
    details for masked roles, so opening leads one by one is the scraping path. Cost if wrong: a scraper who
    only pages through lists isn't caught by this rule, but lists hold no contacts for masked roles anyway.
- **Send-queue runs** come from the existing `send_queue` runs, per person per day.
- **Sign-ins** come from `sessions` (ip, created_at).

### 2.2 The rules

These are kept in `settings.security.anomaly`. They are all on by default with the report's thresholds. An admin
with `security.manage` can change them.

| Rule | Default | Window |
|---|---|---|
| Contact reveals | more than 30 | an hour |
| Leads opened | more than 200 | an hour |
| Send-queue runs | more than 3 | a day |
| Sign-in from a new network | any | — |
| Activity outside the role's login hours | any | — |

- **What each rule does:** each rule is **off**, **alert**, or **alert and suspend**. Defaults: reveals and
  views are alert and suspend, the rest are alert only.
  - **Decided:** a human-judgement signal (a new network, odd hours) should not lock someone out on its own.
    Cost if wrong: one setting to change.
- **"A new network"** is the sign-in IP's /16 (IPv4) or /48 (IPv6) when that person hasn't used it in the last
  90 days. A person's first sign-in never counts.
  - **Decided:** network ranges, not countries. A country needs a GeoIP database with its own licence, and an
    instance must keep lead data on its server. Cost if wrong: a VPN user trips it more often. The rule is
    alert-only by default.
- **Who it applies to:** people without `leads.contact.full`, and never the owner.
  - **Decided:** admins who already see every contact gain nothing by scraping it. Cost if wrong: an admin
    behaving oddly isn't flagged, but the audit log still has them.

### 2.3 The worker

- A job runs every 5 minutes on the existing scheduler. For each rule it compares the window's count with the
  threshold.
- A breach opens **one alert** per person, rule and window. A second breach in the same window adds to that alert
  instead of opening another.
- **Faster than the worker.** The reveal and lead-open routes run the same check inline after their upsert, so a
  burst is stopped at the reveal that crosses the line, not up to 5 minutes later.
  - **Decided:** the report's acceptance test is "kills the session", and 5 minutes is 150 more reveals at
    scraping speed. Cost if wrong: one indexed count per reveal or lead open.

### 2.4 Alerts

- `security_alerts` records each alert:
  - `id`, `user_id`, `rule`, `observed`, `threshold`, `window_start`, `window_end`, `action`
    (`alerted | suspended`), `status` (`open | resolved`);
  - `resolution` (`restored | kept_suspended | offboarded | dismissed`), `resolved_by`, `resolved_at`,
    `created_at`.
- Everyone with `security.manage` is told:
  - an in-app notification of the existing kind, pushed over SSE, with a HUD toast;
  - a line in their digest.
- The alert opens a drawer showing:
  - the burst, per minute with the threshold line;
  - what LUME did and when;
  - the person's last 30 days at a glance;
  - three actions: **Restore access**, **Keep suspended**, **Offboard**. Offboard opens 6C's flow.

### 2.5 Suspend and restore

- **Suspended** is a new `users.status` value, next to `invited | active | disabled`.
  - Suspending ends every session (`revoked_reason = 'suspended'`) and blocks sign-in until an admin restores
    the person.
  - Their leads stay theirs.
  - **Decided:** ending sessions alone isn't enough, because they would sign straight back in and carry on.
    Cost if wrong: an honest person waits for an admin. The alert reaches admins at once, and the person sees
    why at sign-in.
- **What the suspended person sees** at sign-in: "Your access is paused. LUME noticed unusual activity on your
  account and let your admins know. They can restore it." No thresholds and no numbers.
- **Restore** sets `active`, resolves the alert as `restored`, and is audited.

### 2.6 The rep's side

- **No meter.**
  - **Decided:** showing "12 of 30" tells a scraper exactly how far to go. Cost if wrong: an honest heavy user
    is surprised by a pause.
  - At 80% of a suspend-rule threshold, LUME shows one calm, dismissible notice: "You've opened a lot of
    contacts this hour. LUME tells your admins when activity looks unusual."
- **On-screen watermark (§12.2 #7):**
  - a faint repeating overlay of the viewer's name and email, and the date, on lead screens (the list, the
    drawer and the board);
  - it is on by default for people without `leads.contact.full`, with a setting (`settings.security.watermark`:
    `masked_roles | everyone | off`);
  - it is CSS-only, `pointer-events: none`, and drawn behind the content's text contrast so it never hurts
    reading;
  - the admin docs say honestly that screenshots can't be prevented, only traced.

### 2.7 Settings → Security (`security.manage`)

The page has three parts:

- **Rules:** each rule has a green switch, a threshold stepper, and a choice of "Alert" or "Alert and suspend".
- **Access limits:** per role, login hours (from the business's working hours, or custom) and an IP allow-list.
  These edit `roles.login_hours` and `roles.ip_allowlist`, which already exist.
- **On-screen watermark:** a three-way choice with a live preview.

## 3. 6B — Exports

- **Who and from where:**
  - only `leads.export` holders (admins by default, and 2FA-mandatory as §12.1 already requires);
  - "Export" sits on the Leads list and exports **the current view**: its filters and its columns, never more
    than the person could see.
- **Making the file:**
  - CSV or Excel, generated by the worker into the instance's own storage, never sent anywhere else;
  - the `exports` row holds `user_id`, `filters`, `row_count`, `watermark_code`, `file_path`, `expires_at` and
    downloads.
- **The watermark has two parts:**
  - a last column, `LUME ref`, holding the export's code (8 characters, e.g. `LX7Q-4MRA`) on every row;
  - one **canary row**: a fictional lead whose name, email (`@example.invalid`) and phone (a number in a reserved
    test range) are derived from the code. It sits at a stable but code-derived position.
  - **Decided:** a column alone is deleted in seconds, while a canary row survives a column strip and a re-sort.
    Cost if wrong: one fake row in the file, documented in the admin docs.
- **Expiry and downloads:**
  - files expire 24 hours after they're made (the worker deletes the file and keeps the row);
  - every download is audited (`lead.export.download`), and so is making one (`lead.export`).
- **Trace a file** (`security.manage`):
  - drop a CSV or Excel file, or paste a code;
  - LUME looks for a `LUME ref` code, or for any canary row, and answers "This file came from <person>'s export
    on <date>, <time>: <n> rows, <filters in words>", or "No LUME export matches";
  - the file is read in memory on the server and never kept.
  - **Decided:** server-side, because the canaries must stay secret from the browser. Cost if wrong: none
    meaningful.

## 4. 6C — Offboarding and activity

- **Offboarding** replaces the Disable dialog with a guided flow. The steps run in order and each shows its result:
  1. **Sign out everywhere:** done at once.
  2. **Leads:** choose all to one person, spread evenly across a team, or unassigned, with a preview count.
     - **Decided:** "spread evenly" is new. It round-robins by current open-lead count. Cost if wrong: one more
       option.
  3. **Calendar:** revoke their Google Calendar connection (Phase 5). Their meetings go with their leads.
  4. **Their last 30 days:** reveals, leads opened, exports, alerts, and the busiest day, with "Open the audit
     log" filtered to them.
  - The flow is audited as one `user.offboarded` entry that lists each step's outcome.
- **Security activity** (§13's Security module, `audit.view`): a tab on Settings → Security showing:
  - contact reveals per person per day (14 days, small multiples);
  - exports;
  - failed sign-ins;
  - alerts;
  - live sessions.
  - Every number opens the Audit log filtered to it.
  - **Decided:** it lives here in Phase 6, not in Phase 7's Analytics, because §17 lists security analytics in
    Phase 6. Phase 7 links to it. Cost if wrong: a later move.

## 5. Colour, words and motion

- **Colour:**
  - amber means an open alert, or "needs you";
  - red means suspended, or can't be undone (Disconnect, Offboard);
  - green means all quiet, restored, or a rule that's on (the switch rule);
  - blue is the action.
  - No violet (the Phase 5 canvas’s System board).
- **Words.** Copy speaks as LUME. "LUME paused Rory's access", never "the system". No thresholds are shown to the
  person being watched.
- **Motion and sound:**
  - the alert HUD arrives once, from the bottom;
  - the burst chart draws in;
  - offboarding's steps tick in order with the approved check pop;
  - no sound, because alerts aren't achievements.

## 6. Acceptance

- **The report's test.** A sales user making 31 reveals within an hour, with auto-suspend on, gets an alert. Their
  sessions end, and their next request is refused with `SUSPENDED`. With auto-suspend off, they get an alert only.
- **Views.** 201 lead opens behave the same way.
- **Tracing.** A watermarked export traces back from the code column, and also from a file with that column
  deleted and its rows re-sorted (by the canary).
- **Expiry and audit.** An expired export can't be downloaded, and every download is in the audit log.
- **Offboarding.** It leaves the person `disabled`, with no live sessions, no leads (or the chosen spread), no
  calendar grant, and one audit entry.
