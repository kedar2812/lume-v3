import type { WorkingHours } from "@lume/core/shared";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The week in the business's order: from its first day (0 = Sunday). */
export const weekFrom = (weekStart: number) => Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);

/** "Monday to Friday, 09:00–18:00", "Every day, …", or "Monday, Wednesday and Friday, …". */
export function hoursInWords(wh: WorkingHours, weekStart = 1): string {
  const order = weekFrom(weekStart).filter((d) => wh.days.includes(d));
  const span = `${wh.start}–${wh.end}`;
  if (order.length === 7) return `Every day, ${span}`;
  const week = weekFrom(weekStart);
  const at = order.map((d) => week.indexOf(d));
  const contiguous = order.length > 2 && at.every((x, i) => i === 0 || x === at[i - 1]! + 1);
  const names = order.map((d) => DAY_NAMES[d]!);
  const days = contiguous
    ? `${names[0]} to ${names.at(-1)}`
    : names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
      : (names[0] ?? "No days");
  return `${days}, ${span}`;
}
