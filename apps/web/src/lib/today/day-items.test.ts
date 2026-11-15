import { describe, expect, it } from "vitest";
import type { TaskView, TodayMeeting, TodayView } from "@/lib/tasks/types";
import {
  KINDS,
  dayItems,
  daySpan,
  fromToday,
  listGroups,
  minuteOf,
  openOf,
  panelOf,
  type DayData,
  type DayItem,
} from "./day-items";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-05T06:10:00Z"); // 11:40 am in Kolkata
const DAY = "2026-10-05";
/** A wall-clock time in Kolkata on a day of October 2026, as an ISO instant. */
const at = (hh: number, mm = 0, d = 5) => new Date(Date.UTC(2026, 9, d, hh, mm) - 330 * 60_000).toISOString();
const task = (id: string, dueAt: string, title = `Task ${id}`, leadName = `Lead ${id}`): TaskView => ({
  id,
  leadId: `l-${id}`,
  leadName,
  title,
  note: null,
  dueAt,
  status: "open",
  remindMinutes: [0],
  recurrence: null,
  assignee: { id: "u-me", name: "Maya Kapoor" },
  createdBy: null,
  doneAt: null,
  canEdit: true,
});
const meeting = (id: string, start: string, end: string, more: Partial<TodayMeeting> = {}): TodayMeeting => ({
  id,
  title: `Call ${id}`,
  startsAt: start,
  endsAt: end,
  link: "https://meet.example/abc",
  status: "scheduled",
  lead: { id: `l-${id}`, name: `Lead ${id}` },
  matchedBy: "calendar",
  reminder: null,
  ...more,
});
const data = (over: Partial<DayData> = {}): DayData => ({ followUps: [], doneFollowUps: [], meetings: [], ...over });
const byId = (xs: DayItem[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

describe("dayItems: one list of things on the day, of a few kinds", () => {
  it("two kinds, calls first: the rows and the Show choices come from this list", () => {
    expect(KINDS).toEqual([
      { kind: "call", label: "Calls" },
      { kind: "follow_up", label: "Follow-ups" },
    ]);
  });

  it("states on today: overdue, due within two hours, later today, done", () => {
    const items = dayItems(
      data({
        followUps: [task("a", at(10, 40)), task("b", at(12, 40)), task("c", at(16, 40))],
        doneFollowUps: [{ id: "d", title: "Sent", dueAt: at(9), leadId: "l-d", leadName: "Lead d" }],
      }),
      DAY,
      NOW,
      TZ,
    );
    expect(items.map((i) => [i.id, i.state])).toEqual([
      ["d", "done"],
      ["a", "over"],
      ["b", "soon"],
      ["c", "later"],
    ]);
    expect(byId(items).a).toMatchObject({ kind: "follow_up", title: "Task a", lead: { id: "l-a", name: "Lead a" } });
  });

  it("an open follow-up on a future day is planned, on a past day overdue", () => {
    const tomorrow = dayItems(data({ followUps: [task("t", at(9, 0, 6))] }), "2026-10-06", NOW, TZ);
    expect(tomorrow[0]!.state).toBe("planned");
    const yesterday = dayItems(data({ followUps: [task("y", at(9, 0, 4))] }), "2026-10-04", NOW, TZ);
    expect(yesterday[0]!.state).toBe("over");
  });

  it("a call that ended is done and loses Join; held and cancelled calls stay off the day", () => {
    const items = dayItems(
      data({
        meetings: [
          meeting("over", at(9), at(9, 30)),
          meeting("next", at(15, 30), at(16)),
          meeting("held", at(17), at(17, 30), { status: "no_show" }),
          meeting("gone", at(18), at(18, 30), { status: "cancelled" }),
        ],
      }),
      DAY,
      NOW,
      TZ,
    );
    expect(items.map((i) => i.id)).toEqual(["over", "next"]);
    expect(byId(items).over!.state).toBe("done");
    expect(panelOf(byId(items).over!, NOW, TZ).actions).toEqual(["open"]);
    expect(panelOf(byId(items).next!, NOW, TZ).actions).toEqual(["join", "open"]);
  });

  it("follow-ups from before today are flagged `before` on today only, and left out of the span", () => {
    const d = data({ followUps: [task("old", at(9, 0, 2)), task("now", at(14))] });
    const items = dayItems(d, DAY, NOW, TZ);
    expect(byId(items).old).toMatchObject({ before: true, state: "over" });
    expect(byId(items).now!.before).toBe(false);
    expect(daySpan(items, TZ)).toEqual({ from: 8 * 60, to: 21 * 60 });
    // On another day there's no pile: something due on the 2nd isn't on the 4th.
    expect(dayItems(d, "2026-10-04", NOW, TZ)).toEqual([]);
  });

  it("the span is 8 am to 9 pm, widened to whole hours for anything earlier or later", () => {
    const items = dayItems(data({ followUps: [task("e", at(7, 15)), task("l", at(22, 10))] }), DAY, NOW, TZ);
    expect(daySpan(items, TZ)).toEqual({ from: 7 * 60, to: 23 * 60 });
  });

  it("wall clock on a DST day: 2:30 am in London on its 25-hour day is minute 150", () => {
    expect(minuteOf("2026-10-25T02:30:00Z", "Europe/London")).toBe(150);
    expect(minuteOf("2026-10-25T00:30:00Z", "Europe/London")).toBe(90); // 1:30 BST, the first time round
  });

  it("fromToday: Today's open follow-ups, what was done today, and its calls", () => {
    const v: TodayView = {
      overdue: [task("o", at(9))],
      soon: [task("s", at(12))],
      later: [task("l", at(18))],
      done: 1,
      total: 4,
      meetings: [meeting("m", at(15), at(15, 30))],
      doneToday: [{ id: "d", title: "Done one", dueAt: at(8), leadId: "l-d", leadName: "Lead d" }],
    };
    const d = fromToday(v);
    expect(d.followUps.map((t) => t.id)).toEqual(["o", "s", "l"]);
    expect(d.doneFollowUps.map((t) => t.id)).toEqual(["d"]);
    expect(d.meetings.map((m) => m.id)).toEqual(["m"]);
  });
});

describe("panelOf: the one panel, wherever it shows", () => {
  const items = dayItems(
    data({ followUps: [task("p", at(12, 30), "Send pricing PDF", "Priya Sharma")] }),
    DAY,
    NOW,
    TZ,
  );

  it("a follow-up: its words, the lead, the time, the state and Open lead", () => {
    expect(panelOf(items[0]!, NOW, TZ)).toEqual({
      heading: "Send pricing PDF",
      who: "Priya Sharma",
      time: "12:30 pm",
      state: { label: "Due soon", tone: "warn" },
      actions: ["open"],
    });
  });

  it("is the same for the same item every time it's asked", () => {
    expect(panelOf(items[0]!, NOW, TZ)).toEqual(panelOf(items[0]!, NOW, TZ));
  });

  it("each state's words and tone", () => {
    const states = dayItems(
      data({
        followUps: [task("o", at(10)), task("s", at(12)), task("l", at(18))],
        doneFollowUps: [{ id: "d", title: "x", dueAt: at(9), leadId: "l-d", leadName: "Lead d" }],
      }),
      DAY,
      NOW,
      TZ,
    ).map((i) => panelOf(i, NOW, TZ).state);
    expect(states).toEqual([
      { label: "Done", tone: "ok" },
      { label: "Overdue", tone: "danger" },
      { label: "Due soon", tone: "warn" },
      { label: "Later today", tone: "accent" },
    ]);
    const planned = dayItems(data({ followUps: [task("t", at(9, 0, 6))] }), "2026-10-06", NOW, TZ)[0]!;
    expect(panelOf(planned, NOW, TZ).state).toEqual({ label: "Planned", tone: "quiet" });
  });

  it("one from before today shows its date with the time", () => {
    const old = dayItems(data({ followUps: [task("old", at(16, 0, 3))] }), DAY, NOW, TZ)[0]!;
    expect(panelOf(old, NOW, TZ).time).toBe("Oct 3, Sat, 4 pm");
  });

  it("a call: its title, who it's with, start to end, no state", () => {
    const call = dayItems(data({ meetings: [meeting("c", at(15, 30), at(16))] }), DAY, NOW, TZ)[0]!;
    expect(panelOf(call, NOW, TZ)).toEqual({
      heading: "Call c",
      who: "Lead c",
      time: "3:30 pm – 4 pm",
      state: null,
      actions: ["join", "open"],
    });
  });

  it("a call with no lead and no link has nothing to press but still opens in Calendar", () => {
    const call = dayItems(
      data({ meetings: [meeting("c", at(15), at(15, 30), { lead: null, link: null })] }),
      DAY,
      NOW,
      TZ,
    )[0]!;
    expect(panelOf(call, NOW, TZ)).toMatchObject({ who: null, actions: [] });
    expect(openOf(call, NOW)).toEqual({ href: "/calendar?m=c", external: false });
  });
});

describe("openOf: what a click opens", () => {
  const items = byId(
    dayItems(
      data({
        followUps: [task("f", at(14))],
        meetings: [
          meeting("join", at(15), at(15, 30)),
          meeting("ended", at(9), at(9, 30)),
          meeting("nolink", at(17), at(17, 30), { link: null }),
        ],
      }),
      DAY,
      NOW,
      TZ,
    ),
  );

  it("a follow-up opens its lead", () => {
    expect(openOf(items.f!, NOW)).toEqual({ href: "/leads?lead=l-f", external: false });
  });
  it("an upcoming call with a link joins it", () => {
    expect(openOf(items.join!, NOW)).toEqual({ href: "https://meet.example/abc", external: true });
  });
  it("an ended call, or one with no link, opens its lead", () => {
    expect(openOf(items.ended!, NOW)).toEqual({ href: "/leads?lead=l-ended", external: false });
    expect(openOf(items.nolink!, NOW)).toEqual({ href: "/leads?lead=l-nolink", external: false });
  });
});

describe("listGroups", () => {
  const items = dayItems(
    data({
      followUps: [task("o", at(10)), task("l", at(18)), task("s", at(12))],
      doneFollowUps: [{ id: "d", title: "x", dueAt: at(9), leadId: "l-d", leadName: "Lead d" }],
      meetings: [meeting("c", at(15), at(15, 30))],
    }),
    DAY,
    NOW,
    TZ,
  );

  it("today: Overdue, Coming up, Done, each in time order", () => {
    expect(listGroups(items, "today").map((g) => [g.name, g.items.map((i) => i.id)])).toEqual([
      ["Overdue", ["o"]],
      ["Coming up", ["s", "c", "l"]],
      ["Done", ["d"]],
    ]);
  });

  it("a past day: Not done, Done; a future day: Planned; no empty group", () => {
    expect(listGroups(items, "past").map((g) => g.name)).toEqual(["Not done", "Done"]);
    const future = dayItems(data({ followUps: [task("t", at(9, 0, 6))] }), "2026-10-06", NOW, TZ);
    expect(listGroups(future, "future").map((g) => g.name)).toEqual(["Planned"]);
    expect(listGroups([], "today")).toEqual([]);
  });
});
