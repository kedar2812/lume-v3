import { dayKey, longDate, timeOf } from "@/lib/dates";
import type { AiPause, Applied, Part } from "./types";

const weekday = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d);

/** "3:40 pm" today, "tomorrow 12:10 am", or "Monday 12 am" further on: when a limit resets, on the person's clock. */
export function resetWords(iso: string, tz: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((Date.parse(dayKey(d, tz)) - Date.parse(dayKey(now, tz))) / 86_400_000);
  return days <= 0
    ? timeOf(d, tz)
    : days === 1
      ? `tomorrow ${timeOf(d, tz)}`
      : `${weekday(d, tz)} ${timeOf(d, tz)}`;
}

/** "LUME AI has reached this hour's limit. It's back at 3:40 pm." — and the week's, back on its day. */
export function pausedWords(p: AiPause, tz: string, now: Date = new Date()): string {
  if (p.by === "week")
    return `LUME AI has reached this week's limit. It's back ${weekday(new Date(p.until), tz)}.`;
  const when = resetWords(p.until, tz, now);
  return `LUME AI has reached this hour's limit. It's back ${when.startsWith("tomorrow") ? when : `at ${when}`}.`;
}

/** "October 24, Saturday at 11 am": a suggested follow-up, on the person's clock. */
export function dueWords(iso: string, tz: string): string {
  const d = new Date(iso);
  return `${longDate(d, tz)} at ${timeOf(d, tz)}`;
}

/** "a", "a and b", "a, b and c". */
const listed = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
const sentence = (t: string) => `${t.charAt(0).toUpperCase()}${t.slice(1)}.`;

/** What a suggestion's parts are called: the stage's name, when the follow-up is, the tags' labels. */
export type PartNames = { stage: string | null; when: string | null; tags: string[] };

/**
 * After Apply (spec 2026-10-18 §5.2): one sentence for everything done, and one line per part that wasn't, with the
 * API's own reason — "Moved to Site visit booked and set a follow-up for October 24, Saturday at 11 am."
 */
export function appliedWords(r: Applied, n: PartNames): { done: string | null; skipped: string[] } {
  const done: Record<Part, string> = {
    stage: `moved to ${n.stage}`,
    followUp: `set a follow-up for ${n.when}`,
    tags: `added the ${n.tags.length === 1 ? "tag" : "tags"} ${listed(n.tags)}`,
  };
  const not: Record<Part, string> = {
    stage: "The stage wasn't changed.",
    followUp: "The follow-up wasn't set.",
    tags: n.tags.length === 1 ? "The tag wasn't added." : "The tags weren't added.",
  };
  return {
    done: r.applied.length ? sentence(listed(r.applied.map((p) => done[p]))) : null,
    skipped: r.skipped.map((x) => `${not[x.part]} ${x.why}`),
  };
}
