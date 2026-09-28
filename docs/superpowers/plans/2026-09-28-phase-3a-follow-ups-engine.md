# Phase 3A — Follow-ups and the scheduling engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Follow-ups on leads that fire reminders on time, every time. They are shown live, and on Today.

**Architecture:**
- `tasks`, `scheduled_notifications` and `notifications` tables, with row-level security.
- A pure time library in `@lume/core`: presets, snooze, recurrence and reminder times, in the person's timezone.
- An engine in the API process: pg-boss `tasks.fire` jobs plus a 60-second sweeper, idempotent under `FOR UPDATE SKIP LOCKED`.
- The tasks API, a notifications API, a Server-Sent Events stream fed by one `LISTEN`, and a Today endpoint.
- On the web: the lead drawer's follow-ups, and the Today page with a live bell dot.

**Tech Stack:** Postgres 17 (RLS), Drizzle, pg-boss 10, Fastify 5 (raw SSE), Zod 4, Next.js 16 / React 19, motion 12, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-phase-3-follow-ups-design.md` (§2 3A, §3–§8).

## Global Constraints

- One accent blue `#2A5BFF` in both themes. No third-party marks. Copy speaks as "LUME".
- Sound only on achievements: `done` when a follow-up is done, `cleared` when the last of the day is done. Everything else is silent.
- Notification titles and bodies carry a lead's **name** only: never a phone number or email.
- Times are entered and shown in the person's timezone (`users.timezone`, else `settings.timezone`), and stored in UTC.
- Nothing about any one client is hardcoded. Demo data is fictional.
- Gate before every commit; TDD; push to main; watch CI.

## Review Focus

1. **A reminder whose job never runs** (a lost pg-boss job, or a restart between commit and send): the sweeper fires it within 90 s, once.
2. **Two fires at once** (the job and the sweeper, or two sweepers): one notification.
3. **DST:** "Tomorrow 10:00" set in Europe/London on the day before the clocks change is 10:00 local on the day after, not 09:00 or 11:00.
4. **A follow-up on a lead the assignee can't see:** refused at creation (`ASSIGNEE_CANT_SEE_LEAD`). If the lead later moves out of their sight, it fires nothing, and the notification never names the lead.
5. **The stream across a reconnect:** a notification written while the browser was away arrives once, after `Last-Event-ID`, never twice.

---

### Task 1: Data — tasks, scheduled notifications, notifications

**Files:**
- Create: `packages/db/migrations/0021_follow_ups.sql`, `packages/db/src/schema/tasks.ts`
- Modify: `packages/db/src/schema/index.ts`, `packages/core/src/queues.ts` (`tasks.fire`), `packages/core/src/queues.test.ts`, `apps/worker/src/maintenance.ts` (`purgeNotifications`), `apps/worker/src/boss.ts` (`notifications.retention` at 03:53 UTC), and its test
- Test: `packages/db/src/tasks.test.ts`, `apps/worker/src/maintenance.integration.test.ts`

**Interfaces:**
- Produces:
  - the tables `tasks`, `scheduled_notifications` and `notifications`;
  - the Drizzle tables `tasks`, `scheduledNotifications` and `notifications`;
  - the types `TaskStatus = "open" | "done" | "cancelled"`, `Recurrence = { every: number; unit: "day" | "week"; until: string | null; stopOn: ("won" | "lost" | "reply_logged")[] }` and `NotificationKind`.

- [ ] **Step 1: Failing tests.** `tasks.test.ts` (the db package's own RLS harness, as `intake.test.ts` does), for three users: an owner, a rep who sees only their own leads, and another rep:
  - the rep sees the tasks on their leads, and not the tasks on the other rep's leads;
  - notifications are visible only to `user_id = lume_user()`, and a rep inserting a notification for someone else is refused;
  - `scheduled_notifications (task_id, offset_minutes)` is unique;
  - the status CHECKs hold;
  - the worker may `DELETE` from `notifications` and read only `id, read_at, created_at`.

  `maintenance.integration.test.ts`: read notifications older than 90 days go, unread ones stay.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement.** `0021_follow_ups.sql`:

```sql
-- Phase 3A (spec 2026-09-28-phase-3 §4): follow-ups, their reminders, and what they tell people.
CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES leads (id) ON DELETE CASCADE,
  assignee_id uuid NOT NULL REFERENCES users (id),
  type text NOT NULL DEFAULT 'follow_up' CONSTRAINT tasks_type CHECK (type IN ('follow_up', 'whatsapp')),
  template_id uuid,
  title text NOT NULL CONSTRAINT tasks_title CHECK (char_length(title) BETWEEN 1 AND 200),
  note text CONSTRAINT tasks_note CHECK (note IS NULL OR char_length(note) <= 2000),
  due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CONSTRAINT tasks_status CHECK (status IN ('open', 'done', 'cancelled')),
  remind_minutes int[] NOT NULL DEFAULT '{0}',
  recurrence jsonb,
  series_id uuid NOT NULL,
  auto_rule_id uuid,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  done_by uuid REFERENCES users (id),
  cancelled_at timestamptz,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX tasks_mine ON tasks (assignee_id, status, due_at);
CREATE INDEX tasks_lead ON tasks (lead_id, status, due_at);
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
-- A follow-up is visible exactly when its lead is (spec §3 "Who sees what"; assignees must see the lead).
CREATE POLICY tasks_read ON tasks FOR SELECT USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY tasks_create ON tasks FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));
CREATE POLICY tasks_update ON tasks FOR UPDATE USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = lead_id));

CREATE TABLE scheduled_notifications (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  offset_minutes int NOT NULL CONSTRAINT sn_offset CHECK (offset_minutes BETWEEN 0 AND 43200),
  fire_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CONSTRAINT sn_status CHECK (status IN ('pending', 'fired', 'cancelled')),
  fired_at timestamptz,
  CONSTRAINT sn_once UNIQUE (task_id, offset_minutes)
);
CREATE INDEX sn_due ON scheduled_notifications (fire_at) WHERE status = 'pending';

CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL,
  task_id uuid REFERENCES tasks (id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads (id) ON DELETE SET NULL,
  title text NOT NULL,
  body text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX notifications_mine ON notifications (user_id, id DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notifications_own ON notifications USING (user_id = lume_user()) WITH CHECK (user_id = lume_user());

REVOKE ALL ON notifications FROM lume_worker;
GRANT SELECT (id, read_at, created_at), DELETE ON notifications TO lume_worker;
```

`scheduled_notifications` has no row-level security of its own: it is only ever reached through a task (the engine) or by the sweeper, and it carries no names (2A amendment 5's reasoning for the intake tables). The worker's purge:

```ts
    async purgeNotifications() {
      const r = await pool.query(
        "DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < now() - interval '90 days'",
      );
      return { deleted: r.rowCount ?? 0 };
    },
```

- [ ] **Step 4: Run the tests** (they pass). **Step 5: Gate, commit.** Message: `feat(db): follow-ups, their reminders, and notifications — each seen only by whom it's for`.

---

### Task 2: The time library (pure, shared)

**Files:**
- Create: `packages/core/src/tasks/time.ts`, `packages/core/src/tasks/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/tasks/time.test.ts`

**Interfaces:**
- `type DuePreset = "in_1h" | "in_3h" | "tomorrow_10" | "in_2d" | "next_monday"`
- `dueFromPreset(p: DuePreset, now: Date, tz: string): Date`
- `type SnoozePreset = "15m" | "1h" | "evening" | "tomorrow_morning"`
- `snoozeUntil(p: SnoozePreset, now: Date, tz: string): Date`:
  - `evening` is 18:00 today, or tomorrow's 18:00 once it's past 17:30;
  - `tomorrow_morning` is 09:00 tomorrow.
- `reminderTimes(due: Date, minutes: number[]): { offset: number; at: Date }[]`: sorted and deduplicated, at most 5, each offset in 0..43200.
- `nextOccurrence(due: Date, r: Recurrence, now: Date, tz: string): Date | null`:
  - due plus `every` days or weeks, at the same local wall-clock time, moved forward in whole steps until it's after `now`;
  - `null` past `until` (the end of that local day).
- `localDayBounds(now: Date, tz: string): { start: Date; end: Date }`
- `wallTime(y, m, d, hh, mm, tz): Date`: the UTC instant of that local wall time. A nonexistent time (the DST gap) moves forward to the first valid minute; an ambiguous one takes the earlier.

- [ ] **Step 1: Failing tests** `time.test.ts`:
  - each preset in Asia/Dubai, Asia/Kolkata and Europe/London;
  - Review Focus 3: `tomorrow_10` from 2026-10-24 12:00 in London (BST, UTC+1) is 2026-10-25 10:00 local, which is GMT by then: `10:00Z`, not `09:00Z`;
  - `next_monday` from a Monday is the following Monday;
  - `evening` before and after 17:30;
  - `reminderTimes` dedupe, sort, cap and bounds;
  - `nextOccurrence`:
    - weekly across a DST change keeps 10:00 local;
    - a series overdue for three weeks moves to the next step after now;
    - `until` stops it;
  - `wallTime` in the spring gap (2026-03-29 01:30 London gives 02:00 BST, `01:00Z`).

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement** with `Intl.DateTimeFormat` only (no new dependency). The offset of a zone at an instant:

```ts
const parts = (d: Date, tz: string) => {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, hh: +p.hour!, mm: +p.minute!, ss: +p.second! };
};
const offsetMs = (d: Date, tz: string) => {
  const p = parts(d, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(d.getTime() / 1000) * 1000;
};
/** The instant a local wall time happens (the gap moves forward; an overlap takes the earlier). */
export function wallTime(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const a = new Date(guess - offsetMs(new Date(guess), tz));
  const b = new Date(guess - offsetMs(a, tz));
  const pb = parts(b, tz);
  if (pb.hh === hh && pb.mm === mm) return a.getTime() <= b.getTime() && parts(a, tz).hh === hh ? a : b;
  // In the gap: the first valid minute after it.
  return new Date(Math.max(a.getTime(), b.getTime()));
}
```

The presets and snooze options read the local date with `parts(now, tz)` and build with `wallTime`. `nextOccurrence` steps the local date (a day step adds 1 to the local day, and a week step adds 7) and rebuilds with `wallTime` at the original local hour and minute.

- [ ] **Step 4: Run** (pass). **Step 5: Gate, commit.** Message: `feat(core): follow-up times in the person's own day — presets, snooze, reminders, repeats, across DST`.

---

### Task 3: The engine — schedule, fire, sweep

**Files:**
- Create: `apps/api/src/modules/tasks/engine.ts`, `apps/api/src/modules/tasks/queue.ts`
- Modify: `apps/api/src/app.ts` (`AppDeps.tasks?: { enqueue(ids: number[]): Promise<void> }`), `apps/api/src/main.ts`, `apps/api/test/harness.ts` (`runFires()`, `sweep()`)
- Test: `apps/api/src/modules/tasks/engine.test.ts`

**Interfaces:**
- `schedule(db: Db, task: { id; dueAt: Date; remindMinutes: number[]; status }, now: Date): Promise<number[]>`: the new pending ids.
- `cancelReminders(db, taskId): Promise<void>`
- `fire(o: { app; pool }, id: number): Promise<"fired" | "skipped">`
- `sweep(o, now = new Date()): Promise<number>`: how many it fired.
- `startTaskQueue(o): { enqueue(ids: number[]): Promise<void>; stop(): Promise<void>; lastSweepAt(): Date | null }`
- NOTIFY payload on `lume_notifications`: `{"u":"<userId>","n":<notificationId>}`.

- [ ] **Step 1: Failing tests** `engine.test.ts` (harness; tasks arranged through the owner pool). This is the reliability suite (spec §8):
  - `schedule` writes one row per offset, drops ones already past (more than 30 s ago), and replaces the old pending ones;
  - Review Focus 1: a pending row 60 s past its time with no job is fired by `sweep()` once, and a second `sweep()` fires nothing;
  - Review Focus 2: `Promise.all([fire(id), fire(id), sweep()])` gives exactly one notification;
  - **crash:** hold a transaction that locked the row (`SELECT … FOR UPDATE` on a separate client, never committed), run `sweep()` (it skips the locked row), roll the holder back, run `sweep()` again: one notification;
  - a done or cancelled task's pending rows fire nothing;
  - Review Focus 4: when the assignee can no longer see the lead (its owner changed), `fire` writes no notification and marks the row fired, with `data.skipped = "not_visible"` in the log;
  - the notification's title uses the lead's name ("Follow up with Aisha Khan") and never a phone or email;
  - `kind` is `follow_up_due` at offset 0, and `follow_up_soon` otherwise, with "in 15 min" in the body;
  - the NOTIFY payload names the user and the notification id;
  - accuracy: with the harness clock, a row due at T is not fired by `sweep` at T − 1 s, and is fired at T + 31 s.

- [ ] **Step 2: Watch them fail.**

- [ ] **Step 3: Implement.** `fire`:

```ts
export async function fire(o: EngineDeps, id: number): Promise<"fired" | "skipped"> {
  const client = await o.pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Row>(
      `SELECT sn.id, sn.offset_minutes, t.id AS task_id, t.status, t.assignee_id, t.lead_id, t.title, t.due_at
         FROM scheduled_notifications sn JOIN tasks t ON t.id = sn.task_id
        WHERE sn.id = $1 AND sn.status = 'pending'
        FOR UPDATE OF sn SKIP LOCKED`,
      [id],
    );
    const r = rows[0];
    if (!r) return void (await client.query("ROLLBACK")), "skipped";
    let notified: number | null = null;
    if (r.status === "open") {
      // As the assignee, under their own lead scope: nothing about a lead they can't see is written.
      await setActor(client, r.assignee_id);
      const lead = await client.query<{ name: string }>("SELECT name FROM leads WHERE id = $1 AND deleted_at IS NULL", [r.lead_id]);
      if (lead.rows[0]) {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO notifications (user_id, kind, task_id, lead_id, title, body, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [r.assignee_id, r.offset_minutes === 0 ? "follow_up_due" : "follow_up_soon", r.task_id, r.lead_id,
           `${r.title} — ${lead.rows[0].name}`, r.offset_minutes === 0 ? "Now" : `In ${inWords(r.offset_minutes)}`,
           { dueAt: r.due_at }],
        );
        notified = Number(ins.rows[0]!.id);
        await client.query("SELECT pg_notify('lume_notifications', $1)", [JSON.stringify({ u: r.assignee_id, n: notified })]);
      }
    }
    await client.query("UPDATE scheduled_notifications SET status = 'fired', fired_at = now() WHERE id = $1", [id]);
    await client.query("COMMIT");
    return notified ? "fired" : "skipped";
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
```

`setActor` sets `lume.user_id` and `lume.lead_scope` from the assignee's actor (`loadActor`, as `withJobRequest` does), in this transaction only. `sweep` selects `id FROM scheduled_notifications WHERE status = 'pending' AND fire_at < $now - interval '30 seconds' ORDER BY fire_at LIMIT 500`, then fires each. `startTaskQueue` mirrors `startWebhookQueue`:
- a `tasks.fire` worker;
- `enqueue(ids)` sends each with `startAfter` = its `fire_at` and `singletonKey` = its id;
- the sweep runs every 60 s, and once before the API listens.

- [ ] **Step 4: Run** (pass). **Step 5: Gate, commit.** Message: `feat(api): the follow-up engine — reminders fire on time, once, and a sweeper catches anything missed`.

---

### Task 4: Follow-ups API

**Files:**
- Create: `apps/api/src/modules/tasks/service.ts`, `apps/api/src/modules/tasks/routes.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/test/probes.ts`, `apps/api/src/modules/leads/service.ts` (removing a lead cancels its open follow-ups), `apps/web/src/lib/settings/audit.ts`
- Test: `apps/api/src/modules/tasks/tasks.test.ts`

**Interfaces** (spec §7):
- `TaskView = { id; leadId; leadName; title; note; dueAt; status; remindMinutes; recurrence; assignee: { id; name }; createdBy: { id; name } | null; doneAt; canEdit }`
- Create and patch bodies:

```ts
{
  title?: string;
  note?: string | null;
  due: { at: string } | { preset: DuePreset };
  remindMinutes?: number[];
  recurrence?: Recurrence | null;
  assigneeId?: string;
}
```

  The preset is resolved in the **caller's** timezone.
- Done returns `{ task: TaskView, next: TaskView | null, clearedToday: boolean }`. `clearedToday` is true when this was the caller's last open follow-up due today.

- [ ] **Step 1: Failing tests** `tasks.test.ts`:
  - create for yourself on a visible lead gives 201, its reminders are scheduled, `leads.next_task_due_at` is set, and the history shows "follow_up_set";
  - on an invisible lead: 404;
  - for someone else without `tasks.manage_others`: 403 `CANNOT_ASSIGN_TASK`;
  - `tasks.manage_others` follows its scope: `team` reaches the members of your teams, `all` reaches anyone, and `own` reaches nobody but yourself;
  - Review Focus 4: an assignee who can't see the lead gives 409 `ASSIGNEE_CANT_SEE_LEAD`;
  - patch the due time: the reminders are rescheduled, and `next_task_due_at` follows;
  - snooze `{ until }`: the same;
  - done:
    - cancels pending reminders;
    - `next_task_due_at` moves to the next open follow-up, or null;
    - with recurrence, the next exists, due in the future, in the same series;
    - `clearedToday` is true for the last one of the day;
  - recurrence stops: the lead is won (its stage kind); `until` has passed; a `reply_logged` activity since the series began;
  - done twice gives 409 `NOT_OPEN`; snooze and done at once: exactly one wins, and the other gets 409;
  - cancel;
  - removing the lead cancels its open follow-ups and their reminders;
  - `GET /leads/:id/tasks` lists open ones first, then the last 10 done or cancelled;
  - audit: changing someone else's follow-up is audited (`task.changed_for_other`), and your own isn't;
  - probes for every route.

- [ ] **Step 2: Watch them fail.** **Step 3: Implement.**
  - Every write runs in the request's transaction:
    - it locks the task (`SELECT … FOR UPDATE`);
    - it checks `status = 'open'` (else `409 NOT_OPEN`);
    - it writes the task, calls `schedule` or `cancelReminders`, and recomputes `leads.next_task_due_at` (`SELECT min(due_at) FROM tasks WHERE lead_id = $1 AND status = 'open'`);
    - it logs the activity (`follow_up_set`, `follow_up_changed`, `follow_up_done` or `follow_up_cancelled`, with the title and due time in the payload);
    - after commit, it enqueues the new reminder ids.
  - A visibility check for the assignee:
    - `loadActor(assignee)`;
    - `can(actor, "leads.view", scopeFor(lead.owner_id))`, using the same owner-scope rule as `lume_can_see_owner`, via a SQL helper `lume_actor_can_see_owner(actor_id, owner_id)` added in this task's migration `0022_task_helpers.sql`, mirroring `lume_can_see_owner` for another user.

- [ ] **Step 4: Run** (pass). **Step 5: Gate, commit.** Message: `feat(api): follow-ups on leads — set, move, snooze, done (and the next one), with the lead's next date kept`.

---

### Task 5: Notifications, the live stream, and Today

**Files:**
- Create: `apps/api/src/modules/notifications/hub.ts`, `service.ts`, `routes.ts`; `apps/api/src/modules/tasks/today.ts`
- Modify: `apps/api/src/app.ts` (the hub starts with the app and closes with it), `apps/api/test/probes.ts`
- Test: `apps/api/src/modules/notifications/notifications.test.ts`, `apps/api/src/modules/tasks/today.test.ts`

**Interfaces:**
- `startHub(pool): { subscribe(userId, send: (n: NotificationView) => void): () => void; stop(): Promise<void> }`: one `LISTEN lume_notifications` client (reconnecting like `startRbacListener`). On each payload it loads the notification as that user and sends it to that user's subscribers only.
- `NotificationView = { id: number; kind; title; body; leadId; taskId; createdAt; read: boolean }`
- `GET /api/v1/stream`:
  - `config: { permission: "auth.self", db: false }`;
  - `reply.hijack()`, then write `text/event-stream` with `id: <n>\nevent: notification\ndata: <json>\n\n`;
  - on connect, replay the caller's notifications with `id > Last-Event-ID` (at most 50);
  - a heartbeat comment every 25 s;
  - unsubscribe on close.
- `GET /api/v1/today` → `{ overdue: TaskView[]; soon: TaskView[]; later: TaskView[]; done: number; total: number; needsYou?: { unassigned: number; sources: { id; name }[] } }`. The groups use the caller's local day: soon means due within 2 hours, and later means due after that but before the day ends.

- [ ] **Step 1: Failing tests.**
  - `notifications.test.ts`:
    - list and unread count;
    - mark read by ids and `all`;
    - Review Focus 5: open the stream over a real socket (`app.listen` on port 0 plus `fetch` with the session cookie), fire one, read the event, disconnect, fire a second, reconnect with `Last-Event-ID`, and get only the second;
    - another user's stream never receives it;
    - the stream answers 401 without a session.
  - `today.test.ts`, with the harness clock:
    - groups for a Dubai user and a Kolkata user at the same instant;
    - done today counts toward `done`/`total`;
    - an admin sees `needsYou`, a rep doesn't.

- [ ] **Step 2: Watch them fail.** **Step 3: Implement.** **Step 4: Run** (pass). **Step 5: Gate, commit.** Message: `feat(api): notifications, live — one LISTEN fans out to each person's own stream; Today, in their own day`.

---

### Task 6: Web — follow-ups in the lead drawer

**Files:**
- Create: `apps/web/src/lib/tasks/{types,client,format}.ts`; `apps/web/src/components/tasks/{FollowUpSheet,NextFollowUp,SnoozeMenu}.tsx` and `tasks.module.css`
- Modify: `apps/web/src/components/leads/drawer/LeadDrawer.tsx` (Follow-up in the actions, `F`, NextFollowUp under them), `apps/web/src/lib/leads/history.ts` (the four `follow_up_*` activities)
- Test: `FollowUpSheet.test.tsx`, `NextFollowUp.test.tsx`, `apps/web/src/lib/tasks/format.test.ts`, `history.test.ts`

**Interfaces:**
- `format.ts`: `whenInWords(iso, now, tz)`, giving "In 45 min", "Today, 16:30", "Tomorrow, 10:00", "Mon 5 Oct, 10:00" or "Yesterday, 18:00 (overdue)". Tested in two timezones.
- `FollowUpSheet({ lead, task?, canAssign, people, onSaved, onClose })`: a popover sheet anchored to the button (transform-origin at the trigger). It has:
  - a title, which defaults to "Follow up";
  - due chips (the five presets plus "Pick a time", a native `datetime-local` in the person's timezone);
  - reminder chips: "At the time" (on by default), "15 min before", "1 hour before", "1 day before";
  - Repeat: Off, Every day, Every 3 days, Every week, then Until;
  - For: a person picker, shown only when `canAssign`.
- `NextFollowUp({ lead, onChange })`: the soonest open follow-up. It shows:
  - `whenInWords`, and who it's for (when that isn't you);
  - a round tick: done plays the `done` sound (the `cleared` sound if `clearedToday`), and the row collapses with a spring;
  - a "…" menu with Snooze (15 min, 1 hour, This evening, Tomorrow morning, Pick a time), Edit and Cancel.

- [ ] **Step 1: Failing tests.**
  - The sheet posts `{ due: { preset: "tomorrow_10" }, remindMinutes: [0, 60] }` after two taps.
  - "Pick a time" sends `{ at }` in UTC for the person's timezone.
  - Repeat "Every 3 days" sends `{ every: 3, unit: "day", until: null, stopOn: ["won", "lost", "reply_logged"] }`.
  - "For" is hidden without `canAssign`.
  - NextFollowUp's tick calls `done`, and plays `cleared` when told to.
  - The Snooze menu sends `until`.
  - `F` opens the sheet (and not while typing in a field).

- [ ] **Step 2: Watch them fail.** **Step 3: Implement** (apple-design: the sheet springs from its trigger with damping 1.0; the tick fills and the row folds with `SPRINGS.default`; reduced motion cross-fades). **Step 4: Run.** **Step 5: Gate, commit.** Message: `feat(web): follow-ups in the lead drawer — two taps to set one, a tick to finish it`.

---

### Task 7: Web — Today, and the live bell

**Files:**
- Create: `apps/web/src/components/today/{Today,UpNext,ProgressRing,AllClear}.tsx` and `today.module.css`; `apps/web/src/lib/notifications/{client,useStream}.ts`
- Modify: `apps/web/src/app/(app)/today/page.tsx`, `apps/web/src/components/shell/TopBar.tsx` (the bell shows a dot while anything is unread; it opens Today until 3B's centre exists)
- Test: `Today.test.tsx`, `useStream.test.ts`, `TopBar.test.tsx` (the dot)

**Interfaces:**
- `useStream(onNotification)`: an `EventSource("/api/v1/stream")` that the browser reconnects itself (it sends `Last-Event-ID` on its own), closed on unmount. One per tab: a module-level singleton, with subscribers.
- `Today`:
  - the hero: "Good morning, Maya" in the person's timezone, the date, and one brief line naming the most urgent overdue lead (or "Nothing's overdue");
  - `ProgressRing` "3 / 7 cleared today";
  - `UpNext`: groups with sticky headers; rows show the lead name (it opens the drawer), the title and `whenInWords`; inline Done and Snooze appear on hover or focus, and are always visible on touch;
  - needs-you for admins;
  - `AllClear`: the LUME mark (`/lume-mark.png`) rotates in and `cleared` plays, once per day (localStorage, try/catch).
- A live notification refreshes Today (it refetches the groups) and lights the bell dot, silently.

- [ ] **Step 1: Failing tests.**
  - The groups render in order with their counts.
  - Done removes the row with a spring (motion's `AnimatePresence`), calls the API and updates the ring.
  - The last Done shows All clear and plays `cleared` once, not again on reload the same day.
  - The brief line names the most overdue lead.
  - `useStream` subscribes and cleans up (a fake EventSource).
  - The bell dot appears on an event and clears when Today loads with nothing unread.

- [ ] **Step 2: Watch them fail.** **Step 3: Implement.** **Step 4: Run.** **Step 5: Gate, commit.** Message: `feat(web): Today — what needs you, in your own day, and the bell that knows`.

---

### Task 8: End to end and acceptance

**Files:**
- Create: `apps/web/e2e/follow-ups.spec.ts`, `apps/web/e2e-live/acceptance-3a.mjs`
- Modify: `apps/web/e2e/a11y.spec.ts` (Today with items), `docs/runbooks/acceptance.md`, the acceptance chain

- [ ] **Step 1: The e2e spec.**
  - From a lead's drawer: Follow-up → In 1 hour, with a reminder at the time.
  - On Today it's in "Due soon".
  - Move its time to now (through the API, with `due: { at: now + 5 s }`); within 70 s the bell shows its dot (the sweeper and the job both work on the real stack).
  - Mark it done on Today: All clear.
  - Screenshots of Today (with items, and all clear), the drawer's next follow-up, and the sheet, in both themes.
  - Axe on each.
  - Clean up in `afterAll`.
- [ ] **Step 2: The live script**, through Caddy: the same, plus restarting the API container between setting a follow-up due in 90 s and its time. The sweeper still fires it: the crash-recovery acceptance of report §17.
- [ ] **Step 3: Run** the gate, the full e2e (review every new or changed screenshot) and the live chain. **Commit, push, CI.** Message: `test(e2e): follow-ups end to end — set, due, live, done; and a restart loses nothing`.

---

## Self-review

- **Spec coverage:**

  | Spec | Where |
  |---|---|
  | §3 engine decisions | Tasks 3–4 |
  | §3 times | Task 2 |
  | §3 visibility | Tasks 1 and 4 |
  | §3 stream | Task 5 |
  | §4 data | Task 1 |
  | §5 engine | Task 3 |
  | §6 screens | Tasks 6–7 |
  | §7 API | Tasks 4–5 |
  | §8 tests | Tasks 2–5 and 8 |

- **Rulings in this plan:**
  - **R1.** Tasks are visible exactly when their lead is. Assigning to someone who can't see the lead is refused, which is simpler and safer than an "assignee may see" exception that could leak the lead.
  - **R2.** `scheduled_notifications` has no row-level security, because it holds no names.
  - **R3.** The `F` shortcut is ignored while typing, as N is.
- **Type consistency:** `TaskView`, `Recurrence`, `DuePreset` and `NotificationView` carry the same names across Tasks 2–7.
