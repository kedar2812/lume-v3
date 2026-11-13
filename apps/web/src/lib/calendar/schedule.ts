import { callStamp, localMoment } from "@lume/core/shared";

/**
 * Schedule a meeting (2026-11-13): the day and time are picked on the business's clock, as the Calendar shows them.
 * The first one offered is the next whole hour today, or 10 am tomorrow once the day is nearly over.
 */
export function defaultStart(now: Date, tz: string): { date: string; time: string } {
  const [date, time] = callStamp(now, tz).split("T") as [string, string];
  const next = Number(time.slice(0, 2)) + 1;
  if (next <= 20) return { date, time: `${String(next).padStart(2, "0")}:00` };
  const tomorrow = callStamp(new Date(now.getTime() + 24 * 3_600_000), tz).split("T")[0]!;
  return { date: tomorrow, time: "10:00" };
}

/** The picked day and time on the business's clock, as a moment (ISO); null when it isn't a real day and time. */
export function startOf(date: string, time: string, tz: string): string | null {
  return localMoment(`${date}T${time}`, tz)?.toISOString() ?? null;
}
