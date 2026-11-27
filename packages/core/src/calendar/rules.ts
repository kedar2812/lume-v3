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
/** Why a meeting is kept: an invited lead (the rules), or a person linked it by hand ("person"). */
export type MeetingMatch = { leadId: string | null; why: "attendee" | "title" | "calendar" | "person" };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (title: string, word: string) => {
  const w = word.trim().split(/\s+/).map(escape).join("\\s+");
  return w !== "" && new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, "iu").test(title);
};

/**
 * Only leads' calls (owner 2026-11-27: "lume has to fetch data relevant to leads only, nothing else related to current
 * clients or personal details"): an event is a meeting only when an attendee (the organiser counts) is a live lead who
 * wasn't already won when it starts (a customer's session is not a sales call). The title words and calendars only
 * narrow that: when set, the event must also have one of the words / be on one of the calendars. The attendee rule is
 * always on (`attendeeIsLead` is kept for saved settings, never read). `null` means "not a meeting"; `leadsByEmail`
 * holds live leads' emails, lower-cased; `customers` the won leads, with when they were won.
 */
export function matchEvent(
  event: CalendarEvent,
  opts: {
    leadsByEmail: ReadonlyMap<string, string>;
    rules: CalendarRules;
    calendarId: string;
    customers?: ReadonlyMap<string, Date>;
    startsAt?: Date | null;
  },
): MeetingMatch | null {
  const { leadsByEmail, rules, calendarId, customers, startsAt } = opts;
  const people = [...event.attendees, ...(event.organizer ? [event.organizer] : [])];
  const customer = (id: string) => {
    const won = customers?.get(id);
    return !!won && (!startsAt || won.getTime() <= startsAt.getTime());
  };
  const leadId =
    people
      .map((e) => leadsByEmail.get(e.trim().toLowerCase()))
      .find((x): x is string => x !== undefined && !customer(x)) ?? null;
  if (!leadId) return null;
  const words = rules.titleWords.filter((w) => w.trim() !== "");
  if (words.length && !words.some((w) => hasWord(event.title, w))) return null;
  if (rules.calendarIds.length && !rules.calendarIds.includes(calendarId)) return null;
  return { leadId, why: "attendee" };
}
