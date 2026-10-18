import { dayKey, timeOf } from "@/lib/dates";
import type { AiPause } from "./types";

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
