import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { MouseEvent, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskView, TodayMeeting, TodayView } from "@/lib/tasks/types";
import { DayTile } from "./DayTile";

// Links stay plain anchors here: these tests click them and check nothing else ran.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    ...p
  }: {
    href: string;
    children: ReactNode;
    onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={href}
      {...p}
      onClick={(e) => {
        onClick?.(e);
        e.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-05T06:10:00Z"); // 11:40 am in Kolkata
const at = (hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 5, hh, mm) - 330 * 60_000).toISOString();
const t = (id: string, leadName: string, dueAt: string): TaskView => ({
  id,
  leadId: `l-${id}`,
  leadName,
  title: "Follow up",
  note: null,
  dueAt,
  status: "open",
  remindMinutes: [0],
  recurrence: null,
  assignee: { id: "u-me", name: "Maya Kapoor" },
  createdBy: null,
  doneAt: null,
  canEdit: true,
});

// jsdom lays nothing out: give the day line the width a desktop Today has.
const width = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
beforeEach(() =>
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => 600 }),
);
afterEach(() => Object.defineProperty(Element.prototype, "clientWidth", width));

const call = (id: string, start: string, end: string, more: Partial<TodayMeeting> = {}): TodayMeeting => ({
  id,
  title: "Discovery call",
  startsAt: start,
  endsAt: end,
  link: "https://meet.example/x",
  status: "scheduled",
  lead: { id: `l-${id}`, name: "Isha Kapoor" },
  matchedBy: "calendar",
  reminder: null,
  ...more,
});
const day = (over: Partial<TodayView> = {}): TodayView =>
  ({
    overdue: [],
    soon: [],
    later: [],
    doneToday: [],
    done: 0,
    total: 0,
    meetings: [],
    ...over,
  }) as TodayView;

describe("Your day: follow-ups at about the same time (axe target-size)", () => {
  it("three at 10 am share one marker with their count, which opens the list of all three; one at 4 pm keeps its dot", () => {
    const v = day({
      overdue: [t("b", "Omar Ali", at(10))],
      later: [t("d", "Sara Pinto", at(16))],
      doneToday: [t("a", "Aisha Khan", at(10)), t("c", "Ravi Rao", at(10, 2))],
      done: 2,
      total: 4,
    });
    render(<DayTile v={v} now={NOW} tz={TZ} onOpenFull={() => {}} />);
    const group = screen.getByRole("button", { name: /^3 follow-ups: / });
    expect(group).toHaveTextContent("3");
    expect(group).not.toHaveAttribute("href");
    expect(group).toHaveAccessibleName(expect.stringContaining("Omar Ali, 10 am, overdue"));
    expect(group).toHaveAccessibleName(expect.stringContaining("Ravi Rao, 10:02 am, done"));
    fireEvent.click(group);
    const panel = screen.getByText("3 follow-ups around 10 am").closest("[data-day-panel]") as HTMLElement;
    expect(
      within(panel)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/leads?lead=l-a", "/leads?lead=l-b", "/leads?lead=l-c"]);
    expect(
      screen.getByRole("link", { name: "Follow up, Sara Pinto, 4 pm, later today" }),
    ).toBeInTheDocument();
  });
});

describe("Your day: hover brings one thing forward (spec Part 1)", () => {
  it("hovering a dot: it comes forward, the rest steps back, and its panel shows its words, lead, time and state", () => {
    const v = day({ later: [t("d", "Sara Pinto", at(16))], soon: [t("s", "Omar Ali", at(12, 30))] });
    const { container } = render(<DayTile v={v} now={NOW} tz={TZ} onOpenFull={() => {}} />);
    const dot = screen.getByRole("link", { name: "Follow up, Sara Pinto, 4 pm, later today" });
    fireEvent.pointerEnter(dot);
    expect(dot).toHaveAttribute("data-on");
    expect(container.querySelector("[data-day-line]")!.className).toMatch(/focusing/);
    const panel = document.querySelector("[data-day-panel]") as HTMLElement;
    expect(panel).toHaveTextContent("Follow up");
    expect(panel).toHaveTextContent("Sara Pinto");
    expect(panel).toHaveTextContent("4 pm");
    expect(panel).toHaveTextContent("Later today");
    expect(within(panel).getByRole("link", { name: "Open lead" })).toHaveAttribute("href", "/leads?lead=l-d");
    // The hour labels and the now marker step back with the rest.
    expect(container.querySelectorAll("[data-day-back]").length).toBeGreaterThan(1);
  });

  it("a call's panel has Join and Open lead", () => {
    const v = day({ meetings: [call("m", at(15, 30), at(16))] });
    render(<DayTile v={v} now={NOW} tz={TZ} onOpenFull={() => {}} />);
    fireEvent.pointerEnter(screen.getByRole("link", { name: /^Discovery call with Isha Kapoor/ }));
    const panel = document.querySelector("[data-day-panel]") as HTMLElement;
    expect(within(panel).getByRole("link", { name: "Join" })).toHaveAttribute(
      "href",
      "https://meet.example/x",
    );
    expect(within(panel).getByRole("link", { name: "Open lead" })).toHaveAttribute("href", "/leads?lead=l-m");
  });

  it("keyboard: Tab onto a dot opens its panel, Esc closes it", () => {
    const v = day({ later: [t("d", "Sara Pinto", at(16))] });
    render(<DayTile v={v} now={NOW} tz={TZ} onOpenFull={() => {}} />);
    act(() => screen.getByRole("link", { name: /Sara Pinto/ }).focus());
    expect(document.querySelector("[data-day-panel]")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector("[data-day-panel]")).toBeNull();
  });
});

describe("Your day: a click on the card opens the full screen (owner, 2026-11-15)", () => {
  const v = day({ later: [t("d", "Sara Pinto", at(16))], meetings: [call("m", at(15, 30), at(16))] });

  it("empty space on the line, the header and the next-call row open it", () => {
    const open = vi.fn();
    const { container } = render(<DayTile v={v} now={NOW} tz={TZ} onOpenFull={open} />);
    fireEvent.click(container.querySelector("[data-day-line]")!);
    fireEvent.click(screen.getByText("Your day"));
    fireEvent.click(screen.getByText(/^Next call/));
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("a dot, a call, an open panel and the next call's Join do their own job instead", () => {
    const open = vi.fn();
    const { container } = render(<DayTile v={v} now={NOW} tz={TZ} onOpenFull={open} />);
    const dot = screen.getByRole("link", { name: /Sara Pinto/ });
    fireEvent.click(dot);
    fireEvent.click(screen.getByRole("link", { name: /^Discovery call with Isha Kapoor/ }));
    fireEvent.pointerEnter(dot);
    fireEvent.click(document.querySelector("[data-day-panel]")!);
    const nextRow = container.querySelector("[data-next-call]") as HTMLElement;
    fireEvent.click(within(nextRow).getByRole("link", { name: "Join" }));
    expect(open).not.toHaveBeenCalled();
  });

  it("the expand button opens it too, by name, for keyboards and screen readers", () => {
    const open = vi.fn();
    render(<DayTile v={v} now={NOW} tz={TZ} onOpenFull={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Your day full screen" }));
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("Your day card: review fixes (2026-11-15)", () => {
  it("a click (or Enter) on a numbered marker puts the keyboard on its first row", () => {
    const v = day({
      overdue: [t("b", "Omar Ali", at(10))],
      doneToday: [t("a", "Aisha Khan", at(10)), t("c", "Ravi Rao", at(10, 2))],
    });
    render(<DayTile v={v} now={NOW} tz={TZ} onOpenFull={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^3 follow-ups: / }));
    const panel = document.querySelector("[data-day-panel]") as HTMLElement;
    expect(document.activeElement).toBe(within(panel).getAllByRole("link")[0]);
  });

  it("an upcoming call with a link joins it, as on the timeline (spec Part 1); one that ended opens its lead", () => {
    const v = day({
      meetings: [call("next", at(15, 30), at(16)), call("over", at(9), at(9, 30), { title: "Intro call" })],
    });
    render(<DayTile v={v} now={NOW} tz={TZ} onOpenFull={() => {}} />);
    const next = screen.getByRole("link", { name: /^Discovery call with Isha Kapoor at 3:30 pm$/ });
    expect(next).toHaveAttribute("href", "https://meet.example/x");
    expect(next).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: /^Intro call with Isha Kapoor at 9 am, over$/ })).toHaveAttribute(
      "href",
      "/leads?lead=l-over",
    );
  });

  it("a thing that vanishes in a live update takes its panel with it, and the rest comes back", () => {
    const v = day({ later: [t("d", "Sara Pinto", at(16))], soon: [t("s", "Omar Ali", at(12, 30))] });
    const { rerender, container } = render(<DayTile v={v} now={NOW} tz={TZ} onOpenFull={() => {}} />);
    fireEvent.pointerEnter(screen.getByRole("link", { name: /Sara Pinto/ }));
    expect(document.querySelector("[data-day-panel]")).not.toBeNull();
    rerender(
      <DayTile v={day({ soon: [t("s", "Omar Ali", at(12, 30))] })} now={NOW} tz={TZ} onOpenFull={() => {}} />,
    );
    expect(document.querySelector("[data-day-panel]")).toBeNull();
    expect(container.querySelector("[data-day-line]")!.className).not.toMatch(/focusing/);
  });
});

describe("Your day card: a real browser focuses a button on mousedown", () => {
  it("a marker already open from that focus still hands the keyboard to its first row on click", () => {
    const v = day({
      overdue: [t("b", "Omar Ali", at(10))],
      doneToday: [t("a", "Aisha Khan", at(10)), t("c", "Ravi Rao", at(10, 2))],
    });
    render(<DayTile v={v} now={NOW} tz={TZ} onOpenFull={() => {}} />);
    const marker = screen.getByRole("button", { name: /^3 follow-ups: / });
    act(() => marker.focus()); // Chrome: focus on mousedown, which opens its panel
    fireEvent.click(marker);
    const panel = document.querySelector("[data-day-panel]") as HTMLElement;
    expect(document.activeElement).toBe(within(panel).getAllByRole("link")[0]);
  });
});

describe("Your day card: second review (2026-11-15)", () => {
  it("a live update that changes an open marker's group closes its panel (the marker it hung on is gone)", () => {
    const three = day({
      overdue: [t("b", "Omar Ali", at(10))],
      doneToday: [t("a", "Aisha Khan", at(10)), t("c", "Ravi Rao", at(10, 2))],
    });
    const { rerender, container } = render(<DayTile v={three} now={NOW} tz={TZ} onOpenFull={() => {}} />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: /^3 follow-ups: / }));
    expect(document.querySelector("[data-day-panel]")).not.toBeNull();
    const four = day({ ...three, later: [t("d", "Sara Pinto", at(10, 3))] });
    rerender(<DayTile v={four} now={NOW} tz={TZ} onOpenFull={() => {}} />);
    expect(document.querySelector("[data-day-panel]")).toBeNull();
    expect(container.querySelector("[data-day-line]")!.className).not.toMatch(/focusing/);
  });
});
