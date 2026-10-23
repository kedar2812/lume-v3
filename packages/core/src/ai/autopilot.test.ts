import { describe, expect, it } from "vitest";
import {
  MIN_GAP_MS,
  amountsIn,
  dailyBudget,
  isStop,
  nextMove,
  nextSendAt,
  revealMs,
  unbackedAmounts,
  windowOpen,
} from "./autopilot";

/** Autopilot's rules (spec 2026-10-19 §1–§3, §6), pure and on the business's clock. */
const H = 3_600_000;
const D = 24 * H;
const T0 = new Date("2026-10-19T06:00:00Z"); // Monday 10:00 in Dubai
const at = (ms: number) => new Date(T0.getTime() + ms);
const lead = (o: Partial<Parameters<typeof nextMove>[0]> = {}): Parameters<typeof nextMove>[0] => ({
  state: "up_next",
  firstSentAt: null,
  lastSentAt: null,
  lastInboundAt: null,
  followUpsSent: 0,
  ...o,
});
const days = [2, 5];

describe("the next move for a lead", () => {
  it("a first message, then follow-ups on their days, then done", () => {
    expect(nextMove(lead(), { now: T0, followUpDays: days })).toEqual({ kind: "first" });
    const sent = lead({ state: "sent", firstSentAt: T0, lastSentAt: T0 });
    expect(nextMove(sent, { now: at(D), followUpDays: days })).toEqual({ kind: "wait", until: at(2 * D) });
    expect(nextMove(sent, { now: at(2 * D), followUpDays: days })).toEqual({ kind: "follow_up", n: 1 });
    const once = { ...sent, followUpsSent: 1, lastSentAt: at(2 * D) };
    expect(nextMove(once, { now: at(3 * D), followUpDays: days })).toEqual({
      kind: "wait",
      until: at(5 * D),
    });
    expect(nextMove(once, { now: at(5 * D), followUpDays: days })).toEqual({ kind: "follow_up", n: 2 });
    expect(nextMove({ ...once, followUpsSent: 2 }, { now: at(9 * D), followUpDays: days })).toEqual({
      kind: "done",
    });
  });

  it("a reply only inside the 24 hours; outside them the follow-ups carry on from the lead's last message", () => {
    const replied = lead({ state: "replied", firstSentAt: T0, lastSentAt: T0, lastInboundAt: at(H) });
    expect(nextMove(replied, { now: at(2 * H), followUpDays: days })).toEqual({ kind: "reply" });
    expect(windowOpen(at(H), at(2 * H))).toBe(true);
    expect(windowOpen(at(H), at(H + D + 1))).toBe(false);
    // The 24 hours passed unanswered (paused meanwhile): an approved template, counted from the lead's message.
    expect(nextMove(replied, { now: at(H + D + 1), followUpDays: days })).toEqual({
      kind: "wait",
      until: at(H + 2 * D),
    });
    expect(nextMove(replied, { now: at(H + 2 * D), followUpDays: days })).toEqual({
      kind: "follow_up",
      n: 1,
    });
  });

  it("a lead marked replied is answered even when their message carries the same second as the send (Meta's stamps are whole seconds)", () => {
    const quick = lead({ state: "replied", firstSentAt: T0, lastSentAt: at(400), lastInboundAt: T0 });
    expect(nextMove(quick, { now: at(5_000), followUpDays: days })).toEqual({ kind: "reply" });
  });

  it("a lead with a person, stopped, ready or waiting on them is left alone", () => {
    for (const state of ["with_you", "stopped", "ready", "needs_you", "skipped"] as const)
      expect(nextMove(lead({ state }), { now: T0, followUpDays: days })).toEqual({
        kind: "wait",
        until: null,
      });
  });
});

describe("pacing (§1.2, §6)", () => {
  it("the daily budget is the lower of tier and cap, less today", () => {
    expect(dailyBudget({ tierLimit: 1000, cap: 40, sentToday: 10 })).toBe(30);
    expect(dailyBudget({ tierLimit: 250, cap: null, sentToday: 300 })).toBe(0);
    // A tier not read yet counts as a new number's 250.
    expect(dailyBudget({ tierLimit: null, cap: null, sentToday: 0 })).toBe(250);
    expect(dailyBudget({ tierLimit: "unlimited", cap: 500, sentToday: 5 })).toBe(495);
    expect(dailyBudget({ tierLimit: "unlimited", cap: null, sentToday: 5 })).toBe(Number.POSITIVE_INFINITY);
  });

  const wh = { days: [1, 2, 3, 4, 5], start: "09:00", end: "19:00" };
  const tz = "Asia/Dubai";
  const dubai = (iso: string) => new Date(`${iso}+04:00`);

  it("spacing spreads the budget over the hours left", () => {
    // Monday 10:00 Dubai: 9 hours left, 9 messages left → one an hour.
    const now = dubai("2026-10-19T10:00:00");
    expect(nextSendAt({ now, wh, tz, budgetLeft: 9, lastSentAt: now })).toEqual(new Date(now.getTime() + H));
    // Never closer than the minimum gap, however many are left.
    expect(nextSendAt({ now, wh, tz, budgetLeft: 100_000, lastSentAt: now })).toEqual(
      new Date(now.getTime() + MIN_GAP_MS),
    );
    // Nothing sent yet today: now.
    expect(nextSendAt({ now, wh, tz, budgetLeft: 9, lastSentAt: null })).toEqual(now);
  });

  it("the evening edge", () => {
    const now = dubai("2026-10-22T18:55:00"); // Thursday
    expect(nextSendAt({ now, wh, tz, budgetLeft: 40, lastSentAt: null })).toEqual(now);
    // The next send would fall after 19:00: Friday 09:00.
    expect(nextSendAt({ now, wh, tz, budgetLeft: 40, lastSentAt: dubai("2026-10-22T18:59:50") })).toEqual(
      dubai("2026-10-23T09:00:00"),
    );
    // Friday evening: Monday morning.
    expect(
      nextSendAt({
        now: dubai("2026-10-23T18:59:50"),
        wh,
        tz,
        budgetLeft: 5,
        lastSentAt: dubai("2026-10-23T18:59:45"),
      }),
    ).toEqual(dubai("2026-10-26T09:00:00"));
    // Nothing left for today: the next working day's start.
    expect(
      nextSendAt({ now: dubai("2026-10-22T11:00:00"), wh, tz, budgetLeft: 0, lastSentAt: null }),
    ).toEqual(dubai("2026-10-23T09:00:00"));
    // Before hours: today's start.
    expect(
      nextSendAt({ now: dubai("2026-10-22T07:30:00"), wh, tz, budgetLeft: 5, lastSentAt: null }),
    ).toEqual(dubai("2026-10-22T09:00:00"));
  });

  it("the screen reveals a message at reading speed, within bounds", () => {
    expect(revealMs("Hi")).toBe(1_500);
    expect(revealMs("x".repeat(100))).toBe(2_800);
    expect(revealMs("x".repeat(1000))).toBe(9_000);
  });
});

describe("stop means stop (§3)", () => {
  it("stop in many words, never a false stop", () => {
    for (const yes of [
      "STOP",
      "Stop!",
      "please stop",
      "Please don't message me again",
      "Not interested, thanks",
      "unsubscribe",
      "remove me from your list",
      "band karo",
      "mat bhejo ab",
      "توقف",
      "No me escribas más",
    ])
      expect(isStop(yes), yes).toBe(true);
    for (const no of [
      "Can you stop by tomorrow?",
      "Is there a bus stop near the office?",
      "Interested!",
      "Thanks",
    ])
      expect(isStop(no), no).toBe(false);
  });
});

describe("amounts (§11: never a price that isn't in the price list)", () => {
  it("amounts read as people write them", () => {
    expect(amountsIn("A modular kitchen is ₹3,80,000 all in.")).toEqual([380000]);
    expect(amountsIn("Around Rs 1.2 lakh for the wardrobe")).toEqual([120000]);
    expect(amountsIn("AED 1,150.50 for the visit")).toEqual([1150.5]);
    expect(amountsIn("about 15k")).toEqual([15000]);
    expect(amountsIn("$950 or €1,200")).toEqual([950, 1200]);
    // A phone number, a year and a count aren't prices.
    expect(amountsIn("Call +91 98200 12345 in 2026 for 3 rooms")).toEqual([]);
  });

  it("unbacked amounts are the ones not in the price list", () => {
    expect(unbackedAmounts("₹3,80,000 or Rs 15,000", [380000, 1150.5])).toEqual([15000]);
    expect(unbackedAmounts("AED 1,150.50", [1150.5])).toEqual([]);
  });
});
