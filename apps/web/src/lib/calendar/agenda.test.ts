import { describe, expect, it } from "vitest";
import type { Actor } from "@lume/core/shared";
import {
  agendaDays,
  dayStart,
  filterMeetings,
  meetingState,
  readCalendarUrl,
  showsEveryone,
  weekBlocks,
  writeCalendarUrl,
} from "./agenda";
import type { Meeting } from "./types";

const TZ = "Asia/Dubai"; // UTC+4, no daylight saving
/** A meeting on the business's clock: "2026-10-01 14:30" for 30 minutes. */
function meet(id: string, local: string, over: Partial<Meeting> = {}, minutes = 30): Meeting {
  const [d, t] = local.split(" ") as [string, string];
  const [y, mo, da] = d.split("-").map(Number) as [number, number, number];
  const [h, mi] = t.split(":").map(Number) as [number, number];
  const start = new Date(Date.UTC(y, mo - 1, da, h - 4, mi));
  return {
    id,
    title: `Call ${id}`,
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
    status: "scheduled",
    link: "https://meet.google.com/abc-defg-hij",
    location: null,
    ownerId: "u-maya",
    matchedBy: "attendee",
    outcomeNote: null,
    lead: { id: `l-${id}`, name: `Lead ${id}`, pipelineId: "p1", stageId: "s-booked" },
    ...over,
  };
}
const at = (local: string) => new Date(meet("x", local).startsAt);

describe("a day on the business's clock", () => {
  it("starts at the business's midnight, whatever zone the browser is in", () => {
    expect(dayStart("2026-10-01", TZ).toISOString()).toBe("2026-09-30T20:00:00.000Z");
  });
});

describe("the agenda", () => {
  const now = at("2026-10-01 08:00");
  const ms = [
    meet("c", "2026-10-02 10:30"),
    meet("a", "2026-10-01 09:00"),
    meet("b", "2026-10-01 14:30"),
    meet("d", "2026-10-05 10:00"),
    meet("e", "2026-10-07 11:00"),
  ];

  it("groups by day from the chosen day on, at most three days that have meetings, earliest first", () => {
    const days = agendaDays(ms, "2026-10-01", TZ, now);
    expect(days.map((d) => d.key)).toEqual(["2026-10-01", "2026-10-02", "2026-10-05"]);
    expect(days[0]!.meetings.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("labels near days in words with the date after them, and other days by their date alone", () => {
    const labels = agendaDays(ms, "2026-10-01", TZ, now).map((d) => d.label);
    expect(labels).toEqual([
      "Today · October 1, Thursday",
      "Tomorrow · October 2, Friday",
      "October 5, Monday",
    ]);
  });

  it("starts from the chosen day, not from today", () => {
    expect(agendaDays(ms, "2026-10-03", TZ, now).map((d) => d.key)).toEqual(["2026-10-05", "2026-10-07"]);
  });

  it("puts an 11:30 pm meeting on its own day, not the next", () => {
    const late = meet("late", "2026-10-01 23:30");
    expect(agendaDays([late], "2026-10-01", TZ, now)[0]!.key).toBe("2026-10-01");
  });
});

describe("a meeting's state", () => {
  const m = meet("b", "2026-10-01 14:30");

  it("is scheduled until 15 minutes before it starts", () => {
    expect(meetingState(m, at("2026-10-01 14:14"))).toBe("scheduled");
  });

  it("is starting soon from 15 minutes before (14:16 for 14:30) until it ends", () => {
    expect(meetingState(m, at("2026-10-01 14:16"))).toBe("soon");
    expect(meetingState(m, at("2026-10-01 14:45"))).toBe("soon");
  });

  it("needs its outcome once it ended with none recorded", () => {
    expect(meetingState(m, at("2026-10-01 15:00"))).toBe("needsOutcome");
  });

  it("is over once an outcome is recorded, and cancelled stays cancelled", () => {
    expect(meetingState({ ...m, status: "completed" }, at("2026-10-01 15:00"))).toBe("over");
    expect(meetingState({ ...m, status: "no_show" }, at("2026-10-01 15:00"))).toBe("over");
    expect(meetingState({ ...m, status: "cancelled" }, at("2026-10-01 14:20"))).toBe("cancelled");
  });
});

describe("filters", () => {
  const ms = [
    meet("mine", "2026-10-01 09:00"),
    meet("ravi", "2026-10-01 10:00", { ownerId: "u-ravi" }),
    meet("won", "2026-10-01 11:00", {
      lead: { id: "l-won", name: "Won lead", pipelineId: "p1", stageId: "s-won" },
    }),
    meet("unlinked", "2026-10-01 12:00", { lead: null }),
  ];

  it("Mine hides other people's meetings", () => {
    expect(filterMeetings(ms, { mineOf: "u-maya", stageId: null }).map((m) => m.id)).toEqual([
      "mine",
      "won",
      "unlinked",
    ]);
  });

  it("a stage keeps only meetings whose lead is in it", () => {
    expect(filterMeetings(ms, { mineOf: null, stageId: "s-won" }).map((m) => m.id)).toEqual(["won"]);
  });

  it("no filter keeps everyone's", () => {
    expect(filterMeetings(ms, { mineOf: null, stageId: null })).toHaveLength(4);
  });
});

describe("Everyone or Mine", () => {
  const actor = (scope: "own" | "team" | "all"): Actor => ({
    userId: "u-maya",
    isOwner: false,
    perms: new Map([["calendar.view", scope]]),
    teamMemberIds: [],
    twoFactorEnabled: true,
    roleIds: [],
  });

  it("is offered only when calendar.view reaches beyond the person's own", () => {
    expect(showsEveryone(actor("own"))).toBe(false);
    expect(showsEveryone(actor("team"))).toBe(true);
    expect(showsEveryone(actor("all"))).toBe(true);
  });
});

describe("the week", () => {
  const week = [
    "2026-09-28",
    "2026-09-29",
    "2026-09-30",
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
  ];

  it("places a meeting on its day and its hour, from 8 am", () => {
    const [b] = weekBlocks([meet("b", "2026-10-01 14:30", {}, 60)], week, TZ);
    expect(b).toMatchObject({ day: 3, top: 6.5 * 60, height: 60, clipped: null });
  });

  it("places an 11:30 pm meeting on its own day, pinned to the grid's end with its time kept", () => {
    const [b] = weekBlocks([meet("late", "2026-10-01 23:30")], week, TZ);
    expect(b).toMatchObject({ day: 3, clipped: "after" });
    expect(b!.top + b!.height).toBeLessThanOrEqual(12 * 60);
  });

  it("pins an early meeting to the start and leaves out other weeks' meetings", () => {
    const blocks = weekBlocks(
      [meet("early", "2026-10-02 07:00"), meet("next", "2026-10-06 10:00")],
      week,
      TZ,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ day: 4, top: 0, clipped: "before" });
  });
});

describe("the address", () => {
  it("round-trips the view, the day and the open meeting", () => {
    const state = { view: "week" as const, day: "2026-10-01", meeting: "m-42" };
    const q = writeCalendarUrl(state);
    expect(q).toBe("?view=week&d=2026-10-01&m=m-42");
    expect(readCalendarUrl(new URLSearchParams(q))).toEqual(state);
  });

  it("leaves defaults out, and ignores what isn't valid", () => {
    expect(writeCalendarUrl({ view: "agenda", day: null, meeting: null })).toBe("");
    expect(readCalendarUrl(new URLSearchParams("view=month&d=yesterday&m="))).toEqual({
      view: "agenda",
      day: null,
      meeting: null,
    });
  });
});
