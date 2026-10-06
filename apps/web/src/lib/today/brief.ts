import { dayKey, daysBetween, longDate, timeOf } from "@/lib/dates";
import type { TaskView, TodayMeeting, TodayView } from "@/lib/tasks/types";

/** One piece of LUME's sentence: plain words, or a name that opens its lead (red when it's late, sky for a call). */
export type BriefPart = { text: string; tone?: "bad" | "sky"; leadId?: string };

/** "waiting since yesterday", "waiting since Thursday", "waiting since September 20". */
export function waitedWords(iso: string, now: Date, tz: string): string {
  const at = new Date(iso);
  const days = daysBetween(dayKey(at, tz), dayKey(now, tz));
  if (days <= 1) return "waiting since yesterday";
  if (days < 7) return `waiting since ${longDate(at, tz).split(", ")[1]}`;
  return `waiting since ${longDate(at, tz).split(", ")[0]}`;
}

/** The calls still to come or under way: not cancelled, not moved, not finished. */
export function callsLeft(meetings: TodayMeeting[] | undefined, now: Date): TodayMeeting[] {
  return (meetings ?? [])
    .filter((m) => m.status === "scheduled" && Date.parse(m.endsAt) > now.getTime())
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/**
 * What LUME says first on Today (spec: the header sentence): the first rule that applies wins —
 * 1. a call within 30 minutes (or under way); 2. the oldest overdue follow-up; 3. the next follow-up or call;
 * 4. all clear. People are named, never he or she.
 */
export function brief(v: TodayView, now: Date, tz: string): { parts: BriefPart[]; clear: boolean } {
  const parts: BriefPart[] = [];
  const say = (text: string) => parts.push({ text });
  const name = (t: string, tone?: BriefPart["tone"], leadId?: string) =>
    parts.push({ text: t, ...(tone ? { tone } : {}), ...(leadId ? { leadId } : {}) });
  const calls = callsLeft(v.meetings, now);
  const next = calls[0];
  const first = v.overdue[0];
  const nextFu: TaskView | undefined = v.soon[0] ?? v.later[0];
  const late = (t: TaskView) =>
    dayKey(new Date(t.dueAt), tz) < dayKey(now, tz)
      ? waitedWords(t.dueAt, now, tz)
      : `due at ${timeOf(new Date(t.dueAt), tz)}`;
  const callName = (m: TodayMeeting) => `${m.lead?.name ?? m.title}'s call`;
  const mins = next ? Math.round((Date.parse(next.startsAt) - now.getTime()) / 60_000) : Infinity;

  if (next && mins <= 30) {
    name(callName(next), "sky", next.lead?.id);
    say(mins <= 0 ? " is happening now." : ` is in ${mins} ${mins === 1 ? "minute" : "minutes"}.`);
    if (first) {
      say(" After that, ");
      name(first.leadName, "bad", first.leadId);
      say(`, ${late(first)}.`);
    } else if (nextFu) {
      say(" After that, ");
      name(nextFu.leadName, undefined, nextFu.leadId);
      say(` at ${timeOf(new Date(nextFu.dueAt), tz)}.`);
    }
    return { parts, clear: false };
  }
  if (first) {
    say("Start with ");
    name(first.leadName, "bad", first.leadId);
    say(`, ${late(first)}.`);
    if (next) {
      say(" Then ");
      name(`${callName(next)} at ${timeOf(new Date(next.startsAt), tz)}`, "sky", next.lead?.id);
      say(".");
    }
    return { parts, clear: false };
  }
  if (nextFu || next) {
    say("Nothing overdue. Next up, ");
    if (nextFu) {
      name(nextFu.leadName, undefined, nextFu.leadId);
      say(` at ${timeOf(new Date(nextFu.dueAt), tz)}`);
      if (next) {
        say(", then ");
        name(`${callName(next)} at ${timeOf(new Date(next.startsAt), tz)}`, "sky", next.lead?.id);
      }
    } else if (next) {
      name(`${callName(next)} at ${timeOf(new Date(next.startsAt), tz)}`, "sky", next.lead?.id);
    }
    say(".");
    return { parts, clear: false };
  }
  if (v.total > 0) {
    say("All clear. Everything due today is done.");
    return { parts, clear: true };
  }
  say("Nothing is due today.");
  return { parts, clear: false };
}
