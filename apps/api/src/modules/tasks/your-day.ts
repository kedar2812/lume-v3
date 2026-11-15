import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { dayBounds } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { badRequest } from "../../http/errors";
import { meetingsBetween } from "./meetings-between";
import { viewsOf } from "./service";

const T = schema.tasks;
const DAY_MS = 86_400_000;
/** How far either side of today a person can look: a year, and a day for the leap. */
const RANGE_DAYS = 366;
/** Today's date on the person's clock (YYYY-MM-DD). */
const dayOf = (at: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
const daysFrom = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** A calendar day that really exists: 2026-02-30 doesn't. */
function realDay(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/**
 * Your day on another day (spec: Your day full screen, Data): the person's own follow-ups due that day, open and done,
 * and their own calls starting that day, both on their clock. It reads as the person (FORCE RLS), so a follow-up is
 * seen exactly when its lead is. It changes nothing.
 */
export async function yourDay(req: FastifyRequest, d: AppDeps, date: string) {
  const actor = req.actor!;
  const { rows } = await req.db.execute<{ tz: string }>(
    sql`SELECT coalesce(u.timezone, s.timezone) AS tz FROM settings s LEFT JOIN users u ON u.id = ${actor.userId} WHERE s.id = 1`,
  );
  const tz = rows[0]?.tz ?? "UTC";
  if (!realDay(date) || Math.abs(daysFrom(dayOf(d.clock(), tz), date)) > RANGE_DAYS)
    throw badRequest("BAD_DATE", "That day can't be shown. Pick a day within a year of today.");
  const { start, end } = dayBounds(date, tz);
  const due = await req.db
    .select()
    .from(T)
    .where(
      and(
        eq(T.assigneeId, actor.userId),
        inArray(T.status, ["open", "done"]),
        gte(T.dueAt, start),
        lt(T.dueAt, end),
      ),
    )
    .orderBy(asc(T.dueAt), asc(T.id))
    .limit(500);
  return {
    date,
    followUps: await viewsOf(req, due),
    meetings: await meetingsBetween(req, actor.userId, start, end),
  };
}
