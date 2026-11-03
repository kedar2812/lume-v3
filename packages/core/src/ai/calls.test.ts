import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALL_RULES,
  callTimeLabel,
  callTimeWords,
  freeCallStarts,
  freeCallTimes,
  slotProblem,
  windowsWords,
  type CallRules,
} from "./calls";

/** The times LUME AI may say yes to a call (spec 2026-11-02 LUME AI books calls). */
const TZ = "Asia/Dubai"; // UTC+4, no clock changes
const rules: CallRules = {
  ...DEFAULT_CALL_RULES,
  windows: [{ days: [1, 2, 3, 4, 5], from: "16:00", to: "19:00" }],
  minutes: 30,
  noticeHours: 2,
  daysAhead: 14,
};
// Monday 2 November 2026, 10:00 in Dubai.
const now = new Date("2026-11-02T06:00:00Z");
const check = (at: string, o: Partial<Parameters<typeof slotProblem>[1]> = {}) =>
  slotProblem(new Date(at), { rules, tz: TZ, now, busy: [], ...o });

describe("a call time LUME AI may say yes to", () => {
  it("inside the times given, the whole call too, edges included", () => {
    expect(check("2026-11-02T12:00:00Z")).toBeNull(); // 16:00 Dubai
    expect(check("2026-11-02T14:30:00Z")).toBeNull(); // 18:30, ends 19:00
  });

  it("outside them: before the start, a call running past the end, a day not given", () => {
    expect(check("2026-11-02T11:30:00Z")).toBe("outside"); // 15:30
    expect(check("2026-11-02T14:45:00Z")).toBe("outside"); // 18:45, ends 19:15
    expect(check("2026-11-07T12:00:00Z")).toBe("outside"); // Saturday 16:00
  });

  it("none given: every time is outside", () => {
    expect(check("2026-11-02T12:00:00Z", { rules: { ...rules, windows: [] } })).toBe("outside");
  });

  it("too soon: less notice than asked for; exactly the notice is fine", () => {
    const at = new Date("2026-11-02T11:00:00Z"); // 15:00 Dubai
    expect(check("2026-11-02T12:00:00Z", { now: at })).toBe("soon"); // an hour ahead
    expect(check("2026-11-02T13:00:00Z", { now: at })).toBeNull(); // exactly two
    expect(check("2026-11-02T05:00:00Z")).toBe("outside"); // in the past, and outside
  });

  it("too far: past the last day ahead on the business's calendar", () => {
    expect(check("2026-11-16T12:00:00Z")).toBeNull(); // 14 days on
    expect(check("2026-11-17T12:00:00Z")).toBe("far");
  });

  it("taken: any overlap with the speaker's meetings; one ending as it starts is fine", () => {
    const busy = (s: string, e: string) => [{ start: new Date(s), end: new Date(e) }];
    expect(
      check("2026-11-02T12:00:00Z", { busy: busy("2026-11-02T12:15:00Z", "2026-11-02T12:45:00Z") }),
    ).toBe("taken");
    expect(
      check("2026-11-02T12:00:00Z", { busy: busy("2026-11-02T11:00:00Z", "2026-11-02T13:00:00Z") }),
    ).toBe("taken");
    expect(
      check("2026-11-02T12:00:00Z", { busy: busy("2026-11-02T11:30:00Z", "2026-11-02T12:00:00Z") }),
    ).toBeNull();
    expect(
      check("2026-11-02T12:00:00Z", { busy: busy("2026-11-02T12:30:00Z", "2026-11-02T13:00:00Z") }),
    ).toBeNull();
  });

  it("on the business's own clock across a clock change", () => {
    const london: CallRules = { ...rules, windows: [{ days: [0], from: "09:00", to: "10:00" }] };
    // Sunday 25 October 2026: the UK goes back to GMT at 02:00, so 09:00 is 09:00Z (it was 08:00Z a day before).
    const o = { rules: london, tz: "Europe/London", now: new Date("2026-10-24T08:00:00Z"), busy: [] };
    expect(slotProblem(new Date("2026-10-25T09:00:00Z"), o)).toBeNull();
    expect(slotProblem(new Date("2026-10-25T08:00:00Z"), o)).toBe("outside");
  });

  it("a time between whole minutes is never one", () => {
    expect(check("2026-11-02T12:00:30Z")).toBe("outside");
  });
});

describe("the free times LUME AI may offer", () => {
  it("the first free one in each day's times, soonest first, up to the most asked for", () => {
    const busy = [{ start: new Date("2026-11-02T12:00:00Z"), end: new Date("2026-11-02T12:30:00Z") }];
    const free = freeCallTimes({ rules, tz: TZ, now, busy }, 4).map((d) => d.toISOString());
    expect(free).toEqual([
      "2026-11-02T12:30:00.000Z", // Monday 16:30: 16:00 is taken
      "2026-11-03T12:00:00.000Z",
      "2026-11-04T12:00:00.000Z",
      "2026-11-05T12:00:00.000Z",
    ]);
  });

  it("skips what's too soon, days not given, and stops at the last day ahead", () => {
    const late = new Date("2026-11-06T13:00:00Z"); // Friday 17:00: nothing with two hours' notice today
    const free = freeCallTimes({ rules: { ...rules, daysAhead: 3 }, tz: TZ, now: late, busy: [] }, 6);
    expect(free.map((d) => d.toISOString())).toEqual(["2026-11-09T12:00:00.000Z"]); // Monday; the weekend skipped
  });

  it("a window shorter than a call has none", () => {
    const short: CallRules = { ...rules, windows: [{ days: [1], from: "16:00", to: "16:20" }] };
    expect(freeCallTimes({ rules: short, tz: TZ, now, busy: [] }, 6)).toEqual([]);
  });
});

describe("a call time in words", () => {
  it("as the time guard reads them: the day, today or tomorrow, the date and the time each way people write it", () => {
    const w = callTimeWords(new Date("2026-11-02T12:00:00Z"), TZ, now);
    for (const x of ["today", "monday", "2nd", "november", "4pm", "4:00pm", "16:00"]) expect(w).toContain(x);
    const t = callTimeWords(new Date("2026-11-03T12:30:00Z"), TZ, now);
    for (const x of ["tomorrow", "tuesday", "3rd", "4:30pm", "16:30"]) expect(t).toContain(x);
    expect(t).not.toContain("today");
  });

  it("as people read it", () => {
    expect(callTimeLabel(new Date("2026-11-03T12:00:00Z"), TZ)).toBe("November 3, Tuesday at 4 pm");
    expect(callTimeLabel(new Date("2026-11-03T12:30:00Z"), TZ)).toBe("November 3, Tuesday at 4:30 pm");
  });

  it("the times given, for LUME AI's instructions", () => {
    expect(
      windowsWords({
        ...rules,
        windows: [
          { days: [1, 2, 3, 4, 5], from: "16:00", to: "19:00" },
          { days: [6], from: "11:00", to: "13:00" },
          { days: [1, 3], from: "09:00", to: "10:00" },
        ],
      }),
    ).toBe("Monday to Friday 16:00 to 19:00; Saturday 11:00 to 13:00; Monday and Wednesday 09:00 to 10:00");
  });
});

describe("every free start (eval 2026-11-04: the guard's times, not just the first of each day)", () => {
  it("each quarter hour a call fits inside the hours, with notice, within the days ahead, clear of meetings", () => {
    const busy = [{ start: new Date("2026-11-03T13:00:00Z"), end: new Date("2026-11-03T14:00:00Z") }]; // 17:00-18:00
    const all = freeCallStarts({ rules, tz: TZ, now, busy }).map((d) => d.toISOString());
    expect(all).toContain("2026-11-02T12:00:00.000Z"); // today 16:00
    expect(all).toContain("2026-11-02T13:30:00.000Z"); // today 17:30, not the first of its day
    expect(all).toContain("2026-11-02T14:30:00.000Z"); // 18:30, ends at 19:00
    expect(all).not.toContain("2026-11-02T14:45:00.000Z"); // 18:45 would run past 19:00
    expect(all).not.toContain("2026-11-03T13:00:00.000Z"); // taken
    expect(all).not.toContain("2026-11-03T12:45:00.000Z"); // runs into the meeting
    expect(all).toContain("2026-11-03T14:00:00.000Z"); // free as the meeting ends
    expect(all).not.toContain("2026-11-07T12:00:00.000Z"); // Saturday isn't in the hours
    expect(all.every((x) => Date.parse(x) <= now.getTime() + 15 * 86_400_000)).toBe(true);
  });
});
