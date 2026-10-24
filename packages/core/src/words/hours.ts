import type { WorkingHours } from "../tasks/time";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday first, Sunday last: the order a working week is said in. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** "10 am", "9:30 am", "12 pm", "12 am". */
function time(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 || h === 24 ? "am" : "pm"}`;
}

function days(ds: number[]): string {
  const on = WEEK.filter((d) => ds.includes(d));
  if (on.length === 7) return "Every day";
  const pos = on.map((d) => WEEK.indexOf(d));
  const run = pos.every((p, i) => i === 0 || p === pos[i - 1]! + 1);
  const names = on.map((d) => DAYS[d]!);
  if (names.length === 1) return names[0]!;
  if (run && names.length > 2) return `${names[0]} to ${names.at(-1)}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The business's working hours in one line (Autopilot's start sheet, spec 2026-10-19 §1.2): "Monday to Saturday, 10 am
 * to 7 pm". Days are said Monday first; a run of three or more is a range.
 */
export function hoursLine(wh: WorkingHours): string {
  if (!wh.days.length) return "No working days set";
  return `${days(wh.days)}, ${time(wh.start)} to ${time(wh.end)}`;
}
