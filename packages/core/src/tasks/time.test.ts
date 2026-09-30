import { describe, expect, it } from "vitest";
import {
  DEFAULT_DUE_PRESETS,
  dueFromPreset,
  dueFromPresetDef,
  shiftToWorkingHours,
  type DuePresetDef,
  localDayBounds,
  nextOccurrence,
  reminderTimes,
  snoozeUntil,
  wallTime,
  type Recurrence,
} from "./time";

const at = (iso: string) => new Date(iso);
const DUBAI = "Asia/Dubai"; // UTC+4, no DST
const KOLKATA = "Asia/Kolkata"; // UTC+5:30, no DST
const LONDON = "Europe/London"; // GMT/BST

describe("wallTime", () => {
  it("is the instant a local time happens", () => {
    expect(wallTime(2026, 9, 28, 10, 0, DUBAI).toISOString()).toBe("2026-09-28T06:00:00.000Z");
    expect(wallTime(2026, 9, 28, 10, 0, KOLKATA).toISOString()).toBe("2026-09-28T04:30:00.000Z");
    expect(wallTime(2026, 7, 1, 10, 0, LONDON).toISOString()).toBe("2026-07-01T09:00:00.000Z");
    expect(wallTime(2026, 12, 1, 10, 0, LONDON).toISOString()).toBe("2026-12-01T10:00:00.000Z");
  });

  it("a time in the spring gap moves forward to the first valid minute", () => {
    // 2026-03-29: London jumps from 01:00 GMT to 02:00 BST, so 01:30 never happens.
    expect(wallTime(2026, 3, 29, 1, 30, LONDON).toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });

  it("an ambiguous autumn time takes the earlier", () => {
    // 2026-10-25: 01:30 happens twice in London (BST, then GMT); the first is 00:30Z.
    expect(wallTime(2026, 10, 25, 1, 30, LONDON).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("dueFromPreset", () => {
  const now = at("2026-09-28T08:15:00Z"); // Monday: 12:15 in Dubai, 13:45 in Kolkata, 09:15 in London
  it("in 1 hour, in 3 hours and in 2 days are plain durations", () => {
    expect(dueFromPreset("in_1h", now, DUBAI).toISOString()).toBe("2026-09-28T09:15:00.000Z");
    expect(dueFromPreset("in_3h", now, DUBAI).toISOString()).toBe("2026-09-28T11:15:00.000Z");
    expect(dueFromPreset("in_2d", now, DUBAI).toISOString()).toBe("2026-09-30T08:15:00.000Z");
  });

  it("in 2 days is the same clock time two days on, even across a clock change", () => {
    // Friday 23 Oct 2026 09:15 in London (BST); the clocks go back on Sunday 25 Oct.
    const fri = at("2026-10-23T08:15:00Z");
    expect(dueFromPreset("in_2d", fri, LONDON).toISOString()).toBe("2026-10-25T09:15:00.000Z");
    expect(
      dueFromPresetDef(
        { id: "x", label: "In 3 days", rule: { in: { n: 3, unit: "day" } } },
        fri,
        LONDON,
      ).toISOString(),
    ).toBe("2026-10-26T09:15:00.000Z");
  });

  it("tomorrow 10:00 is 10:00 in each person's own day", () => {
    expect(dueFromPreset("tomorrow_10", now, DUBAI).toISOString()).toBe("2026-09-29T06:00:00.000Z");
    expect(dueFromPreset("tomorrow_10", now, KOLKATA).toISOString()).toBe("2026-09-29T04:30:00.000Z");
    expect(dueFromPreset("tomorrow_10", now, LONDON).toISOString()).toBe("2026-09-29T09:00:00.000Z");
  });

  it("Review Focus 3: tomorrow 10:00 across the autumn change is 10:00 on the new clock", () => {
    const saturday = at("2026-10-24T11:00:00Z"); // 12:00 BST
    expect(dueFromPreset("tomorrow_10", saturday, LONDON).toISOString()).toBe("2026-10-25T10:00:00.000Z");
  });

  it("next Monday from a Monday is the following Monday, at 10:00", () => {
    expect(dueFromPreset("next_monday", now, DUBAI).toISOString()).toBe("2026-10-05T06:00:00.000Z");
    const friday = at("2026-10-02T08:00:00Z");
    expect(dueFromPreset("next_monday", friday, DUBAI).toISOString()).toBe("2026-10-05T06:00:00.000Z");
  });

  it("'tomorrow' is the person's tomorrow even just before their midnight", () => {
    const lateDubai = at("2026-09-28T19:50:00Z"); // 23:50 in Dubai, still the 28th there
    expect(dueFromPreset("tomorrow_10", lateDubai, DUBAI).toISOString()).toBe("2026-09-29T06:00:00.000Z");
    const pastMidnight = at("2026-09-28T20:10:00Z"); // 00:10 on the 29th in Dubai
    expect(dueFromPreset("tomorrow_10", pastMidnight, DUBAI).toISOString()).toBe("2026-09-30T06:00:00.000Z");
  });
});

describe("snoozeUntil", () => {
  it("15 minutes and an hour", () => {
    const now = at("2026-09-28T08:00:00Z");
    expect(snoozeUntil("15m", now, DUBAI).toISOString()).toBe("2026-09-28T08:15:00.000Z");
    expect(snoozeUntil("1h", now, DUBAI).toISOString()).toBe("2026-09-28T09:00:00.000Z");
  });

  it("this evening is 18:00 today, or tomorrow's once it's past 17:30", () => {
    expect(snoozeUntil("evening", at("2026-09-28T09:00:00Z"), DUBAI).toISOString()).toBe(
      "2026-09-28T14:00:00.000Z",
    );
    expect(snoozeUntil("evening", at("2026-09-28T13:45:00Z"), DUBAI).toISOString()).toBe(
      "2026-09-29T14:00:00.000Z",
    );
  });

  it("tomorrow morning is 09:00 tomorrow", () => {
    expect(snoozeUntil("tomorrow_morning", at("2026-09-28T09:00:00Z"), KOLKATA).toISOString()).toBe(
      "2026-09-29T03:30:00.000Z",
    );
  });
});

describe("reminderTimes", () => {
  const due = at("2026-09-28T10:00:00Z");
  it("sorted, without repeats, soonest-before first", () => {
    expect(reminderTimes(due, [60, 0, 15, 60])).toEqual([
      { offset: 60, at: at("2026-09-28T09:00:00Z") },
      { offset: 15, at: at("2026-09-28T09:45:00Z") },
      { offset: 0, at: due },
    ]);
  });

  it("at most five, and only offsets from the time itself up to 30 days before", () => {
    expect(reminderTimes(due, [0, 5, 10, 15, 30, 30]).map((r) => r.offset)).toEqual([30, 15, 10, 5, 0]);
    expect(() => reminderTimes(due, [0, 5, 10, 15, 30, 60])).toThrow(/five/);
    expect(() => reminderTimes(due, [-5])).toThrow(/offset/);
    expect(() => reminderTimes(due, [43_201])).toThrow(/offset/);
    expect(() => reminderTimes(due, [1.5])).toThrow(/offset/);
  });
});

describe("nextOccurrence", () => {
  const weekly: Recurrence = { every: 1, unit: "week", until: null, stopOn: [] };
  it("a weekly repeat keeps 10:00 local across the autumn change", () => {
    const due = at("2026-10-19T09:00:00Z"); // Monday 10:00 BST
    const next = nextOccurrence(due, weekly, at("2026-10-19T09:30:00Z"), LONDON);
    expect(next?.toISOString()).toBe("2026-10-26T10:00:00.000Z"); // Monday 10:00 GMT
  });

  it("every 3 days, from a follow-up done on time", () => {
    const due = at("2026-09-28T06:00:00Z");
    const next = nextOccurrence(due, { every: 3, unit: "day", until: null, stopOn: [] }, due, DUBAI);
    expect(next?.toISOString()).toBe("2026-10-01T06:00:00.000Z");
  });

  it("a series three weeks overdue moves to the next step after now, not into the past", () => {
    const due = at("2026-09-07T06:00:00Z");
    const next = nextOccurrence(due, weekly, at("2026-09-28T08:00:00Z"), DUBAI);
    expect(next?.toISOString()).toBe("2026-10-05T06:00:00.000Z");
  });

  it("stops after its last day", () => {
    const due = at("2026-09-28T06:00:00Z");
    const until = { ...weekly, until: "2026-10-04" };
    expect(nextOccurrence(due, until, due, DUBAI)).toBeNull();
    expect(nextOccurrence(due, { ...weekly, until: "2026-10-05" }, due, DUBAI)?.toISOString()).toBe(
      "2026-10-05T06:00:00.000Z",
    );
  });
});

describe("localDayBounds", () => {
  it("the person's own midnight to midnight", () => {
    const b = localDayBounds(at("2026-09-28T21:00:00Z"), DUBAI); // already the 29th in Dubai
    expect(b.start.toISOString()).toBe("2026-09-28T20:00:00.000Z");
    expect(b.end.toISOString()).toBe("2026-09-29T20:00:00.000Z");
  });
});

describe("shiftToWorkingHours (3C)", () => {
  const wh = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" } as const;
  const shift = (iso: string, tz: string) =>
    shiftToWorkingHours(at(iso), { ...wh, days: [...wh.days] }, tz).toISOString();
  it("inside working hours, nothing moves", () => {
    expect(shift("2026-09-29T06:00:00Z", DUBAI)).toBe("2026-09-29T06:00:00.000Z"); // Tue 10:00
  });
  it("before the day starts, to that day's start", () => {
    expect(shift("2026-09-29T03:00:00Z", DUBAI)).toBe("2026-09-29T05:00:00.000Z"); // Tue 07:00 → 09:00
  });
  it("at or after the end, to the next working day's start", () => {
    expect(shift("2026-09-29T14:00:00Z", DUBAI)).toBe("2026-09-30T05:00:00.000Z"); // Tue 18:00 → Wed 09:00
  });
  it("Review Focus 2: a Friday evening lands on Monday morning", () => {
    expect(shift("2026-10-02T15:30:00Z", DUBAI)).toBe("2026-10-05T05:00:00.000Z"); // Fri 19:30 → Mon 09:00
  });
  it("a weekend in Kolkata", () => {
    expect(shift("2026-09-27T06:30:00Z", KOLKATA)).toBe("2026-09-28T03:30:00.000Z"); // Sun 12:00 → Mon 09:00
  });
  it("keeps 09:00 local across the autumn change", () => {
    // Saturday 24 Oct 12:00 BST → Monday 26 Oct 09:00, which is GMT by then.
    expect(shift("2026-10-24T11:00:00Z", LONDON)).toBe("2026-10-26T09:00:00.000Z");
  });
});

describe("dueFromPresetDef (3C)", () => {
  const now = at("2026-09-28T08:15:00Z"); // Monday 12:15 in Dubai
  const due = (rule: DuePresetDef["rule"], tz = DUBAI, n = now) =>
    dueFromPresetDef({ id: "x", label: "x", rule }, n, tz).toISOString();
  it("in N minutes, hours or days is a plain duration", () => {
    expect(due({ in: { n: 30, unit: "minute" } })).toBe("2026-09-28T08:45:00.000Z");
    expect(due({ in: { n: 2, unit: "hour" } })).toBe("2026-09-28T10:15:00.000Z");
    expect(due({ in: { n: 2, unit: "day" } })).toBe("2026-09-30T08:15:00.000Z");
  });
  it("a day and a time, in the person's own day", () => {
    expect(due({ at: { days: 1, time: "10:00" } })).toBe("2026-09-29T06:00:00.000Z");
    expect(due({ at: { days: 1, time: "10:00" } }, KOLKATA)).toBe("2026-09-29T04:30:00.000Z");
    expect(due({ at: { days: 0, time: "17:00" } })).toBe("2026-09-28T13:00:00.000Z");
  });
  it("today at a time already gone means tomorrow at it", () => {
    expect(due({ at: { days: 0, time: "09:00" } })).toBe("2026-09-29T05:00:00.000Z");
  });
  it("the next such weekday, never today", () => {
    expect(due({ weekday: { day: 1, time: "10:00" } })).toBe("2026-10-05T06:00:00.000Z"); // Monday → next Monday
    expect(due({ weekday: { day: 3, time: "09:30" } })).toBe("2026-09-30T05:30:00.000Z"); // Wednesday
  });
  it("a time in the spring gap moves forward", () => {
    expect(due({ at: { days: 1, time: "01:30" } }, LONDON, at("2026-03-28T12:00:00Z"))).toBe(
      "2026-03-29T01:00:00.000Z",
    );
  });
  it("3A's five presets are the defaults, and give what they always gave", () => {
    expect(DEFAULT_DUE_PRESETS.map((p) => p.id)).toEqual([
      "in_1h",
      "in_3h",
      "tomorrow_10",
      "in_2d",
      "next_monday",
    ]);
    for (const p of DEFAULT_DUE_PRESETS)
      for (const tz of [DUBAI, KOLKATA, LONDON])
        expect(dueFromPresetDef(p, now, tz).toISOString()).toBe(
          dueFromPreset(p.id as Parameters<typeof dueFromPreset>[0], now, tz).toISOString(),
        );
  });
});
