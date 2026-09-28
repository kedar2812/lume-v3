# Phase 3B — Notification centre, escalation and the daily digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every follow-up reaches the right person, even one who isn't looking at Today:
- a notification centre on the bell;
- the people who manage an assignee, when a follow-up is left overdue;
- a morning email of the day ahead.

**Architecture:**
- The centre is a glass slide-over anchored to the bell (frontend spec §8.5). It reads the 3A endpoints (`/today`, `/notifications`) and the live stream.
- Escalation and the digest are API-process jobs, like 3A's sweeper. Each is idempotent per follow-up (`escalated_at`) or per person and day (`digest_runs`).
- Notifications honour each person's alert preferences (`preferences.alerts`), which already exist.

**Tech Stack:** as 3A, plus the existing SMTP mailer (`apps/api/src/mail`).

**Spec:** `docs/superpowers/specs/2026-09-28-phase-3-follow-ups-design.md` (§2 3B) and the report §10.4.6, §10.6 and §10.7. Frontend spec §8.5.

## Global Constraints

- The 3A constraints hold: one accent blue; sound only on achievements; names only, never contacts; each person's own timezone; the gate, TDD, CI.
- **Emails carry lead first names and times only**, never phone numbers or emails. Every item links into LUME, where sign-in is required (report §10.7).
- Nothing is sent twice: each escalation once per follow-up, each digest once per person per local day.

## Review Focus

1. **A digest across midnight and DST:** a person in UTC+5:30 whose 08:00 falls in the same UTC hour as someone's 23:30 gets exactly one digest for their own date.
2. **Escalation reaches only the right managers:** a team lead with `tasks.manage_others: team` over the assignee, and holders of `all`. Never the assignee, never a rep, and nobody who can't see the lead.
3. **Preferences off means quiet:** with `alerts.dueFollowUps` off there are no due notifications (the follow-up is still on Today); with `emailDigest` off there's no email.
4. **The centre under load:** 200 notifications, arrivals while it's open, and J/K and E/S while a Snooze menu is open. The keyboard never acts on the wrong row.
5. **An SMTP failure** is retried on the next run and never marks the digest sent.

---

### Task 1: Data and settings

- Migration `0024_escalation_digest.sql`:
  - `tasks.escalated_at timestamptz`;
  - `digest_runs (user_id, local_date date, sent_at, items int, PRIMARY KEY (user_id, local_date))`, with no row-level security (it holds no names), revoked from the worker;
  - `settings.follow_ups jsonb NOT NULL DEFAULT '{"escalation":{"enabled":true,"hours":24}}'`.
- A settings API section, `GET/PUT /api/v1/settings/follow-ups` (`settings.manage`), with `{ escalation: { enabled, hours: 1..168 } }`. It is audited.
- Tests: DB constraints; the settings route (permissions, validation, audit); probes.
- Commit: `feat(db): escalation and the daily digest have somewhere to remember what they did`.

### Task 2: Notifications that respect people

- `notify(pool, userId, n)`: a helper that writes as the recipient (their own row-level-security scope) and `NOTIFY`s. It skips, and says why, when the recipient's preference turns that kind off:
  - `alerts.dueFollowUps` → `follow_up_due` and `follow_up_soon`;
  - `alerts.assigned` → `follow_up_assigned` and `lead_assigned`.
- 3A's `fire` uses it. The reminder is still marked fired, and the follow-up stays on Today.
- New notifications:
  - `follow_up_assigned`, when someone else gives you a follow-up (after commit);
  - `lead_assigned`, when a lead is assigned to you by someone else (the leads service's assign path and bulk assign).
- Tests:
  - each preference on and off;
  - a follow-up given to yourself notifies nobody;
  - a bulk assign of 50 leads is one notification ("50 leads were assigned to you"), not 50;
  - titles never contain contact details.
- Commit: `feat(api): notifications that ask first — each person's alert settings decide what reaches them`.

### Task 3: Escalation

- `escalate(pool, now)`, every 5 minutes in the task queue's tick:
  - It takes open follow-ups past `due_at + hours`, with `escalated_at IS NULL`, and escalation enabled.
  - For each, the managers are active users with `tasks.manage_others` at `all`, or at `team` with the assignee in one of their teams. Each must be able to see the lead (the 3A `assigneeCanSee` rule) and must not be the assignee.
  - It sends a `task_escalated` notification to each manager: "Riya's follow-up with Aisha Khan is 26 h overdue". It carries `taskId` and `assigneeId`.
  - It sets `escalated_at` in the same transaction. Snoozing or moving the follow-up clears `escalated_at`.
- Tests:
  - Review Focus 2 (team, all, a rep, a manager who can't see the lead, the assignee themselves);
  - once only;
  - snooze clears it and a new overdue window escalates again;
  - disabled means none.
- Commit: `feat(api): a follow-up left overdue reaches the people who manage it, once`.

### Task 4: The daily digest

- `digestDue(pool, now)`: active users with `alerts.emailDigest`, whose local weekday is in `workingDays`, whose local time is at or past `digestTime` (within the same local day), and who have no `digest_runs` row for their local date.
- `buildDigest(pool, user, now)`, as the user's own scope:
  - overdue follow-ups, and today's (lead **first name**, time in words);
  - leads assigned to them since their last digest (first names, count beyond 10);
  - for admins, unassigned new leads (a count) and sources needing attention (names).
- A `digestMail` template: plain text plus minimal HTML, from `settings.businessName`, with one "Open Today" link and per-item links to `/leads?lead=<id>`. An empty day sends nothing and still records the run.
- Sending, then the `digest_runs` insert, in that order. A send that fails leaves no row, so the next run (every 15 minutes) retries.
- Tests:
  - Review Focus 1 (Kolkata vs Dubai vs London in DST);
  - weekends skipped;
  - preferences off;
  - Review Focus 5 (the mailer throws, then succeeds next run: one mail);
  - no contact details in the mail body (assert against the seeded phone and email);
  - an admin's extra sections.
- Commit: `feat(api): a morning email of the day ahead — first names and times only, once a day, in your own morning`.

### Task 5: The notification centre (web)

- `NotificationCentre`: a glass slide-over anchored to the bell (`backdrop-filter`, the Obsidian treatment in frontend spec §8.5). There's no scrim, so the page stays usable.
  - Groups: **Overdue**, **Due now** and **Later today** (from `/today`), and **Updates** (from `/notifications` kinds other than `follow_up_*`). Sticky headers.
  - Filters: All, Needs you, Updates.
  - Unread: a blue dot. Hovering 600 ms marks an item read, and so does focusing it. "Mark all read".
  - Item anatomy: a type tile, the lead's initials, the title and time, one meta line with the urgency word coloured, and inline actions:
    - follow-up: Done and Snooze;
    - assignment: Open;
    - escalation: Open lead and "Remind them" (it sends the assignee a `follow_up_nudge` notification);
    - sync paused: Fix.
  - Arrivals slide in at the top of their group with a highlight fade. The bell swings (silent).
  - Full screen: the button, or **F**. It FLIP-grows into a centred reading column. Esc exits full screen, then closes.
  - Keyboard: **.** toggles; **J/K** move; **E** done; **S** snooze; **Enter** opens.
  - Empty: the LUME mark and "You're all caught up".
- The document title shows `(n) LUME` while n are unread.
- Today stops reading everything on open (3A's stopgap). The centre does the reading.
- Tests:
  - groups and filters;
  - hover-to-read timing (fake timers);
  - keyboard (Review Focus 4);
  - arrivals;
  - full screen and Esc;
  - the title count;
  - Remind them.
- Commit: `feat(web): the notification centre — everything that needs you, one key away`.

### Task 6: Settings (web)

- Settings → **Follow-ups**: an escalation switch, and "after N hours".
- Settings → **My account → Notifications**: the three alert switches and the digest time. The preferences already exist; this shows them outside onboarding.
- Tests, then commit: `feat(web): follow-up escalation and your own alerts, in Settings`.

### Task 7: End to end and acceptance

- e2e:
  - the centre (open with `.`, J/K/E, full screen, Mark all read);
  - a digest captured by the SMTP sink (`smtp-sink.mjs`), with no contact details in it;
  - an escalation reaching a team lead;
  - screenshots of the centre in both themes;
  - axe.
- The live script: the digest through Mailpit on the dev stack.
- Commit: `test(e2e): the notification centre, escalation and the digest, end to end`.

## Self-review

- **Coverage:** report §10.4.6 (escalation) is Task 3; §10.6 (the panel) is Task 5; §10.7 (the digest) is Task 4; spec §2 3B is Tasks 1–7.
- **Rulings:**
  - R1. Digests and escalations run in the API process, beside 3A's engine; the worker keeps retention only.
  - R2. A bulk assignment is one notification, not one per lead.
  - R3. With `alerts.dueFollowUps` off, reminders still fire (they're marked fired), but write nothing.
