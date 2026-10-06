import type { WorkingHours } from "@lume/core/shared";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The week in the business's order: from its first day (0 = Sunday). */
export const weekFrom = (weekStart: number) => Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);

/** "10 am", "7:30 pm", "12 pm"; the day's last minute is midnight. The way LUME says a time everywhere. */
export function timeWords(t: string): string {
  if (t === "23:59" || t === "24:00") return "midnight";
  const [h = 0, m = 0] = t.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

/** "Monday to Friday, 9 am – 6 pm", "Every day, …", or "Monday, Wednesday and Friday, …". */
export function hoursInWords(wh: WorkingHours, weekStart = 1): string {
  const order = weekFrom(weekStart).filter((d) => wh.days.includes(d));
  const span = `${timeWords(wh.start)} – ${timeWords(wh.end)}`;
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
