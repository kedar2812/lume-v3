import { describe, expect, it } from "vitest";
import { aiLimitState, aiPace, aiSpend, aiWindows, backWords } from "./limits";

/** LUME AI's limits (spec 2026-10-18 §2.2): a rolling hour, and a week from Monday 00:00 on the business's clock. */
const TZ = "Asia/Kolkata";
const at = (iso: string) => new Date(iso);

describe("the windows", () => {
  it("the hour rolls; the week starts Monday 00:00 on the business's clock", () => {
    // Wednesday 21 Oct 2026, 15:30 in Kolkata.
    const w = aiWindows(at("2026-10-21T10:00:00Z"), TZ);
    expect(w.hourSince.toISOString()).toBe("2026-10-21T09:00:00.000Z");
    expect(w.weekStart.toISOString()).toBe("2026-10-18T18:30:00.000Z"); // Mon 19 Oct 00:00 IST
    expect(w.nextWeekStart.toISOString()).toBe("2026-10-25T18:30:00.000Z"); // Mon 26 Oct 00:00 IST
  });
  it("on Monday just after midnight it's already the new week; on Sunday 23:59 still the old one", () => {
    expect(aiWindows(at("2026-10-25T18:31:00Z"), TZ).weekStart.toISOString()).toBe(
      "2026-10-25T18:30:00.000Z",
    );
    expect(aiWindows(at("2026-10-25T18:29:00Z"), TZ).weekStart.toISOString()).toBe(
      "2026-10-18T18:30:00.000Z",
    );
  });
});

describe("the state", () => {
  const now = at("2026-10-21T10:00:00Z");
  const limits = { hourly: 2, weekly: 10 };
  it("no limits: never paused", () => {
    const s = aiLimitState(
      { hourN: 500, hourOldest: now, weekN: 9000 },
      { hourly: null, weekly: null },
      now,
      TZ,
    );
    expect(s.paused).toBeNull();
    expect(s.hour.limit).toBeNull();
  });
  it("under both limits: not paused, with what's used and when each resets", () => {
    const s = aiLimitState({ hourN: 1, hourOldest: at("2026-10-21T09:20:00Z"), weekN: 4 }, limits, now, TZ);
    expect(s).toEqual({
      hour: { used: 1, limit: 2, resetsAt: "2026-10-21T10:20:00.000Z" },
      week: { used: 4, limit: 10, resetsAt: "2026-10-25T18:30:00.000Z" },
      // No monthly allowance from this licence: the month counts nothing and limits nothing.
      month: { used: 0, limit: null, resetsAt: "2026-10-31T18:30:00.000Z" },
      paused: null,
    });
  });
  it("at the hourly limit: paused until the oldest read in the hour is an hour old", () => {
    const s = aiLimitState({ hourN: 2, hourOldest: at("2026-10-21T09:40:00Z"), weekN: 4 }, limits, now, TZ);
    expect(s.paused).toEqual({ by: "hour", until: "2026-10-21T10:40:00.000Z" });
  });
  it("at the weekly limit: paused until Monday, even if the hour is also full", () => {
    const s = aiLimitState({ hourN: 2, hourOldest: at("2026-10-21T09:40:00Z"), weekN: 10 }, limits, now, TZ);
    expect(s.paused).toEqual({ by: "week", until: "2026-10-25T18:30:00.000Z" });
  });
  it("with nothing read this hour, the hour resets an hour from now", () => {
    const s = aiLimitState({ hourN: 0, hourOldest: null, weekN: 0 }, limits, now, TZ);
    expect(s.hour.resetsAt).toBe("2026-10-21T11:00:00.000Z");
  });
});

describe("when LUME AI is back, in words", () => {
  const now = at("2026-10-21T10:00:00Z"); // 3:30 pm in Kolkata
  it("the hour: a time today, or tomorrow", () => {
    expect(backWords({ by: "hour", until: "2026-10-21T10:10:00.000Z" }, now, TZ)).toBe("at 3:40 pm");
    expect(backWords({ by: "hour", until: "2026-10-21T18:40:00.000Z" }, now, TZ)).toBe(
      "tomorrow at 12:10 am",
    );
  });
  it("the week: the day", () => {
    expect(backWords({ by: "week", until: "2026-10-25T18:30:00.000Z" }, now, TZ)).toBe("Monday");
  });
});

/** Autopilot A1 Task 1 (spec 2026-10-19 §4; owner 2026-10-19: monthly, and generous). */
describe("the month", () => {
  it("monthly: used against the month's allowance, resets on the 1st", () => {
    const now = at("2026-10-21T10:00:00Z");
    const w = aiWindows(now, TZ);
    expect(w.monthStart.toISOString()).toBe("2026-09-30T18:30:00.000Z"); // Oct 1 00:00 IST
    expect(w.nextMonthStart.toISOString()).toBe("2026-10-31T18:30:00.000Z"); // Nov 1 00:00 IST
    const s = aiLimitState(
      { hourN: 0, hourOldest: null, weekN: 0, monthN: 2400 },
      { hourly: 100, weekly: null, monthly: 3000 },
      now,
      TZ,
    );
    expect(s.month).toEqual({ used: 2400, limit: 3000, resetsAt: "2026-10-31T18:30:00.000Z" });
    expect(s.paused).toBeNull();
  });

  it("turns at local midnight: in Dubai, 01:30 on November 1 is November though it's still October in UTC", () => {
    const w = aiWindows(at("2026-10-31T21:30:00Z"), "Asia/Dubai");
    expect(w.monthStart.toISOString()).toBe("2026-10-31T20:00:00.000Z");
  });

  it("the month pauses before the hour: both over, it's the month", () => {
    const now = at("2026-10-21T10:00:00Z");
    const s = aiLimitState(
      { hourN: 100, hourOldest: at("2026-10-21T09:30:00Z"), weekN: 0, monthN: 3000 },
      { hourly: 100, weekly: null, monthly: 3000 },
      now,
      TZ,
    );
    expect(s.paused).toEqual({ by: "month", until: "2026-10-31T18:30:00.000Z" });
  });

  it("backWords says the day the month comes back", () => {
    expect(
      backWords({ by: "month", until: "2026-10-31T18:30:00.000Z" }, at("2026-10-21T10:00:00Z"), TZ),
    ).toBe("on November 1");
  });
});

describe("the pace and the spend (Autopilot A1 Task 3)", () => {
  it("days left at this pace: 600 of 3,000 used in the first 10 days is about 40 more", () => {
    const monthStart = at("2026-09-30T18:30:00Z");
    expect(aiPace({ used: 600, limit: 3000 }, at("2026-10-10T18:30:00Z"), monthStart)).toEqual({
      daysLeft: 40,
    });
    expect(aiPace({ used: 0, limit: 3000 }, at("2026-10-10T18:30:00Z"), monthStart)).toEqual({
      daysLeft: null,
    });
    expect(aiPace({ used: 50, limit: null }, at("2026-10-10T18:30:00Z"), monthStart)).toEqual({
      daysLeft: null,
    });
  });
  it("spend: tokens at the owner's prices, to the cent", () => {
    expect(aiSpend({ inputTokens: 1_000_000, outputTokens: 200_000 }, { in: 3, out: 15, cap: 50 })).toEqual({
      used: 6,
      cap: 50,
      currency: "USD",
    });
    expect(aiSpend({ inputTokens: 1, outputTokens: 1 }, null)).toBeNull();
  });
});
