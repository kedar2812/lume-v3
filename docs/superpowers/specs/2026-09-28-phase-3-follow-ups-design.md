# Phase 3 — Follow-ups, reminders and notifications that never fail

Status: written 2026-09-28 under the owner's standing approval for the overnight run ("you decide, I review later"). Every decision below is the owner's to overturn.
Sources: the project report §10 (follow-ups, reminders, notifications) and §17 (Phase 3), and the frontend design spec §8.2 (Today), §8.4 (lead drawer) and §8.5 (notification centre).

## 1. What this is for

A lead goes cold when nobody calls back. Phase 3 makes the next step with every lead a thing LUME holds on to, and brings it back at the right moment:
- a **follow-up** is a task for a team member, on a lead, at a time;
- at that time (and at any reminders before it) the person gets a **notification**, in the app at once;
- **Today** is their list: what's overdue, what's due soon, what's later today;
- nothing is ever silently dropped: an overdue follow-up stays overdue until someone does it, moves it or cancels it.

**Success (report §17):** the reliability suite (§8) passes, including a crash mid-run that the sweeper recovers from.

**Not in Phase 3:**
- *Reminder messages* (a WhatsApp template for the lead) need templates, so they come with Phase 4. The data model below already has room for them (`type`, `template_id`).
- Meeting reminders need calendars (Phase 5).
- Today's KPI strip and "today's calls" need analytics (Phase 7) and calendars (Phase 5). Today shows what exists now.

## 2. How it's split

| Part | What | Why this order |
|---|---|---|
| **3A** | Follow-ups and the scheduling engine: tasks, reminder offsets, snooze, recurrence, the fire job and the sweeper, notifications, the live stream (SSE), the lead drawer's follow-ups, and Today | Everything else hangs off it |
| **3B** | The notification centre (panel, full screen, keyboard), the unread badge and title count, escalation, and the daily email digest | The surfaces that bring it to people who aren't looking at Today |
| **3C** | Stage automations (`on_enter`: create a follow-up, cancel open ones, notify), the no-touch alert, working-hours shifting, editable due-time presets, and System health | Rules on top of a proven engine |

Each part has its own plan, its own final review, and its own acceptance.

## 3. Decisions

| Question | Decision |
|---|---|
| Where the engine runs | In the **API process**, as `lume_app`, with pg-boss, like sheet syncs and webhooks (2A amendment 1). The API already holds the one `LISTEN` connection the stream needs. The worker keeps maintenance only. |
| Firing | When a follow-up is created or changed, the same transaction rewrites its `scheduled_notifications` (one per reminder) and, after commit, sends a pg-boss job with `startAfter = fire_at` and `singletonKey = the row's id`. The job locks the row (`FOR UPDATE SKIP LOCKED`); if it's still `pending` and the follow-up still open, it inserts the notification, `NOTIFY`s, and marks the row `fired`. Running it twice does nothing the second time. |
| The sweeper | Every 60 s (and at start-up), any `pending` row with `fire_at < now() - 30 s` is fired at once. A crash, deploy or lost job never loses a reminder while the database survives. |
| Accuracy | A reminder fires within 60 s of its time (report §10.4). |
| Times | Entered and shown in the **person's timezone** (`users.timezone`, else the business's), stored in UTC. "Today" and "tomorrow 10:00" mean the person's own day. |
| Reminders | Per follow-up: any of "at the time", and N minutes / hours / days before (the person picks the values). At most 5 per follow-up. |
| Due-time presets (3A fixed; 3C editable) | In 1 hour · In 3 hours · Tomorrow 10:00 · In 2 days · Next Monday · Pick a time. |
| Snooze | 15 min · 1 hour · This evening (18:00) · Tomorrow morning (09:00) · Pick a time. Snoozing moves the follow-up's due time and reschedules its reminders. |
| Done | Completing cancels its pending reminders. With recurrence, it makes the next one. The last follow-up of someone's day plays `cleared` (sound policy: achievements only). |
| Recurrence | `{ every: N, unit: "day" \| "week", until: date \| null, stopOn: ("won" \| "lost" \| "reply_logged")[] }`. On completion, the next follow-up is due `every × unit` after the one just done, moved forward past now if needed. The stop conditions are checked when the next is made, and none is made once one holds. "Nag" recurrences (firing again while still open) are not in v1. |
| Who sees what | A follow-up is visible to whoever can see its lead (the lead's row-level security) **and** to the person it's assigned to. Notifications are only ever the recipient's own. |
| Who may do what | Anyone who can see a lead may give **themselves** a follow-up on it. Giving one to someone else, or changing someone else's, needs `tasks.manage_others` over that person (scoped: own/team/all, as the catalog says). |
| Overdue | Never disappears. An open follow-up past due stays in Overdue on Today (and in the notification centre, 3B) until it is done, moved or cancelled. |
| The lead's "next follow-up" | `leads.next_task_due_at` is kept current by the same transaction as any follow-up change, so lists can sort and filter by it. |
| Lead removed | Its open follow-ups are cancelled and their reminders with them. |
| Person disabled | Their open follow-ups stay (an admin reassigns them, 3B escalation shows them). Nothing fires to a disabled person. |
| Live updates | `GET /api/v1/stream`, Server-Sent Events, authenticated by the session cookie. The API `LISTEN`s on `lume_notifications` and fans out to that person's open streams. On reconnect the browser sends `Last-Event-ID`, and missed notifications are re-sent from the database. A heartbeat every 25 s keeps proxies from closing it. |
| Sound | Incoming notifications are silent (sound policy). Only `done` (a follow-up done) and `cleared` (the last of the day) play. |

## 4. Data (migration `0021_follow_ups.sql`)

**`tasks`**:
- `id uuid`, `lead_id` (cascade), `assignee_id` (users), `type text` (`follow_up`; `whatsapp` arrives in Phase 4), `template_id uuid null`;
- `title text` (≤ 200), `note text null` (≤ 2,000);
- `due_at timestamptz`, `status` (`open | done | cancelled`), `remind_minutes int[]` (offsets before the due time; `0` = at the time);
- `recurrence jsonb null`, `series_id uuid` (the first follow-up's id, shared by its repeats);
- `created_by`, `created_at`, `updated_at`, `done_at`, `done_by`, `cancelled_at`, `auto_rule_id uuid null` (3C), `version int`.
- Indexes: `(assignee_id, status, due_at)`, `(lead_id, status, due_at)`.
- Row-level security: read when the lead is visible **or** `assignee_id = lume_user()`; write through the same rule, and the service checks `tasks.manage_others`.

**`scheduled_notifications`**:
- `id bigserial`, `task_id` (cascade), `offset_minutes int`, `fire_at timestamptz`, `status` (`pending | fired | cancelled`), `fired_at`;
- `UNIQUE (task_id, offset_minutes)`; a partial index on `(fire_at) WHERE status = 'pending'` for the sweeper.

**`notifications`**:
- `id bigserial`, `user_id`, `kind text` (`follow_up_due`, `follow_up_soon`, `follow_up_assigned`; 3B adds `escalation`, `sync_paused`, `new_lead`…), `task_id null`, `lead_id null`;
- `title text`, `body text null`, `data jsonb`, `created_at`, `read_at null`;
- Row-level security: `user_id = lume_user()` only. Retention: read notifications older than 90 days are deleted by the worker.

Titles and bodies carry a lead's **name** only, never a phone number or email (report §10.7's rule, applied everywhere a notification goes).

## 5. The engine

- `schedule(tx, task)`: deletes the task's `pending` rows, inserts one per offset whose `fire_at` is still ahead (or within the last 30 s), and returns the new ids for the after-commit enqueue. Called on create, edit, snooze and reassign.
- `cancelAll(tx, taskId)`: marks `pending` rows `cancelled`. Called on done, cancel, lead removed.
- `fire(id)`: the job described in §3. The notification it writes says "Follow up with Aisha Khan — now" (`follow_up_due`) or "…in 15 min" (`follow_up_soon`).
- `sweep()`: every 60 s; logs how many it fired, and when it last ran (System health, 3C, reads it).
- `recoverOnStart()`: runs the sweeper once before the API listens.

## 6. Screens (3A)

**Lead drawer:**
- "Next follow-up" under the actions: its time in words ("Tomorrow, 10:00"), who it's for, with a tick to mark it done, and a menu (Snooze, Edit, Cancel).
- **Follow-up** (button and `F`): a small sheet anchored to the button, with a title (it defaults to "Follow up"), the due-time presets as chips plus "Pick a time", reminders (chips: At the time, 15 min before, 1 hour before, 1 day before, Custom), "Repeat" (off by default), and "For" (only when the person may give follow-ups to others).
- Every follow-up event shows in the lead's history ("Follow-up set for tomorrow, 10:00", "Follow-up done").

**Today:**
- Hero: date, greeting and one line naming the most urgent person ("Aisha Khan has been waiting since yesterday"), with a progress ring, "3 / 7 cleared today".
- **Up next**, grouped **Overdue**, **Due soon** (next 2 hours) and **Later today**. Each row: lead name, the follow-up's title, the time in words, and inline Done and Snooze.
- Admins (with `leads.view` all) also see unassigned leads and sources that need attention.
- **All clear:** the LUME mark rotates in and `cleared` plays, once per day.

The notification centre is 3B. In 3A, the bell shows a live unread dot from the stream and opens Today.

## 7. API (3A)

| Route | Permission | Does |
|---|---|---|
| `GET /api/v1/leads/:id/tasks` | `leads.view` | Open and recent follow-ups on the lead |
| `POST /api/v1/leads/:id/tasks` | `leads.view` (+ `tasks.manage_others` for someone else) | Create |
| `PATCH /api/v1/tasks/:id` | as above | Title, note, due time, reminders, recurrence, assignee |
| `POST /api/v1/tasks/:id/done` | as above | Done (and the next, if it repeats) |
| `POST /api/v1/tasks/:id/snooze` `{ until }` | as above | Snooze |
| `POST /api/v1/tasks/:id/cancel` | as above | Cancel |
| `GET /api/v1/today` | `auth.self` | The caller's Overdue / Due soon / Later today, the day's progress, and (admins) what needs them |
| `GET /api/v1/notifications` | `auth.self` | The caller's recent notifications and unread count |
| `POST /api/v1/notifications/read` `{ ids } \| { all: true }` | `auth.self` | Mark read |
| `GET /api/v1/stream` | `auth.self` | Server-Sent Events |

Every write is audited for another person's follow-up only (a person's own follow-ups are their notebook, and the lead's history records them).

## 8. Testing (the reliability suite, report §10.4)

- **Fire-time accuracy:** a reminder set for T fires between T and T + 60 s (the job), and the sweeper catches one whose job was lost.
- **Idempotency:** firing the same row twice, or the job and the sweeper at once, writes one notification.
- **Crash recovery:** a fire job that dies after locking (the process killed mid-run, simulated by a transaction that never commits) leaves the row pending; the sweeper fires it once.
- **Timezones:** "Tomorrow 10:00" for a person in UTC+4, one in UTC+5:30 and one in a DST zone (Europe/London) across the change; "today" groups for each.
- **Races:** snooze and done at once; done twice; edit during a fire.
- **Recurrence:** the next is made on done, moved past now, and stops on won, lost, `until`, and a logged reply.
- **Visibility:** a rep sees follow-ups on their leads and ones assigned to them, and nobody else's; notifications only their own; `tasks.manage_others` scope own/team/all.
- **Stream:** a notification reaches only its recipient; `Last-Event-ID` replays what was missed.
- **End to end:** set a follow-up from the drawer, see it on Today, get the live dot when it's due, mark it done, and see All clear.

## 9. Out of scope, and later

- Reminder messages (Phase 4), meeting reminders (Phase 5), KPI strip and calls on Today (Phases 7 and 5).
- Nag recurrences.
- Browser push notifications (the page must be open; the email digest in 3B covers people who aren't in LUME).
