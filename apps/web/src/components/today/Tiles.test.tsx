import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Tiles as TilesData } from "@/lib/today/types";
import { Tiles } from "./Tiles";

/** Every number on a tile is the API's number, said with what it's set against (spec: The tiles). */
const base: TilesData = {
  leads: {
    day: "2026-10-05",
    hourNow: 11,
    today: 40,
    lastWeek: 33,
    hours: [0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 4, 5, ...Array<number>(12).fill(0)].map((n, i) =>
      i === 11 ? 27 : n,
    ),
    usual: Array<number>(24).fill(1),
    weeks: 4,
    reached: 34,
    medianMinutes: 9,
  },
  month: {
    money: true,
    from: "2026-10-01",
    to: "2026-10-05",
    value: 2_160_000,
    previous: 1_890_000,
    won: 9,
    goal: {
      scope: "business",
      target: 12_000_000,
      value: 2_160_000,
      elapsed: 5 / 31,
      pace: 1.12,
      daysLeft: 26,
    },
  },
  pipeline: {
    name: "Sales",
    many: false,
    open: 1284,
    openEverywhere: null,
    stages: [
      { id: "1", name: "New", n: 214 },
      { id: "2", name: "Contacted", n: 900 },
      { id: "3", name: "Proposal", n: 170 },
    ],
    wonThisMonth: 18,
    forecast: 4_600_000,
  },
  calendar: {
    weekStart: "2026-10-05",
    todayIndex: 0,
    week: [5, 4, 3, 4, 2, 1, 0],
    today: 5,
    held: 1,
    connected: true,
  },
  team: { overdue: 23, people: [{ id: "d", name: "Dev Malhotra", n: 9 }], onTime: 0.93 },
  replies: {
    rate: 0.34,
    previous: 0.31,
    series: [0.3, 0.32, 0.31, 0.35, 0.33, 0.36, 0.34],
    best: { name: "Pricing follow-up", rate: 0.52, sends: 40 },
  },
};
const tile = (name: RegExp) => screen.getByRole("link", { name });

describe("Today's tiles", () => {
  it("Leads: today's number against last Monday by this time, and who has no one yet", () => {
    render(<Tiles tiles={base} currency="INR" own={false} unassigned={6} />);
    const t = tile(/^Leads: 40 new today, \+21\.2% vs last Monday by this time/);
    expect(t).toHaveAttribute("href", "/leads");
    // The short day fits the tile; its name (above) says Monday in full.
    expect(t).toHaveTextContent("vs last Mon by now");
    expect(t).toHaveTextContent("6 with no one yet");
  });
  it("Leads, seen by someone who has only their own: reached, and half within the median", () => {
    render(<Tiles tiles={{ ...base, leads: { ...base.leads!, lastWeek: 0 } }} currency="INR" own />);
    const t = tile(/^Your leads: 40 new today$/);
    expect(t).toHaveTextContent("Contacted 34 of 40 · half within 9 min");
    expect(t).toHaveTextContent("None by now last Monday"); // no percentage against nothing
  });
  it("The month: revenue against the same days of last month, the goal bar, and the pace as an estimate", () => {
    render(<Tiles tiles={base} currency="INR" own={false} />);
    const t = tile(/^Revenue · October/);
    expect(t).toHaveTextContent("vs Sep 1–5");
    expect(t).toHaveTextContent("18% of ₹1.2Cr");
    expect(t).toHaveTextContent("26 days left");
    expect(t).toHaveTextContent("At this pace: ₹1.3Cr by Oct 31");
    expect(within(t).getByRole("img", { name: /an even pace would be at 16%/ })).toBeInTheDocument();
  });
  it("The month without a goal says so, and without money it counts deals", () => {
    render(
      <Tiles
        tiles={{ ...base, month: { ...base.month!, money: false, value: 4, previous: 3, goal: null } }}
        currency="INR"
        own
      />,
    );
    const t = tile(/^Your wins · October/);
    expect(t).toHaveTextContent("4deals won");
    expect(t).toHaveTextContent("No goal set for October");
  });
  it("The pipeline: open leads by the business's own stages, the two nearest a decision and won this month, the forecast", () => {
    render(<Tiles tiles={base} currency="INR" own={false} />);
    const t = tile(/^Pipeline: 1284 open leads/);
    expect(t).toHaveTextContent("900Contacted");
    expect(t).toHaveTextContent("170Proposal");
    expect(t).toHaveTextContent("18Won this month");
    expect(t).toHaveTextContent("₹46L forecast");
  });
  it("Calendar: today's calls, the week's, and an honest empty week", () => {
    const { unmount } = render(<Tiles tiles={base} currency="INR" own={false} />);
    expect(tile(/^Calendar: 5 calls today, 19 this week/)).toHaveTextContent("1 held today · 19 this week");
    unmount();
    render(
      <Tiles
        tiles={{
          ...base,
          calendar: { ...base.calendar, week: [0, 0, 0, 0, 0, 0, 0], today: 0, held: 0, connected: false },
        }}
        currency="INR"
        own={false}
      />,
    );
    expect(tile(/^Calendar/)).toHaveTextContent("Connect a calendar for calls");
  });
  it("Team: who holds the overdue right now; the on-time rate only once it means something", () => {
    const { unmount } = render(<Tiles tiles={base} currency="INR" own={false} />);
    expect(tile(/^Team: 23 follow-ups overdue/)).toHaveTextContent("Dev Malhotra9");
    expect(tile(/^Team/)).toHaveTextContent("93% done on time this month");
    unmount();
    render(
      <Tiles
        tiles={{ ...base, team: { overdue: 0, people: [], onTime: null } }}
        currency="INR"
        own={false}
      />,
    );
    expect(tile(/^Team/)).toHaveTextContent("Nobody's follow-ups are overdue");
    expect(tile(/^Team/)).toHaveTextContent("The on-time rate shows after 10 are done this month");
  });
  it("On time (someone with only their own): the streak, and what today would make it", () => {
    render(
      <Tiles
        tiles={{
          ...base,
          team: undefined,
          streak: {
            days: 6,
            best: 6,
            dueToday: 8,
            doneToday: 2,
            last7: ["ok", "ok", "missed", "ok", "ok", "ok", "ok"],
          },
        }}
        currency="INR"
        own
      />,
    );
    const t = tile(/^On time: 6 days in a row/);
    expect(t).toHaveTextContent("Finish today's 6 to make it 7");
  });
  it("Replies: the rate against the 7 days before, in points, and the best template", () => {
    render(<Tiles tiles={base} currency="INR" own={false} />);
    const t = tile(/^Replies: 34% of contacted leads replied/);
    expect(t).toHaveTextContent("+3.0 pts");
    expect(t).toHaveTextContent("vs the 7 days before");
    expect(t).toHaveTextContent("Best template: Pricing follow-up · 52%");
  });
  it("a tile the viewer may not see isn't there at all", () => {
    render(<Tiles tiles={{ calendar: base.calendar }} currency="INR" own />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
