/** The working-day settings as one sentence, so a person can check them without decoding a form. */

const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** The week as people in LUME's markets read it: Monday first, Sunday last. */
const ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

export const DAY_CHIPS = ORDER.map((d) => ({ day: d, label: SHORT[d] }));

/** "18:00" → "6:00 pm". */
export function formatClock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function daysText(days: number[]): string {
  const on = ORDER.filter((d) => days.includes(d));
  if (on.length === 0) return "no days yet";
  if (on.length === 7) return "every day";
  if (on.join() === "1,2,3,4,5") return "Monday to Friday";
  return on.map((d) => SHORT[d]).join(", ");
}

export function dayPreview(days: number[], start: string, end: string, digest: string): string {
  return `Your digest arrives at ${formatClock(digest)}, ${daysText(days)}. Reminders stay between ${formatClock(start)} and ${formatClock(end)}.`;
}
