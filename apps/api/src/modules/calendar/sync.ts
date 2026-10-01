import type pg from "pg";
import {
  DEFAULT_CALENDAR_RULES,
  calendarRulesSchema,
  matchEvent,
  newId,
  type Keyring,
  type MeetingMatch,
} from "@lume/core";
import type { ConnectedCalendar } from "@lume/db";
import { notify } from "../notifications/notify";
import { GOOGLE_UNREACHABLE, GoogleError, isTransient } from "../sheets/google";
import { SyncTokenGone, type CalendarEventRead, type GoogleCalendar } from "./google";

export type CalendarSyncDeps = {
  pool: pg.Pool;
  keyring: Keyring;
  /** A client for a connection's grant; null when Connect with Google isn't configured here. */
  clientFor: (grant: string) => GoogleCalendar | null;
  now?: () => Date;
  log?: { error(o: object, msg: string): void };
};
export type SyncOutcome = "synced" | "busy" | "skipped" | "needs_reconnect" | "failed";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Every five minutes per connection (spec §2.3); Google busy backs off, to six hours at most. */
const EVERY_MS = 5 * MINUTE;
const MAX_BACKOFF_MS = 6 * 60 * MINUTE;
/** The window a full read covers (spec §2.3): −30 to +90 days. */
const BACK_MS = 30 * DAY;
const AHEAD_MS = 90 * DAY;
/** What a meeting row may hold (the table's own limits). */
const cut = (s: string | null, n: number) => (s === null ? null : s.slice(0, n));

type Row = {
  id: string;
  user_id: string;
  google_email: string;
  grant_enc: Buffer;
  calendars: ConnectedCalendar[];
  status: string;
  failures: number;
};
type CalendarRead = { id: string; full: boolean; events: CalendarEventRead[] };

/** One transaction as a person (seeing every lead, as LUME's sync does), or as LUME's read-only sweep. */
async function inTx<T>(
  pool: pg.Pool,
  as: { user: string | null; sweep?: boolean },
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true), set_config('lume.calendar_sweep', $2, true)",
      [as.user ?? "", as.sweep ? "on" : ""],
    );
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Active connections whose next sync is due, while Google Calendar is switched on (LUME's sweep: ids only). */
export async function dueConnections(pool: pg.Pool, at: Date): Promise<string[]> {
  return inTx(pool, { user: null, sweep: true }, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT c.id FROM calendar_connections c, settings s
        WHERE s.id = 1 AND COALESCE((s.integrations -> 'googleCalendar' ->> 'enabled')::boolean, false)
          AND c.status = 'active' AND c.next_sync_at <= $1
        ORDER BY c.next_sync_at LIMIT 50`,
      [at],
    );
    return rows.map((r) => r.id);
  });
}

/**
 * Reads one connection's chosen calendars and keeps the lead meetings in them (spec §2.2–2.3). One at a time
 * per connection: a second sync while one runs says "busy" and does nothing.
 */
export async function runCalendarSync(d: CalendarSyncDeps, id: string): Promise<SyncOutcome> {
  const key = `lume.calendar:${id}`;
  const lock = await d.pool.connect();
  try {
    const { rows } = await lock.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
      [key],
    );
    if (!rows[0]?.ok) return "busy";
    try {
      return await syncLocked(d, id);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    }
  } finally {
    lock.release();
  }
}

async function syncLocked(d: CalendarSyncDeps, id: string): Promise<SyncOutcome> {
  const now = (d.now ?? (() => new Date()))();
  const [conn] = await inTx(d.pool, { user: null, sweep: true }, async (c) => {
    const { rows } = await c.query<Row>(
      "SELECT id, user_id, google_email, grant_enc, calendars, status, failures FROM calendar_connections WHERE id = $1",
      [id],
    );
    return rows;
  });
  if (!conn || conn.status !== "active" || !(await moduleOn(d.pool))) return "skipped";
  if (!(await stillTheirs(d.pool, conn.user_id))) {
    await forget(d.pool, conn, now);
    return "skipped";
  }
  const google = d.clientFor(d.keyring.decrypt(conn.grant_enc, `calendar-connection:${conn.id}`));
  if (!google) return "skipped";

  // Google first, with no transaction open; then everything is written in one.
  let read: Awaited<ReturnType<typeof readCalendars>>;
  try {
    read = await readCalendars(google, conn.calendars, now);
  } catch (e) {
    return failed(d, conn, e, now);
  }
  return inTx(d.pool, { user: conn.user_id }, (c) => write(c, conn, read, now));
}

/** Google Calendar is switched on here (Settings → Integrations): a sync already queued when it went off waits. */
async function moduleOn(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ on: boolean }>(
    "SELECT COALESCE((integrations -> 'googleCalendar' ->> 'enabled')::boolean, false) AS on FROM settings WHERE id = 1",
  );
  return !!rows[0]?.on;
}

/** The person is still someone LUME reads a calendar for: active, and allowed to connect one. */
async function stillTheirs(pool: pg.Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT u.status = 'active' AND (u.is_owner OR EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
          JOIN role_permissions rp ON rp.role_id = r.id
         WHERE ur.user_id = u.id AND rp.permission_key = 'calendar.connect')) AS ok
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  return !!rows[0]?.ok;
}

/**
 * Someone disabled, or no longer allowed to connect a calendar: LUME stops reading it and forgets the grant
 * for them (no one else may disconnect a person's calendar). Their meetings with leads stay, as the leads'
 * history; their unlinked ones go.
 */
async function forget(pool: pg.Pool, conn: Row, now: Date) {
  await inTx(pool, { user: conn.user_id }, async (c) => {
    await c.query(
      "UPDATE meetings SET connection_id = NULL WHERE connection_id = $1 AND lead_id IS NOT NULL",
      [conn.id],
    );
    const gone = await c.query<{ outcome_task_id: string | null }>(
      "DELETE FROM meetings WHERE connection_id = $1 RETURNING outcome_task_id",
      [conn.id],
    );
    await closeOutcomeTasks(
      c,
      gone.rows.map((x) => x.outcome_task_id),
      now,
    );
    await c.query("DELETE FROM calendar_connections WHERE id = $1", [conn.id]);
    await c.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, diff)
       VALUES (NULL, 'calendar.disconnected', 'calendar_connection', $1, $2)`,
      [conn.id, { meetings: gone.rowCount ?? 0, reason: "not_allowed" }],
    );
  });
}

/** The calendar list (names, new and removed calendars), then each chosen one: since its token, or in full. */
async function readCalendars(google: GoogleCalendar, known: ConnectedCalendar[], now: Date) {
  const list = await google.calendarList();
  const prior = new Map(known.map((c) => [c.id, c]));
  const listed = new Set(list.map((c) => c.id));
  const calendars: ConnectedCalendar[] = list.map((c) => {
    const p = prior.get(c.id);
    return {
      id: c.id,
      name: c.name,
      chosen: p?.chosen ?? false,
      syncToken: p?.syncToken ?? null,
      fullAt: p?.fullAt ?? null,
    };
  });
  const reads: CalendarRead[] = [];
  // A chosen calendar gone from the account: the others are read in full, so an event it shared with them
  // moves to them rather than vanishing.
  const lostOne = known.some((c) => c.chosen && !listed.has(c.id));
  for (const cal of calendars.filter((c) => c.chosen)) {
    // Once a day a full read, so an event still finds a lead whose email arrived after it was read.
    const due = lostOne || !cal.syncToken || !cal.fullAt || now.getTime() - Date.parse(cal.fullAt) >= DAY;
    let r: { events: CalendarEventRead[]; nextSyncToken: string } | null = null;
    if (!due)
      try {
        r = await google.events(cal.id, { syncToken: cal.syncToken! });
      } catch (e) {
        if (!(e instanceof SyncTokenGone)) throw e;
      }
    const full = !r;
    r ??= await google.events(cal.id, {
      timeMin: new Date(now.getTime() - BACK_MS),
      timeMax: new Date(now.getTime() + AHEAD_MS),
    });
    cal.syncToken = r.nextSyncToken;
    if (full) cal.fullAt = now.toISOString();
    reads.push({ id: cal.id, full, events: r.events });
  }
  return { calendars, reads };
}

const chosenOf = (cs: ConnectedCalendar[]) =>
  cs
    .filter((c) => c.chosen)
    .map((c) => c.id)
    .sort()
    .join("\n");

/** Its Log outcome follow-ups closed: their meeting is gone, cancelled or moved on (no reminder, no escalation). */
async function closeOutcomeTasks(c: pg.PoolClient, taskIds: (string | null)[], now: Date) {
  const ids = taskIds.filter((x): x is string => !!x);
  if (!ids.length) return;
  const { rows } = await c.query<{ id: string; lead_id: string }>(
    `UPDATE tasks SET status = 'cancelled', cancelled_at = $2, updated_at = $2, version = version + 1
      WHERE id = ANY($1::uuid[]) AND status = 'open' RETURNING id, lead_id`,
    [ids, now],
  );
  if (!rows.length) return;
  await c.query(
    "UPDATE scheduled_notifications SET status = 'cancelled' WHERE task_id = ANY($1::uuid[]) AND status = 'pending'",
    [rows.map((r) => r.id)],
  );
  await c.query(
    `UPDATE leads l SET next_task_due_at = (SELECT min(due_at) FROM tasks t WHERE t.lead_id = l.id AND t.status = 'open')
      WHERE l.id = ANY($1::uuid[])`,
    [[...new Set(rows.map((r) => r.lead_id))]],
  );
}

type Existing = {
  id: string;
  lead_id: string | null;
  connection_id: string | null;
  calendar_id: string | null;
  matched_by: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
  link: string | null;
  location: string | null;
  status: string;
  outcome_at: Date | null;
  outcome_asked_at: Date | null;
  outcome_task_id: string | null;
};
/** What a read said of one event, on one calendar. */
type Seen = { calendar: string; ev: CalendarEventRead; match: MeetingMatch | null };

async function write(
  c: pg.PoolClient,
  conn: Row,
  read: Awaited<ReturnType<typeof readCalendars>>,
  now: Date,
): Promise<SyncOutcome> {
  const { rows: cur } = await c.query<{ calendars: ConnectedCalendar[] }>(
    "SELECT calendars FROM calendar_connections WHERE id = $1 FOR UPDATE",
    [conn.id],
  );
  if (!cur[0]) return "skipped"; // disconnected while LUME read
  // The person chose other calendars while LUME read: this read is for the old choice; read again at once.
  if (chosenOf(cur[0].calendars) !== chosenOf(conn.calendars)) {
    await c.query("UPDATE calendar_connections SET next_sync_at = $2 WHERE id = $1", [conn.id, now]);
    return "skipped";
  }
  const [settings] = (
    await c.query<{ calendar: { rules?: unknown } }>("SELECT calendar FROM settings WHERE id = 1")
  ).rows;
  const parsed = calendarRulesSchema.safeParse(settings?.calendar?.rules);
  const rules = parsed.success ? parsed.data : DEFAULT_CALENDAR_RULES;
  // LUME's own people are never a lead's attendee: the calendar's person, and anyone who signs in to LUME
  // (a lead holding one of their addresses would otherwise pull their whole calendar in).
  const { rows: staff } = await c.query<{ e: string }>("SELECT lower(email) AS e FROM users");
  const ours = new Set([conn.google_email.trim().toLowerCase(), ...staff.map((x) => x.e)]);
  const others = (e: CalendarEventRead) => ({
    organizer: e.organizer && !ours.has(e.organizer.trim().toLowerCase()) ? e.organizer : null,
    attendees: e.attendees.filter((a) => !ours.has(a.trim().toLowerCase())),
  });
  // Only the addresses this read saw are looked up: a live lead's, the oldest when two share one.
  const emails = [
    ...new Set(
      read.reads.flatMap((r) =>
        r.events.flatMap((e) => {
          const o = others(e);
          return [...o.attendees, ...(o.organizer ? [o.organizer] : [])].map((x) => x.trim().toLowerCase());
        }),
      ),
    ),
  ];
  const { rows: leads } = await c.query<{ e: string; id: string }>(
    `SELECT DISTINCT ON (lower(email)) lower(email) AS e, id FROM leads
      WHERE deleted_at IS NULL AND email = ANY($1::citext[]) ORDER BY lower(email), created_at, id`,
    [emails],
  );
  const leadsByEmail = new Map(leads.map((l) => [l.e, l.id]));
  const owner = conn.user_id;

  // Every event decided across all its calendars first: Google gives one event the same id on each.
  const byEvent = new Map<string, Seen[]>();
  for (const r of read.reads)
    for (const ev of r.events) {
      // An all-day item (a holiday, a day out) is not a meeting; nor is one without its times.
      const match =
        ev.status === "cancelled" || ev.allDay || !ev.startsAt || !ev.endsAt
          ? null
          : matchEvent({ title: ev.title, ...others(ev) }, { leadsByEmail, rules, calendarId: r.id });
      byEvent.set(ev.id, [...(byEvent.get(ev.id) ?? []), { calendar: r.id, ev, match }]);
    }

  const kept = new Set<string>();
  for (const [eventId, seen] of byEvent) {
    const { rows: was } = await c.query<Existing>(
      `SELECT id, lead_id, connection_id, calendar_id, matched_by, title, starts_at, ends_at, link, location, status,
              outcome_at, outcome_asked_at, outcome_task_id
         FROM meetings WHERE source = 'google' AND owner_id = $1 AND external_id = $2`,
      [owner, eventId],
    );
    const old = was[0];
    const keeping = seen.filter((s) => s.match);
    const reported = seen.map((s) => s.calendar);
    if (!keeping.length) {
      // What a calendar said of an event only touches the meeting it brought; a recorded outcome is history.
      if (!old || (old.calendar_id !== null && !reported.includes(old.calendar_id))) continue;
      if (seen.some((s) => s.ev.status === "cancelled")) {
        if (old.status === "scheduled") {
          await c.query(
            "UPDATE meetings SET status = 'cancelled', updated_at = $2, version = version + 1 WHERE id = $1",
            [old.id, now],
          );
          await closeOutcomeTasks(c, [old.outcome_task_id], now);
        }
      } else if (old.status === "scheduled" || old.status === "cancelled") {
        await c.query("DELETE FROM meetings WHERE id = $1", [old.id]);
        await closeOutcomeTasks(c, [old.outcome_task_id], now);
      }
      continue;
    }
    kept.add(eventId);
    // The calendar it's on stays while that calendar still keeps it (no flipping between two).
    const pick = keeping.find((s) => s.calendar === old?.calendar_id) ?? keeping[0]!;
    const m = pick.match!;
    const ev = pick.ev;
    const startsAt = ev.startsAt!;
    const endsAt = ev.endsAt! < startsAt ? startsAt : ev.endsAt!;
    const fields = {
      lead_id: m.leadId ?? old?.lead_id ?? null, // a meeting someone attached keeps its lead while no rule finds one
      calendar_id: pick.calendar,
      matched_by: m.why,
      title: cut(ev.title, 1000)!,
      link: cut(ev.link, 2000),
      location: cut(ev.location, 1000),
    };
    if (!old) {
      await c.query(
        `INSERT INTO meetings (id, lead_id, owner_id, connection_id, source, external_id, calendar_id, matched_by,
                               title, starts_at, ends_at, link, location, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'google', $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
        [
          newId(),
          fields.lead_id,
          owner,
          conn.id,
          eventId,
          fields.calendar_id,
          fields.matched_by,
          fields.title,
          startsAt,
          endsAt,
          fields.link,
          fields.location,
          now,
        ],
      );
      continue;
    }
    // Moved later than its outcome (or than the ask for it): it's a meeting still to come, asked about again.
    const mark = old.outcome_at ?? old.outcome_asked_at;
    const movedOn = !!mark && startsAt.getTime() !== old.starts_at.getTime() && startsAt > mark;
    const status = movedOn || old.status === "cancelled" ? "scheduled" : old.status;
    const same =
      !movedOn &&
      old.lead_id === fields.lead_id &&
      old.connection_id === conn.id &&
      old.calendar_id === fields.calendar_id &&
      old.matched_by === fields.matched_by &&
      old.title === fields.title &&
      old.starts_at.getTime() === startsAt.getTime() &&
      old.ends_at.getTime() === endsAt.getTime() &&
      old.link === fields.link &&
      old.location === fields.location &&
      old.status === status;
    if (same) continue;
    if (movedOn) await closeOutcomeTasks(c, [old.outcome_task_id], now);
    await c.query(
      `UPDATE meetings SET lead_id = $2, connection_id = $3, calendar_id = $4, matched_by = $5, title = $6,
              starts_at = $7, ends_at = $8, link = $9, location = $10, status = $11, updated_at = $12,
              version = version + 1,
              outcome_at = CASE WHEN $13 THEN NULL ELSE outcome_at END,
              outcome_by = CASE WHEN $13 THEN NULL ELSE outcome_by END,
              outcome_note = CASE WHEN $13 THEN NULL ELSE outcome_note END,
              outcome_asked_at = CASE WHEN $13 THEN NULL ELSE outcome_asked_at END,
              outcome_task_id = CASE WHEN $13 THEN NULL ELSE outcome_task_id END
        WHERE id = $1`,
      [
        old.id,
        fields.lead_id,
        conn.id,
        fields.calendar_id,
        fields.matched_by,
        fields.title,
        startsAt,
        endsAt,
        fields.link,
        fields.location,
        status,
        now,
        movedOn,
      ],
    );
  }

  // A full read is the whole window: a meeting it brought whose event no calendar kept is gone (a cancelled
  // one stays, as Google leaves cancelled events out of a full read; one with an outcome is history).
  const chosen = read.calendars.filter((x) => x.chosen).map((x) => x.id);
  for (const r of read.reads.filter((x) => x.full)) {
    const { rows } = await c.query<{ outcome_task_id: string | null }>(
      `DELETE FROM meetings WHERE connection_id = $1 AND calendar_id = $2 AND status = 'scheduled'
          AND starts_at >= $3 AND starts_at < $4 AND NOT (external_id = ANY($5::text[]))
        RETURNING outcome_task_id`,
      [conn.id, r.id, new Date(now.getTime() - BACK_MS), new Date(now.getTime() + AHEAD_MS), [...kept]],
    );
    await closeOutcomeTasks(
      c,
      rows.map((x) => x.outcome_task_id),
      now,
    );
  }
  // A calendar no longer chosen (or gone from the account) takes the meetings it brought, after the reads
  // above moved any another chosen calendar still has; one with an outcome is history.
  const { rows: gone } = await c.query<{ outcome_task_id: string | null }>(
    `DELETE FROM meetings WHERE connection_id = $1 AND status IN ('scheduled', 'cancelled')
        AND (calendar_id IS NULL OR NOT (calendar_id = ANY($2::text[])))
      RETURNING outcome_task_id`,
    [conn.id, chosen],
  );
  await closeOutcomeTasks(
    c,
    gone.map((x) => x.outcome_task_id),
    now,
  );
  await c.query(
    `UPDATE calendar_connections SET calendars = $2, last_synced_at = $3, next_sync_at = $4, failures = 0,
            last_error = NULL, updated_at = $3 WHERE id = $1`,
    [conn.id, JSON.stringify(read.calendars), now, new Date(now.getTime() + EVERY_MS)],
  );
  return "synced";
}

/**
 * Google refused the grant: the connection needs connecting again, and its person and the admins hear it
 * once (spec §2.1); meetings already kept stay. Anything else passes or is a bug: back off and try again.
 * Nothing from an event is ever written here.
 */
async function failed(d: CalendarSyncDeps, conn: Row, e: unknown, now: Date): Promise<SyncOutcome> {
  if (e instanceof GoogleError && e.kind === "access") {
    const changed = await inTx(d.pool, { user: conn.user_id }, async (c) => {
      const r = await c.query(
        `UPDATE calendar_connections SET status = 'needs_reconnect', last_error = $2, updated_at = $3
          WHERE id = $1 AND status = 'active'`,
        [conn.id, "Google stopped letting LUME read this calendar.", now],
      );
      if (r.rowCount)
        await c.query(
          `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, diff)
           VALUES (NULL, 'calendar.needs_reconnect', 'calendar_connection', $1, '{}')`,
          [conn.id],
        );
      return !!r.rowCount;
    });
    if (changed) await tellReconnect(d, conn.user_id);
    return "needs_reconnect";
  }
  if (!isTransient(e)) d.log?.error({ err: e }, "calendar sync failed");
  const failures = conn.failures + 1;
  const wait = Math.min(EVERY_MS * 2 ** failures, MAX_BACKOFF_MS);
  await inTx(d.pool, { user: conn.user_id }, (c) =>
    c.query(
      "UPDATE calendar_connections SET failures = $2, last_error = $3, next_sync_at = $4, updated_at = $5 WHERE id = $1",
      [
        conn.id,
        failures,
        isTransient(e) ? GOOGLE_UNREACHABLE : "LUME couldn't read this calendar.",
        new Date(now.getTime() + wait),
        now,
      ],
    ),
  );
  return "failed";
}

/** The person, and every admin (the owner, or anyone who manages settings) besides them. */
async function tellReconnect(d: CalendarSyncDeps, userId: string) {
  const { rows } = await d.pool.query<{ id: string; name: string; admin: boolean }>(
    `SELECT u.id, u.name, (u.is_owner OR EXISTS (
        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
          JOIN role_permissions rp ON rp.role_id = r.id
         WHERE ur.user_id = u.id AND rp.permission_key = 'settings.manage')) AS admin
       FROM users u WHERE u.status = 'active'`,
  );
  const person = rows.find((r) => r.id === userId);
  const say = async (to: string, title: string) =>
    notify(d.pool, to, { kind: "calendar_reconnect", title }).catch((err: unknown) =>
      d.log?.error({ err }, "couldn't tell someone their calendar needs connecting again"),
    );
  if (person) await say(person.id, "Your Google Calendar needs connecting again");
  for (const a of rows.filter((r) => r.admin && r.id !== userId))
    await say(a.id, `${person?.name ?? "Someone"}'s Google Calendar needs connecting again`);
}
