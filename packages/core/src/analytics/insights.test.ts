import { describe, expect, it } from "vitest";
import { DETECTORS, cooling, duration, noticed, possessives, type InsightContext } from "./insights";

const base: InsightContext = { view: "team", money: (n) => `₹${Math.round(n).toLocaleString("en-IN")}` };
const one = (id: keyof typeof DETECTORS, c: Partial<InsightContext>) => {
  const r = DETECTORS[id]({ ...base, ...c });
  return Array.isArray(r) ? (r[0] ?? null) : r;
};

describe("the detectors 8D-1 feeds: goal pace, missed calls by time, after-hours arrivals", () => {
  it("after hours: speaks at 30% or more of at least 200 leads; the morning advice only with evidence", () => {
    const arrivals = { total: 200, afterHours: 60, after: "6 pm", contactBefore: "10 am", evidence: false };
    expect(one("evening_arrivals", { arrivals })).toMatchObject({
      title: "30% of leads arrive after hours",
      body: "They come in after 6 pm.",
    });
    expect(one("evening_arrivals", { arrivals: { ...arrivals, evidence: true } })?.body).toBe(
      "They come in after 6 pm. Contacting them before 10 am the next morning wins more of them.",
    );
    expect(one("evening_arrivals", { arrivals: { ...arrivals, afterHours: 59 } })).toBeNull();
    expect(one("evening_arrivals", { arrivals: { ...arrivals, total: 199, afterHours: 100 } })).toBeNull();
  });

  it("goal pace: an estimate, said as one, once a fifth of the month has gone", () => {
    const goal = {
      metricWords: "revenue",
      month: "June",
      value: 3000,
      target: 10_000,
      elapsed: 0.5,
      daysLeft: 15,
      shown: (n: number) => `₹${n.toLocaleString("en-IN")}`,
    };
    expect(one("goal_pace", { goal })).toMatchObject({
      title: "At this pace, June ends at 60% of the revenue goal",
      body: "₹3,000 so far, with 15 days to go.",
    });
    expect(one("goal_pace", { goal: { ...goal, elapsed: 0.19 } })).toBeNull();
    expect(one("goal_pace", { goal: { ...goal, daysLeft: 1 } })?.body).toBe(
      "₹3,000 so far, with 1 day to go.",
    );
  });

  it("missed calls: a window with 20 booked against 80 elsewhere, 10 points worse and real; quiet under either", () => {
    const slots = [
      { day: 1, hour: 8, booked: 25, noShow: 10 },
      { day: 3, hour: 14, booked: 100, noShow: 5 },
    ];
    expect(one("slot_noshow", { slots })).toMatchObject({
      title: "Calls on Monday 8–10 am are missed more often",
      body: "40% of them were no-shows, against 5% at other times.",
    });
    expect(one("slot_noshow", { slots: [{ ...slots[0]!, booked: 19, noShow: 8 }, slots[1]!] })).toBeNull();
    expect(one("slot_noshow", { slots: [slots[0]!, { ...slots[1]!, booked: 79, noShow: 4 }] })).toBeNull();
    // Worse, but not by 10 points.
    expect(one("slot_noshow", { slots: [{ ...slots[0]!, noShow: 3 }, slots[1]!] })).toBeNull();
  });
});

describe("LUME noticed: each detector, in its own words (8B)", () => {
  it("speed pays: speaks with the ratio and the median; quiet under 30 a side or on a gap that's noise", () => {
    const i = one("speed_pays", {
      speed: { fastN: 120, fastWon: 36, slowN: 300, slowWon: 30, medianMinutes: 150 },
    });
    expect(i).toMatchObject({
      title: "Speed pays off",
      body: "Leads contacted within an hour were won 3.0 times as often. Your median first contact is 2 h 30 min, so most leads miss that hour.",
    });
    expect(
      one("speed_pays", { speed: { fastN: 29, fastWon: 20, slowN: 300, slowWon: 30, medianMinutes: 10 } }),
    ).toBeNull();
    // 3/30 against 1/30: three times as often, but too few to be sure.
    expect(
      one("speed_pays", { speed: { fastN: 30, fastWon: 3, slowN: 30, slowWon: 1, medianMinutes: 10 } }),
    ).toBeNull();
  });

  it("a source punching above its weight, and one costing more than it returns", () => {
    const sources = [
      { id: "s1", name: "Referral", leads: 100, won: 30, revenue: 600_000, spend: null },
      { id: "s2", name: "Spring fair", leads: 900, won: 40, revenue: 400_000, spend: 90_000 },
    ];
    expect(one("source_over", { sources })).toMatchObject({
      title: "Referral punches above its weight",
      body: "It brings 10% of leads and 60% of revenue won.",
    });
    const under = [
      { id: "a", name: "Partner list", leads: 400, won: 8, revenue: 0, spend: 40_000 },
      { id: "b", name: "Website form", leads: 600, won: 60, revenue: 0, spend: null },
    ];
    expect(one("source_under", { sources: under })).toMatchObject({
      title: "Partner list costs more than it returns",
      body: "₹100 a lead, and its leads are won 2% of the time, against 10% for the rest.",
    });
    expect(one("source_under", { sources: under.map((s) => ({ ...s, leads: 99 })) })).toBeNull();
  });

  it("follow-ups slipping names who has most of the overdue ones, for a team", () => {
    const i = one("followups_slip", {
      followups: {
        nowDone: 200,
        nowOnTime: 120,
        beforeDone: 200,
        beforeOnTime: 170,
        overdue: 24,
        overdueBy: [
          { name: "Dev", n: 10 },
          { name: "Leo", n: 8 },
          { name: "Ira", n: 6 },
        ],
      },
    });
    expect(i?.body).toBe("On time fell from 85% to 60%. 24 are overdue now, most of them Dev’s and Leo’s.");
    expect(
      one("followups_slip", {
        followups: {
          nowDone: 200,
          nowOnTime: 120,
          beforeDone: 200,
          beforeOnTime: 170,
          overdue: 9,
          overdueBy: [],
        },
      }),
    ).toBeNull();
  });

  it("a person's late follow-ups clustering on one weekday, worded for them in their own view", () => {
    const people = [{ id: "p", name: "Dev", done: 40, onTime: 30, lateByWeekday: [0, 0, 7, 1, 1, 1, 0] }];
    expect(one("weekday_late", { people })).toMatchObject({
      title: "Dev’s follow-ups slip on Tuesdays",
      body: "7 of Dev’s 10 late follow-ups were due on a Tuesday.",
    });
    expect(one("weekday_late", { people, view: "own" })).toMatchObject({
      title: "Your follow-ups slip on Tuesdays",
    });
    expect(
      one("weekday_late", { people: [{ ...people[0]!, lateByWeekday: [0, 0, 4, 1, 1, 1, 0] }] }),
    ).toBeNull();
  });

  it("the reply window and the no-show slot say the day and the hours", () => {
    const w = (day: number, hour: number, sends: number, replies: number) => ({ day, hour, sends, replies });
    const windows = [w(2, 9, 80, 40), w(1, 14, 300, 60), w(3, 16, 300, 60)];
    expect(one("reply_window", { replyWindows: windows })).toMatchObject({
      title: "Tuesdays 9–11 am get the most replies",
      body: "Messages sent then got an answer 50% of the time, against 20% at other times.",
    });
    expect(one("reply_window", { replyWindows: [w(2, 9, 39, 30), w(1, 14, 600, 120)] })).toBeNull();
  });

  it("goal pace is an estimate, and says so", () => {
    const i = one("goal_pace", {
      goal: {
        metricWords: "wins",
        month: "October",
        value: 12,
        target: 40,
        elapsed: 0.25,
        daysLeft: 23,
        shown: (n) => String(n),
      },
    });
    expect(i).toMatchObject({
      title: "At this pace, October ends at 120% of the wins goal",
      body: "12 so far, with 23 days to go.",
    });
    expect(
      one("goal_pace", {
        goal: {
          metricWords: "wins",
          month: "October",
          value: 2,
          target: 40,
          elapsed: 0.1,
          daysLeft: 27,
          shown: String,
        },
      }),
    ).toBeNull();
  });

  it("won back and lost reasons", () => {
    expect(one("won_back", { wonBack: { n: 4, value: 182_000 } })).toMatchObject({
      title: "LUME helped win back 4 lost leads",
      body: "Worth ₹1,82,000, from leads once marked lost.",
    });
    expect(one("won_back", { wonBack: { n: 2, value: 1 } })).toBeNull();
    const lostReasons = [
      { id: "r1", name: "Too expensive", now: 30, before: 10 },
      { id: "r2", name: "No reply", now: 30, before: 50 },
    ];
    expect(one("lost_reason_up", { lostReasons })).toMatchObject({
      title: "“Too expensive” is rising",
      body: "It’s behind 50% of leads lost, up from 17%.",
    });
  });
});

describe("choosing what to show", () => {
  const ctx: InsightContext = {
    ...base,
    speed: { fastN: 120, fastWon: 36, slowN: 300, slowWon: 30, medianMinutes: 20 },
    wonBack: { n: 4, value: 10_000 },
    sources: [
      { id: "s1", name: "Referral", leads: 100, won: 30, revenue: 600_000, spend: null },
      { id: "s2", name: "Spring fair", leads: 900, won: 40, revenue: 400_000, spend: null },
    ],
  };
  it("at most three, ranked by impact, never two from one detector", () => {
    const shown = noticed(ctx);
    expect(shown.length).toBeLessThanOrEqual(3);
    expect(new Set(shown.map((i) => i.id)).size).toBe(shown.length);
    expect(shown.map((i) => i.id)).toEqual(["source_over", "speed_pays", "won_back"]); // impact 150, 60, 4
  });

  it("the same finding waits 14 days, unless it has moved by half", () => {
    const i = noticed(ctx)[0]!;
    const now = new Date("2026-10-04T10:00:00Z");
    const seen = [
      {
        detector: i.id,
        subject: i.subject,
        magnitude: i.magnitude,
        shownAt: new Date("2026-09-30T10:00:00Z"),
      },
    ];
    expect(cooling(i, seen, now)).toBe(true);
    expect(noticed(ctx, seen, now).map((x) => x.id)).not.toContain(i.id);
    expect(cooling({ ...i, magnitude: i.magnitude * 1.6 }, seen, now)).toBe(false);
    expect(cooling(i, seen, new Date("2026-10-15T10:00:00Z"))).toBe(false);
  });

  it("words: durations and names", () => {
    expect(duration(45)).toBe("45 min");
    expect(duration(150)).toBe("2 h 30 min");
    expect(duration(2880)).toBe("2 days");
    expect(possessives(["Dev", "Leo", "Ira"])).toBe("Dev’s, Leo’s and one other’s");
    expect(possessives(["Dev", "Leo", "Ira", "Sam"])).toBe("Dev’s, Leo’s and 2 others’");
  });
});
