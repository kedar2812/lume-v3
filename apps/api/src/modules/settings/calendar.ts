import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { DEFAULT_CALENDAR_RULES, calendarRulesSchema, type CalendarRules } from "@lume/core";
import { schema } from "@lume/db";

/** Settings → Calendar (5A, spec §2.2): which calendar events are meetings with leads. */
export const calendarBody = z.object({ rules: calendarRulesSchema }).strict();

/** Each word once (any case), trimmed, blanks gone; each calendar once. */
export function tidyRules(r: CalendarRules): CalendarRules {
  const seen = new Set<string>();
  const titleWords = r.titleWords
    .map((w) => w.trim())
    .filter((w) => w && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase()));
  return { attendeeIsLead: r.attendeeIsLead, titleWords, calendarIds: [...new Set(r.calendarIds)] };
}

/** What's saved, over the defaults; `forUpdate` locks the row so two changes can't overwrite each other. */
export async function readCalendarRules(
  req: FastifyRequest,
  o: { forUpdate?: boolean } = {},
): Promise<{ rules: CalendarRules }> {
  const [row] = o.forUpdate
    ? ((await req.db.execute(sql`SELECT calendar FROM settings WHERE id = 1 FOR UPDATE`)).rows as {
        calendar: { rules?: unknown };
      }[])
    : await req.db
        .select({ calendar: schema.settings.calendar })
        .from(schema.settings)
        .where(eq(schema.settings.id, 1));
  const saved = calendarRulesSchema.safeParse(row?.calendar?.rules);
  return { rules: saved.success ? saved.data : DEFAULT_CALENDAR_RULES };
}
