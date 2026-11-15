import { dateTime, dayKey, timeOf } from "@/lib/dates";
import type { TaskView, TodayMeeting, TodayView } from "@/lib/tasks/types";

/**
 * Your day as one list of things (spec: Your day full screen, "Kinds of thing on the day"). The card, the full-screen
 * timeline, the list, Show and the details panel all read this list, so a kind added here shows everywhere.
 */
export type DayKind = "call" | "follow_up";
export const KINDS: { kind: DayKind; label: "Calls" | "Follow-ups" }[] = [
  { kind: "call", label: "Calls" },
  { kind: "follow_up", label: "Follow-ups" },
];

export type DayState = "over" | "soon" | "later" | "planned" | "done";

export type DayItem = {
  id: string;
  kind: DayKind;
  /** When it is: a follow-up's due time, a call's start. */
  at: string;
  endsAt: string | null;
  title: string;
  lead: { id: string; name: string } | null;
  state: DayState;
  link: string | null;
  /** A follow-up due before the day shown (today only): the "from before" pile. */
  before: boolean;
};

export type DoneFollowUp = { id: string; title: string; dueAt: string; leadId: string; leadName: string };
/** What one day is made of: open follow-ups, done follow-ups and calls. */
export type DayData = { followUps: TaskView[]; doneFollowUps: DoneFollowUp[]; meetings: TodayMeeting[] };

const SOON_MS = 2 * 3_600_000;

/** Minutes since local midnight: the wall clock, so a daylight-saving day still reads 0–1440. */
export function minuteOf(iso: string | Date, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute);
}

/** Today's data as a day: what the Today page already loaded. */
export function fromToday(v: TodayView): DayData {
  return {
    followUps: [...v.overdue, ...v.soon, ...v.later],
    doneFollowUps: v.doneToday ?? [],
    meetings: v.meetings ?? [],
  };
}

/** Every thing on `day` (YYYY-MM-DD in `tz`), in time order, with where it stands at `now`. */
export function dayItems(d: DayData, day: string, now: Date, tz: string): DayItem[] {
  const today = dayKey(now, tz);
  const t = now.getTime();
  const clock = (iso: string): DayState =>
    day > today
      ? "planned"
      : Date.parse(iso) < t
        ? "over"
        : Date.parse(iso) < t + SOON_MS
          ? "soon"
          : day === today
            ? "later"
            : "planned";
  const items: DayItem[] = [];
  for (const f of d.followUps) {
    const k = dayKey(new Date(f.dueAt), tz);
    const before = day === today && k < day;
    if (k !== day && !before) continue;
    items.push({
      id: f.id,
      kind: "follow_up",
      at: f.dueAt,
      endsAt: null,
      title: f.title,
      lead: { id: f.leadId, name: f.leadName },
      state: before ? "over" : clock(f.dueAt),
      link: null,
      before,
    });
  }
  for (const f of d.doneFollowUps) {
    if (dayKey(new Date(f.dueAt), tz) !== day) continue;
    items.push({
      id: f.id,
      kind: "follow_up",
      at: f.dueAt,
      endsAt: null,
      title: f.title,
      lead: { id: f.leadId, name: f.leadName },
      state: "done",
      link: null,
      before: false,
    });
  }
  for (const m of d.meetings) {
    if (m.status !== "scheduled" && m.status !== "completed") continue;
    if (dayKey(new Date(m.startsAt), tz) !== day) continue;
    const ended = m.status === "completed" || Date.parse(m.endsAt) <= t;
    items.push({
      id: m.id,
      kind: "call",
      at: m.startsAt,
      endsAt: m.endsAt,
      title: m.title,
      lead: m.lead,
      state: ended ? "done" : clock(m.startsAt),
      link: m.link,
      before: false,
    });
  }
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}

/** The day's span in minutes: 8 am to 9 pm, widened to whole hours for anything earlier or later. */
export function daySpan(items: DayItem[], tz: string): { from: number; to: number } {
  const mins = items.filter((i) => !i.before).map((i) => minuteOf(i.at, tz));
  return {
    from: Math.min(8 * 60, ...mins.map((m) => Math.floor(m / 60) * 60)),
    to: Math.max(21 * 60, ...mins.map((m) => Math.min(24 * 60, Math.ceil((m + 1) / 60) * 60))),
  };
}

const STATE: Record<DayState, { label: string; tone: "danger" | "warn" | "accent" | "ok" | "quiet" }> = {
  over: { label: "Overdue", tone: "danger" },
  soon: { label: "Due soon", tone: "warn" },
  later: { label: "Later today", tone: "accent" },
  planned: { label: "Planned", tone: "quiet" },
  done: { label: "Done", tone: "ok" },
};

export type Panel = {
  heading: string;
  who: string | null;
  time: string;
  state: { label: string; tone: "danger" | "warn" | "accent" | "ok" | "quiet" } | null;
  actions: ("join" | "open")[];
};

/** What the details panel says and offers for one item: the same on the card, the timeline and anywhere else. */
export function panelOf(item: DayItem, now: Date, tz: string): Panel {
  if (item.kind === "call") {
    const actions: Panel["actions"] = [];
    if (item.link && item.state !== "done") actions.push("join");
    if (item.lead) actions.push("open");
    return {
      heading: item.title,
      who: item.lead?.name ?? null,
      time: `${timeOf(new Date(item.at), tz)} – ${timeOf(new Date(item.endsAt ?? item.at), tz)}`,
      state: null,
      actions,
    };
  }
  return {
    heading: item.title,
    who: item.lead?.name ?? null,
    time: item.before ? dateTime(new Date(item.at), tz) : timeOf(new Date(item.at), tz),
    state: STATE[item.state],
    actions: item.lead ? ["open"] : [],
  };
}

/** Where a click on an item goes. */
export function openOf(item: DayItem, now: Date): { href: string; external: boolean } {
  if (item.kind === "call") {
    const ended = item.state === "done" || (item.endsAt != null && Date.parse(item.endsAt) <= now.getTime());
    if (item.link && !ended) return { href: item.link, external: true };
    if (!item.lead) return { href: `/calendar?m=${item.id}`, external: false };
  }
  return { href: `/leads?lead=${item.lead?.id ?? ""}`, external: false };
}

/** The list view's groups, in order, leaving out empty ones. */
export function listGroups(
  items: DayItem[],
  mode: "today" | "past" | "future",
): { name: string; items: DayItem[] }[] {
  const done = (i: DayItem) => i.state === "done";
  const groups: [string, (i: DayItem) => boolean][] =
    mode === "today"
      ? [
          ["Overdue", (i) => i.state === "over"],
          ["Coming up", (i) => !done(i) && i.state !== "over"],
          ["Done", done],
        ]
      : mode === "past"
        ? [
            ["Not done", (i) => !done(i)],
            ["Done", done],
          ]
        : [
            ["Planned", (i) => !done(i)],
            ["Done", done],
          ];
  return groups.map(([name, fn]) => ({ name, items: items.filter(fn) })).filter((g) => g.items.length > 0);
}
