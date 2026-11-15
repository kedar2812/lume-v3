import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DayItem } from "@/lib/today/day-items";
import { DayList } from "./DayList";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-05T06:10:00Z"); // 11:40 am in Kolkata
const at = (hh: number, mm = 0, d = 5) => new Date(Date.UTC(2026, 9, d, hh, mm) - 330 * 60_000).toISOString();
const fu = (id: string, iso: string, state: DayItem["state"], o: Partial<DayItem> = {}): DayItem => ({
  id,
  kind: "follow_up",
  at: iso,
  endsAt: null,
  title: `Task ${id}`,
  lead: { id: `l-${id}`, name: `Lead ${id}` },
  state,
  link: null,
  before: false,
  ...o,
});
const call = (id: string, hh: number, o: Partial<DayItem> = {}): DayItem => ({
  id,
  kind: "call",
  at: at(hh),
  endsAt: at(hh, 30),
  title: `Call ${id}`,
  lead: { id: `l-${id}`, name: `Lead ${id}` },
  state: "later",
  link: "https://meet.example/x",
  before: false,
  ...o,
});
const groups = () =>
  screen.getAllByRole("group").map((g) => [
    g.getAttribute("aria-label"),
    within(g)
      .getAllByRole("listitem")
      .map((r) => r.getAttribute("data-id")),
  ]);

describe("DayList", () => {
  const items = [
    fu("done", at(9), "done"),
    fu("over", at(10), "over"),
    fu("soon", at(12), "soon"),
    call("c", 15),
    fu("later", at(18), "later"),
  ];

  it("today: Overdue, Coming up and Done, with counts, each in time order", () => {
    render(<DayList items={items} mode="today" show="all" now={NOW} tz={TZ} />);
    expect(groups()).toEqual([
      ["Overdue", ["over"]],
      ["Coming up", ["soon", "c", "later"]],
      ["Done", ["done"]],
    ]);
    expect(screen.getByRole("heading", { name: "Coming up 3" })).toBeTruthy();
  });

  it("a past day reads Not done and Done; a future day reads Planned", () => {
    const { unmount } = render(<DayList items={items} mode="past" show="all" now={NOW} tz={TZ} />);
    expect(groups().map((g) => g[0])).toEqual(["Not done", "Done"]);
    unmount();
    render(<DayList items={[fu("t", at(9, 0, 6), "planned")]} mode="future" show="all" now={NOW} tz={TZ} />);
    expect(groups().map((g) => g[0])).toEqual(["Planned"]);
  });

  it("Show: Calls leaves only calls, Follow-ups only follow-ups", () => {
    const { unmount } = render(<DayList items={items} mode="today" show="call" now={NOW} tz={TZ} />);
    expect(groups()).toEqual([["Coming up", ["c"]]]);
    unmount();
    render(<DayList items={items} mode="today" show="follow_up" now={NOW} tz={TZ} />);
    expect(groups().flatMap((g) => g[1])).toEqual(["over", "soon", "later", "done"]);
  });

  it("a row: time, its words, the lead, the state; it opens the lead", () => {
    render(<DayList items={items} mode="today" show="all" now={NOW} tz={TZ} />);
    const row = screen.getAllByRole("listitem").find((r) => r.getAttribute("data-id") === "soon")!;
    expect(row).toHaveTextContent("12 pm");
    expect(row).toHaveTextContent("Task soon");
    expect(row).toHaveTextContent("Lead soon");
    expect(row).toHaveTextContent("Due soon");
    expect(within(row).getByRole("link", { name: /Task soon/ })).toHaveAttribute(
      "href",
      "/leads?lead=l-soon",
    );
  });

  it("one from before today shows its date", () => {
    render(
      <DayList
        items={[fu("old", at(16, 0, 3), "over", { before: true })]}
        mode="today"
        show="all"
        now={NOW}
        tz={TZ}
      />,
    );
    expect(screen.getByRole("listitem")).toHaveTextContent("Oct 3, Sat, 4 pm");
  });

  it("Join only on an upcoming call with a link, as its own link; the row itself opens the lead", () => {
    render(
      <DayList
        items={[call("c", 15), call("over", 9, { state: "done" }), call("nolink", 17, { link: null })]}
        mode="today"
        show="all"
        now={NOW}
        tz={TZ}
      />,
    );
    const joins = screen.getAllByRole("link", { name: "Join" });
    expect(joins).toHaveLength(1);
    expect(joins[0]).toHaveAttribute("href", "https://meet.example/x");
    expect(joins[0]).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: /Call c/ })).toHaveAttribute("href", "/leads?lead=l-c");
  });

  it("an empty day says so, with how to add one on today and future days only", () => {
    const { unmount } = render(<DayList items={[]} mode="today" show="all" now={NOW} tz={TZ} />);
    expect(screen.getByText("Nothing planned for this day")).toBeTruthy();
    expect(screen.getByText("Add a follow-up from any lead")).toBeTruthy();
    unmount();
    render(<DayList items={[]} mode="past" show="all" now={NOW} tz={TZ} />);
    expect(screen.getByText("Nothing planned for this day")).toBeTruthy();
    expect(screen.queryByText("Add a follow-up from any lead")).toBeNull();
  });

  it("rows are links a screen reader can name", () => {
    render(<DayList items={items} mode="today" show="all" now={NOW} tz={TZ} />);
    expect(screen.getByRole("link", { name: "Task over, Lead over, 10 am, Overdue" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Call c, Lead c, 3 pm – 3:30 pm" })).toBeTruthy();
  });
});
