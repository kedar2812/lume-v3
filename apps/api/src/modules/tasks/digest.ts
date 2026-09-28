import type pg from "pg";
import { can, localDayBounds, mergePreferences } from "@lume/core";
import { applyRequestScope } from "../../db/context";
import { digestMail, type DigestItem } from "../../mail/templates";
import type { Mailer } from "../../mail/mailer";
import { loadActor } from "../../rbac/actor";

export type DigestDeps = {
  pool: pg.Pool;
  mailer: Mailer;
  publicUrl: string;
  log?: { error: (o: object, msg?: string) => void };
};

/** The person's wall clock: their local date (YYYY-MM-DD), weekday (0 = Sunday) and "HH:MM". */
function wall(now: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: days.indexOf(p.weekday!),
    time: `${p.hour}:${p.minute}`,
  };
}
const clock = (at: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
/** Within the last six days its weekday ("Sun 11:30"); older, its date ("27 Sep 11:30"), never a wrong week. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dayAndClock = (at: Date, tz: string, now: Date) => {
  const w = wall(at, tz);
  const [, m, d] = w.date.split("-").map(Number) as [number, number, number];
  const day = now.getTime() - at.getTime() < 6 * 24 * 3_600_000 ? DAYS[w.weekday] : `${d} ${MONTHS[m - 1]}`;
  return `${day} ${w.time}`;
};
const first = (name: string) => name.trim().split(/\s+/)[0] || name;
/**
 * A follow-up's own words, with any phone number or email taken out: they're typed by people ("Call +971…"),
 * and the email leaves LUME's access control (report §10.7; 3B final review, Important 6).
 */
export const withoutContacts = (s: string) =>
  s
    .replace(/[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g, "…")
    .replace(/\+?\d[\d\s().\-/]{5,}\d/g, "…")
    .replace(/\s{2,}/g, " ")
    .trim();

type Person = { id: string; email: string; name: string; preferences: unknown; tz: string };

/**
 * The daily digest (3B Task 4; report §10.7), every 15 minutes: each active person who wants it, on their
 * working days, at or after their digest time in their own timezone, once per their local date. It carries
 * lead first names and times only. A mail that fails leaves no record, so the next run tries again.
 */
export async function runDigests(d: DigestDeps, now: Date = new Date()): Promise<number> {
  // An optional module (CLAUDE.md): off for the whole business in Settings → Follow-ups, or with no mail server.
  if (d.mailer.configured === false) return 0;
  const { rows: biz } = await d.pool.query<{ business_name: string; on: boolean }>(
    `SELECT business_name, coalesce((follow_ups -> 'digest' ->> 'enabled')::boolean, true) AS on
       FROM settings WHERE id = 1`,
  );
  if (!biz[0]?.on) return 0;
  const { rows: people } = await d.pool.query<Person>(
    `SELECT u.id, u.email, u.name, u.preferences, coalesce(u.timezone, s.timezone) AS tz
       FROM users u, settings s WHERE s.id = 1 AND u.status = 'active' ORDER BY u.id`,
  );
  let mailed = 0;
  for (const u of people) {
    // One person LUME can't read (a timezone that no longer exists) never stops anyone else's.
    try {
      if (await digestFor(d, u, biz[0].business_name, now)) mailed++;
    } catch (err) {
      d.log?.error({ err, userId: u.id }, "a morning email failed; the next run tries again");
      // Written down for System health (3C): who, never what.
      await d.pool
        .query("INSERT INTO ops_events (kind, ok, detail) VALUES ('digest.failed', false, $1)", [
          { userId: u.id },
        ])
        .catch(() => undefined);
    }
  }
  return mailed;
}

/** One person's digest, if it's their time and it hasn't gone today. True when a mail went. */
async function digestFor(d: DigestDeps, u: Person, businessName: string, now: Date): Promise<boolean> {
  const prefs = mergePreferences(u.preferences, {});
  const w = wall(now, u.tz);
  if (!prefs.alerts.emailDigest || !prefs.workingDays.includes(w.weekday) || w.time < prefs.digestTime)
    return false;
  const done = await d.pool.query("SELECT 1 FROM digest_runs WHERE user_id = $1 AND local_date = $2", [
    u.id,
    w.date,
  ]);
  if (done.rowCount) return false;
  const items = await build(d.pool, u, now);
  const count = items.overdue.length + items.today.length + items.assigned + (items.admin ? 1 : 0);
  // Claim the day before sending: two runs at once (a slow mail server, two API processes) send once
  // (3B final review, Important 1). A send that fails gives the day back, so the next run tries again.
  const claim = await d.pool.query(
    "INSERT INTO digest_runs (user_id, local_date, items) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [u.id, w.date, count],
  );
  if (!claim.rowCount || !count) return false;
  try {
    await d.mailer.send(
      digestMail({
        to: u.email,
        firstName: first(u.name),
        businessName,
        url: `${d.publicUrl.replace(/\/$/, "")}/today`,
        ...items,
      }),
    );
  } catch (err) {
    await d.pool.query("DELETE FROM digest_runs WHERE user_id = $1 AND local_date = $2", [u.id, w.date]);
    throw err;
  }
  return true;
}

/** What goes in one person's digest, read as them (their own lead scope). */
async function build(pool: pg.Pool, u: Person, now: Date) {
  const actor = await loadActor(pool, u.id);
  const empty = { overdue: [] as DigestItem[], today: [] as DigestItem[], assigned: 0, admin: null };
  if (!actor) return empty;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await applyRequestScope(client, actor);
    const { start, end } = localDayBounds(now, u.tz);
    // Overdue and later today, each with its own room: a long overdue list never hides today's.
    const list = async (from: Date | null, to: Date) =>
      (
        await client.query<{ lead: string; title: string; due_at: Date }>(
          `SELECT l.name AS lead, t.title, t.due_at FROM tasks t JOIN leads l ON l.id = t.lead_id
            WHERE t.assignee_id = $1 AND t.status = 'open' AND l.deleted_at IS NULL
              AND t.due_at < $3 AND ($2::timestamptz IS NULL OR t.due_at >= $2)
            ORDER BY t.due_at LIMIT 25`,
          [u.id, from, to],
        )
      ).rows;
    const overdue = (await list(null, now)).map((t) => ({
      who: first(t.lead),
      what: withoutContacts(t.title),
      when: t.due_at >= start ? clock(t.due_at, u.tz) : dayAndClock(t.due_at, u.tz, now), // the day only when not today
    }));
    const today = (await list(now, end)).map((t) => ({
      who: first(t.lead),
      what: withoutContacts(t.title),
      when: clock(t.due_at, u.tz),
    }));
    const since =
      (
        await client.query<{ at: Date | null }>(
          "SELECT max(sent_at) AS at FROM digest_runs WHERE user_id = $1",
          [u.id],
        )
      ).rows[0]?.at ?? new Date(now.getTime() - 24 * 3_600_000);
    const assigned = Number(
      (
        await client.query<{ n: string }>(
          `SELECT count(DISTINCT h.lead_id) AS n FROM lead_assignment_history h
            WHERE h.to_user_id = $1 AND h.changed_at > $2`,
          [u.id, since],
        )
      ).rows[0]!.n,
    );
    let admin: { unassigned: number; sources: string[] } | null = null;
    if (can(actor, "leads.view", "all")) {
      const unassigned = Number(
        (
          await client.query<{ n: string }>(
            `SELECT count(*) AS n FROM leads l JOIN stages s ON s.id = l.stage_id
              WHERE l.owner_id IS NULL AND l.deleted_at IS NULL AND s.kind = 'open'`,
          )
        ).rows[0]!.n,
      );
      const sources = (
        await client.query<{ name: string }>("SELECT name FROM lead_sources WHERE status = 'needs_attention'")
      ).rows.map((r) => r.name);
      if (unassigned || sources.length) admin = { unassigned, sources };
    }
    await client.query("COMMIT");
    return { overdue, today, assigned, admin };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
