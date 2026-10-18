import { describe, expect, it } from "vitest";
import { aiLimitState, aiWindows, backWords } from "./limits";

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
