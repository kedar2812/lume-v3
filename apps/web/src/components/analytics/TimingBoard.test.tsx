import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Timing } from "@/lib/analytics/client";
import { testCatalog } from "@/lib/leads/test-catalog";
import { TimingBoard } from "./TimingBoard";

const grid = <T,>(f: (d: number, h: number) => T) =>
  Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => f(d, h)));
const timing = (o: Partial<Timing> = {}): Timing => ({
  range: { label: "Last 30 days", days: [] },
  window: { startHour: 7, endHour: 22 },
  arrivals: grid((d, h) => (d === 3 && h === 12 ? 20 : h > 8 && h < 18 ? 2 : 0)),
  replies: grid((d, h) =>
    d === 3 && h === 12
      ? { rate: 0.63, n: 40 }
      : h === 9
        ? { rate: 0.3, n: 20 }
        : { rate: null, n: 2, tooFew: true },
  ),
  booking: grid(() => ({ rate: null, n: 0, tooFew: true })),
  outside: { arrivals: 5, sends: 3, replies: 1, booked: 0, held: 0 },
  best: { arrivals: { dow: 3, hour: 12, n: 20 }, replies: { dow: 3, hour: 12, rate: 0.63, n: 40 } },
  cells: {
    arrivals: grid((d, h) => ({ n: 1, drill: `a-${d}-${h}` })),
    replies: grid((d, h) => ({ n: 1, drill: `r-${d}-${h}` })),
    booking: grid(() => ({ n: 0 })),
  },
  meetings: {
    kpis: {
      booked: 100,
      held: 80,
      heldRate: 0.89,
      noShowRate: 0.11,
      cancelled: 10,
      previous: { booked: 80, held: 64, heldRate: 0.8, noShowRate: 0.2, cancelled: 10 },
    },
    flow: { booked: 100, held: 80, noShow: 10, cancelled: 10, rescheduled: 0, upcoming: 0 },
    people: [
      { id: "u-riya", name: "Riya Sharma", held: 50, noShow: 5, cancelled: 5 },
      { id: "u-tas", name: "Leila Haddad", held: 30, noShow: 5, cancelled: 5 },
    ],
    drill: { held: "d-held", no_show: "d-ns", cancelled: "d-c" },
  },
  stages: [],
  ...o,
});
const props = {
  insights: {
    ready: true as const,
    insights: [
      {
        id: "reply_window",
        subject: "all",
        title: "Wednesday noon replies best",
        body: "63% of them.",
        magnitude: 2,
      },
      { id: "speed_pays", subject: "all", title: "Speed pays off", body: "x", magnitude: 3 },
    ],
  },
  catalog: testCatalog(),
  timezone: "Asia/Kolkata",
  compare: true,
  rangeWords: "in the last 30 days",
};

describe("Timing & meetings (canvas Timing)", () => {
  it("a week by the hour, Monday first, in the business's time, with its best slot marked", async () => {
    const onDrill = vi.fn();
    render(<TimingBoard timing={timing()} {...props} onDrill={onDrill} />);
    const table = screen.getByRole("table", { name: "When leads reply" });
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((r) => r.textContent),
    ).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(within(table).getAllByRole("columnheader")).toHaveLength(16);
    const best = within(table).getByRole("button", { name: "Wednesday 12 pm: 63% of 40" });
    expect(best).toHaveAttribute("data-best");
    expect(screen.getByText("Best: Wed 12 pm · 63%")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "When leads reply" })).toHaveTextContent("Kolkata time");
    await userEvent.click(best);
    expect(onDrill).toHaveBeenCalledWith("r-3-12", "Wednesday, 12 pm");
  });

  it("switches to arrivals, and says how many fell outside the hours shown", async () => {
    render(<TimingBoard timing={timing()} {...props} onDrill={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: "Arrivals" }));
    expect(screen.getByRole("table", { name: "When leads arrive" })).toBeInTheDocument();
    expect(screen.getByText("Best: Wed 12 pm · 20 leads")).toBeInTheDocument();
    expect(screen.getByText("5 more outside 7 am – 10 pm.")).toBeInTheDocument();
  });

  it("opens on arrivals when no replies are logged yet, rather than an empty grid", () => {
    const none = timing({ replies: grid(() => ({ rate: null, n: 0, tooFew: true })) });
    render(<TimingBoard timing={none} {...props} onDrill={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Arrivals" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("table", { name: "When leads arrive" })).toBeInTheDocument();
  });

  it("with nothing booked, the bookings view says so instead of an empty grid", async () => {
    render(<TimingBoard timing={timing()} {...props} onDrill={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: "Bookings" }));
    expect(screen.getByText("No calls were booked in this range.")).toBeInTheDocument();
  });

  it("LUME noticed shows only what's about timing", () => {
    render(<TimingBoard timing={timing()} {...props} onDrill={vi.fn()} />);
    const card = screen.getByRole("region", { name: "LUME noticed" });
    expect(card).toHaveTextContent("Wednesday noon replies best");
    expect(card).not.toHaveTextContent("Speed pays off");
  });

  it("meetings: the numbers with their change, what happened to every call, and each person's", async () => {
    const onDrill = vi.fn();
    render(<TimingBoard timing={timing()} {...props} onDrill={onDrill} />);
    const card = screen.getByRole("region", { name: "Meetings" });
    const noShow = within(card).getByRole("button", { name: /^No-show rate: 11\.0%/ });
    // Fewer no-shows is good: green, pointing down.
    expect(noShow.querySelector("[data-tone='good']")).toHaveTextContent("−9.0 pts");
    expect(within(card).getByRole("img", { name: /^Held: 80/ })).toHaveAccessibleName(
      "Held: 80, They didn’t show: 10, Cancelled: 10",
    );
    expect(card).toHaveTextContent("50 of 60");
    await userEvent.click(within(card).getByRole("button", { name: /^Held: 80/ }));
    expect(onDrill).toHaveBeenCalledWith("d-held", "Calls: held");
  });
});
