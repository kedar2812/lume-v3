import { z } from "zod";

/** Settings → Calendar (spec 2026-10-01-phase-5 §2.2): which calendar events are meetings with leads. */
export const calendarRulesSchema = z
  .object({
    /** 1. An attendee's email is a lead's. */
    attendeeIsLead: z.boolean(),
    /** 2. The title has one of these words or phrases (whole words, any case). */
    titleWords: z.array(z.string().max(100)).max(50),
    /** 3. Every event on these calendars (Google calendar ids). */
    calendarIds: z.array(z.string().min(1).max(300)).max(50),
  })
  .strict();
export type CalendarRules = z.infer<typeof calendarRulesSchema>;
export type CalendarSettings = { rules: CalendarRules };

export const DEFAULT_CALENDAR_RULES: CalendarRules = {
  attendeeIsLead: true,
  titleWords: [],
  calendarIds: [],
};

/** What the rules need of an event: never stored unless they keep it. */
export type CalendarEvent = { title: string; organizer?: string | null; attendees: string[] };
export type MeetingMatch = { leadId: string | null; why: "attendee" | "title" | "calendar" };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (title: string, word: string) => {
  const w = word.trim().split(/\s+/).map(escape).join("\\s+");
  return w !== "" && new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, "iu").test(title);
};

/**
 * The rules in order: an attendee who is a lead, a title word, a chosen calendar. A kept event is linked to
 * the first attendee (the organiser counts) who is a lead, whichever rule kept it; `null` means "not a meeting".
 * `leadsByEmail` holds live leads' emails, lower-cased.
 */
export function matchEvent(
  event: CalendarEvent,
  opts: { leadsByEmail: ReadonlyMap<string, string>; rules: CalendarRules; calendarId: string },
): MeetingMatch | null {
  const { leadsByEmail, rules, calendarId } = opts;
  const people = [...event.attendees, ...(event.organizer ? [event.organizer] : [])];
  const leadId =
    people.map((e) => leadsByEmail.get(e.trim().toLowerCase())).find((x) => x !== undefined) ?? null;
  if (rules.attendeeIsLead && leadId) return { leadId, why: "attendee" };
  if (rules.titleWords.some((w) => hasWord(event.title, w))) return { leadId, why: "title" };
  if (rules.calendarIds.includes(calendarId)) return { leadId, why: "calendar" };
  return null;
}
