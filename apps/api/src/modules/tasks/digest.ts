import type pg from "pg";
import { can, localDayBounds, mergePreferences } from "@lume/core";
import { applyRequestScope } from "../../db/context";
import { digestMail, type DigestItem } from "../../mail/templates";
import type { Mailer } from "../../mail/mailer";
import { loadActor } from "../../rbac/actor";

export type DigestDeps = { pool: pg.Pool; mailer: Mailer; publicUrl: string };

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
const dayAndClock = (at: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
const first = (name: string) => name.trim().split(/\s+/)[0] || name;

type Person = { id: string; email: string; name: string; preferences: unknown; tz: string };

/**
 * The daily digest (3B Task 4; report §10.7), every 15 minutes: each active person who wants it, on their
 * working days, at or after their digest time in their own timezone, once per their local date. It carries
 * lead first names and times only. A mail that fails leaves no record, so the next run tries again.
 */
export async function runDigests(d: DigestDeps, now: Date = new Date()): Promise<number> {
  const { rows: people } = await d.pool.query<Person>(
    `SELECT u.id, u.email, u.name, u.preferences, coalesce(u.timezone, s.timezone) AS tz
       FROM users u, settings s WHERE s.id = 1 AND u.status = 'active'`,
  );
  const { rows: biz } = await d.pool.query<{ business_name: string }>(
    "SELECT business_name FROM settings WHERE id = 1",
  );
  let mailed = 0;
  for (const u of people) {
    const prefs = mergePreferences(u.preferences, {});
    const w = wall(now, u.tz);
    if (!prefs.alerts.emailDigest || !prefs.workingDays.includes(w.weekday) || w.time < prefs.digestTime)
      continue;
    const done = await d.pool.query("SELECT 1 FROM digest_runs WHERE user_id = $1 AND local_date = $2", [
      u.id,
      w.date,
    ]);
    if (done.rowCount) continue;
    const items = await build(d.pool, u, now);
    const count = items.overdue.length + items.today.length + items.assigned + (items.admin ? 1 : 0);
    try {
      if (count)
        await d.mailer.send(
          digestMail({
            to: u.email,
            firstName: first(u.name),
            businessName: biz[0]?.business_name ?? "LUME",
            url: `${d.publicUrl.replace(/\/$/, "")}/today`,
            ...items,
          }),
        );
    } catch {
      continue; // no record: the next run sends it
    }
    await d.pool.query(
      "INSERT INTO digest_runs (user_id, local_date, items) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [u.id, w.date, count],
    );
    if (count) mailed++;
  }
  return mailed;
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
    const tasks = (
      await client.query<{ lead: string; title: string; due_at: Date }>(
        `SELECT l.name AS lead, t.title, t.due_at FROM tasks t JOIN leads l ON l.id = t.lead_id
          WHERE t.assignee_id = $1 AND t.status = 'open' AND t.due_at < $2 AND l.deleted_at IS NULL
          ORDER BY t.due_at LIMIT 50`,
        [u.id, end],
      )
    ).rows;
    const overdue = tasks
      .filter((t) => t.due_at < now)
      .map((t) => ({
        who: first(t.lead),
        what: t.title,
        when: t.due_at >= start ? clock(t.due_at, u.tz) : dayAndClock(t.due_at, u.tz), // the day only when not today
      }));
    const today = tasks
      .filter((t) => t.due_at >= now)
      .map((t) => ({ who: first(t.lead), what: t.title, when: clock(t.due_at, u.tz) }));
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
