import { dayKey } from "@/lib/dates";
import type { TaskView, TodayMeeting, TodayView } from "@/lib/tasks/types";

/** Minutes since local midnight. */
function minuteOf(d: Date, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute);
}

export type DayDot = {
  id: string;
  leadId: string;
  leadName: string;
  title: string;
  dueAt: string;
  left: number;
  state: "done" | "over" | "soon" | "later";
};
export type DayCall = { id: string; m: TodayMeeting; left: number; done: boolean; next: boolean };

/**
 * Your day on one line (spec: Your day): 8 am to 9 pm, widened to fit anything earlier or later today. Calls that
 * still stand sit above it (held ones greyed); follow-ups due today sit on it by where they stand; ones from before
 * today are counted at its start, not placed.
 */
export function dayline(v: TodayView, now: Date, tz: string) {
  const today = dayKey(now, tz);
  const isToday = (iso: string) => dayKey(new Date(iso), tz) === today;
  const calls = (v.meetings ?? []).filter((m) => m.status === "scheduled" || m.status === "completed");
  const open = [...v.overdue, ...v.soon, ...v.later];
  const todays = open.filter((t) => isToday(t.dueAt));
  const done = (v.doneToday ?? []).filter((t) => isToday(t.dueAt));
  const mins = [
    ...todays.map((t) => t.dueAt),
    ...done.map((t) => t.dueAt),
    ...calls.map((m) => m.startsAt),
  ].map((x) => minuteOf(new Date(x), tz));
  const from = Math.min(8 * 60, ...mins.map((m) => Math.floor(m / 60) * 60));
  const to = Math.max(21 * 60, ...mins.map((m) => Math.min(24 * 60, Math.ceil((m + 1) / 60) * 60)));
  const left = (iso: string | Date) => ((minuteOf(new Date(iso), tz) - from) / (to - from)) * 100;
  const soonEnd = now.getTime() + 2 * 3_600_000;
  const state = (t: TaskView): DayDot["state"] =>
    Date.parse(t.dueAt) < now.getTime() ? "over" : Date.parse(t.dueAt) < soonEnd ? "soon" : "later";
  const dots: DayDot[] = [
    ...done.map((t) => ({ ...t, left: left(t.dueAt), state: "done" as const })),
    ...todays.map((t) => ({
      id: t.id,
      leadId: t.leadId,
      leadName: t.leadName,
      title: t.title,
      dueAt: t.dueAt,
      left: left(t.dueAt),
      state: state(t),
    })),
  ].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  const upcoming = calls.filter((m) => m.status === "scheduled" && Date.parse(m.endsAt) > now.getTime());
  const nextId = upcoming.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0]?.id;
  return {
    from,
    to,
    now: left(now),
    hours: Array.from({ length: (to - from) / 60 + 1 }, (_, i) => from / 60 + i).map((h) => ({
      h,
      left: ((h * 60 - from) / (to - from)) * 100,
      label:
        h % 12 === 0
          ? h === 12
            ? "12 pm"
            : "12 am"
          : h === from / 60 || h === to / 60
            ? `${h % 12} ${h < 12 ? "am" : "pm"}`
            : String(h % 12),
    })),
    dots,
    calls: calls
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      .map((m) => ({
        id: m.id,
        m,
        left: left(m.startsAt),
        done: m.status === "completed" || Date.parse(m.endsAt) <= now.getTime(),
        next: m.id === nextId,
      })),
    older: v.overdue.filter((t) => !isToday(t.dueAt)),
  };
}
