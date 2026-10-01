import type pg from "pg";
import { DEFAULT_CALENDAR_RULES, calendarRulesSchema, matchEvent, newId, type Keyring } from "@lume/core";
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

/** Active connections whose next sync is due (LUME's sweep: ids only). */
export async function dueConnections(pool: pg.Pool, at: Date): Promise<string[]> {
  return inTx(pool, { user: null, sweep: true }, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "SELECT id FROM calendar_connections WHERE status = 'active' AND next_sync_at <= $1 ORDER BY next_sync_at LIMIT 50",
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
      "SELECT id, user_id, grant_enc, calendars, status, failures FROM calendar_connections WHERE id = $1",
      [id],
    );
    return rows;
  });
  if (!conn || conn.status !== "active") return "skipped";
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

/** The calendar list (names, new and removed calendars), then each chosen one: since its token, or in full. */
async function readCalendars(google: GoogleCalendar, known: ConnectedCalendar[], now: Date) {
  const list = await google.calendarList();
  const prior = new Map(known.map((c) => [c.id, c]));
  const listed = new Set(list.map((c) => c.id));
  const removed = known.filter((c) => !listed.has(c.id)).map((c) => c.id);
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
  for (const cal of calendars.filter((c) => c.chosen)) {
    // Once a day a full read, so an event still finds a lead whose email arrived after it was read.
    const due = !cal.syncToken || !cal.fullAt || now.getTime() - Date.parse(cal.fullAt) >= DAY;
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
  return { calendars, removed, reads };
}

const chosenOf = (cs: ConnectedCalendar[]) =>
  cs
    .filter((c) => c.chosen)
    .map((c) => c.id)
    .sort()
    .join("\n");

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
  // Only the addresses this read saw are looked up: a live lead's, the oldest when two share one.
  const emails = [
    ...new Set(
      read.reads.flatMap((r) =>
        r.events.flatMap((e) =>
          [...e.attendees, ...(e.organizer ? [e.organizer] : [])].map((x) => x.trim().toLowerCase()),
        ),
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

  if (read.removed.length)
    await c.query("DELETE FROM meetings WHERE connection_id = $1 AND calendar_id = ANY($2::text[])", [
      conn.id,
      read.removed,
    ]);
  const drop = (externalId: string) =>
    c.query("DELETE FROM meetings WHERE source = 'google' AND owner_id = $1 AND external_id = $2", [
      owner,
      externalId,
    ]);
  for (const r of read.reads) {
    const kept: string[] = [];
    for (const ev of r.events) {
      if (ev.status === "cancelled") {
        await c.query(
          `UPDATE meetings SET status = 'cancelled', updated_at = $3, version = version + 1
            WHERE source = 'google' AND owner_id = $1 AND external_id = $2 AND status <> 'cancelled'`,
          [owner, ev.id, now],
        );
        continue;
      }
      // An all-day item (a holiday, a day out) is not a meeting; nor is one without its times.
      const m =
        ev.allDay || !ev.startsAt || !ev.endsAt
          ? null
          : matchEvent(
              { title: ev.title, organizer: ev.organizer, attendees: ev.attendees },
              { leadsByEmail, rules, calendarId: r.id },
            );
      if (!m) {
        await drop(ev.id);
        continue;
      }
      kept.push(ev.id);
      const ends = ev.endsAt! < ev.startsAt! ? ev.startsAt! : ev.endsAt!;
      await c.query(
        `INSERT INTO meetings (id, lead_id, owner_id, connection_id, source, external_id, calendar_id, matched_by,
                               title, starts_at, ends_at, link, location, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'google', $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
         ON CONFLICT (source, owner_id, external_id) DO UPDATE SET
           -- A meeting someone attached to a lead keeps that lead while the rules find none.
           lead_id = COALESCE(EXCLUDED.lead_id, meetings.lead_id),
           connection_id = EXCLUDED.connection_id, calendar_id = EXCLUDED.calendar_id,
           matched_by = EXCLUDED.matched_by, title = EXCLUDED.title, starts_at = EXCLUDED.starts_at,
           ends_at = EXCLUDED.ends_at, link = EXCLUDED.link, location = EXCLUDED.location,
           status = CASE WHEN meetings.status = 'cancelled' THEN 'scheduled' ELSE meetings.status END,
           updated_at = EXCLUDED.updated_at, version = meetings.version + 1
         WHERE (meetings.lead_id, meetings.connection_id, meetings.calendar_id, meetings.matched_by, meetings.title,
                meetings.starts_at, meetings.ends_at, meetings.link, meetings.location, meetings.status)
           IS DISTINCT FROM (COALESCE(EXCLUDED.lead_id, meetings.lead_id), EXCLUDED.connection_id, EXCLUDED.calendar_id,
                EXCLUDED.matched_by, EXCLUDED.title, EXCLUDED.starts_at, EXCLUDED.ends_at, EXCLUDED.link,
                EXCLUDED.location, CASE WHEN meetings.status = 'cancelled' THEN 'scheduled' ELSE meetings.status END)`,
        [
          newId(),
          m.leadId,
          owner,
          conn.id,
          ev.id,
          r.id,
          m.why,
          cut(ev.title, 1000),
          ev.startsAt,
          ends,
          cut(ev.link, 2000),
          cut(ev.location, 1000),
          now,
        ],
      );
    }
    // A full read is the whole window: a meeting in it whose event wasn't kept is gone (a cancelled one stays,
    // as Google leaves cancelled events out of a full read).
    if (r.full)
      await c.query(
        `DELETE FROM meetings WHERE connection_id = $1 AND calendar_id = $2 AND status <> 'cancelled'
            AND starts_at >= $3 AND starts_at < $4 AND NOT (external_id = ANY($5::text[]))`,
        [conn.id, r.id, new Date(now.getTime() - BACK_MS), new Date(now.getTime() + AHEAD_MS), kept],
      );
  }
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
