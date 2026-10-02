import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Meeting } from "@/lib/calendar/types";
import { PhoneCalendar } from "./PhoneCalendar";

const TZ = "Asia/Dubai";
const at = (local: string) => {
  const [d, t] = local.split(" ") as [string, string];
  const [y, mo, da] = d.split("-").map(Number) as [number, number, number];
  const [h, mi] = t.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1, da, h - 4, mi));
};
const meet = (id: string, local: string, lead: string, over: Partial<Meeting> = {}): Meeting => {
  const start = at(local);
  return {
    id,
    title: "Discovery call",
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    status: "scheduled",
    link: `https://meet.google.com/${id}`,
    location: null,
    ownerId: "u-maya",
    matchedBy: "attendee",
    outcomeNote: null,
    lead: { id: `l-${id}`, name: lead, pipelineId: "p1", stageId: "s1" },
    ...over,
  };
};
const NOW = at("2026-10-01 14:16");
const MEETINGS = [
  meet("a", "2026-10-01 09:00", "Priya Menon", { status: "completed" }),
  meet("b", "2026-10-01 11:30", "Karim Aziz", { title: "Pricing walkthrough" }),
  meet("c", "2026-10-01 14:30", "Dana Whitfield", { matchedBy: "calendly" }),
  meet("e", "2026-10-02 10:30", "Noor Rahman", { title: "Programme fit call", ownerId: "u-hana" }),
];
const PEOPLE = [
  { id: "u-maya", name: "Maya Kapoor" },
  { id: "u-hana", name: "Hana Ali" },
];

function phone(over: Partial<Parameters<typeof PhoneCalendar>[0]> = {}) {
  const props = {
    meetings: MEETINGS,
    tz: TZ,
    now: NOW,
    me: "u-maya",
    people: PEOPLE,
    openId: null,
    onOpen: vi.fn(),
    onLogOutcome: vi.fn(),
    ...over,
  };
  render(<PhoneCalendar {...props} />);
  return props;
}

afterEach(() => vi.restoreAllMocks());

describe("the Calendar on a phone", () => {
  it("leads with the next call: a white hero card with its countdown, the lead, the time and Join", () => {
    phone();
    expect(screen.getByRole("heading", { level: 1, name: "Calendar" })).toBeInTheDocument();
    const hero = screen.getByRole("region", { name: "Next meeting" });
    expect(hero).toHaveAttribute("data-soon", "true");
    expect(hero).toHaveTextContent("Next · in 14 min");
    expect(hero).toHaveTextContent("Dana Whitfield");
    expect(hero).toHaveTextContent("Discovery call, 2:30 – 3 pm");
    expect(within(hero).getByRole("link", { name: "Join" })).toHaveAttribute(
      "href",
      "https://meet.google.com/c",
    );
  });

  it("lists Today and Tomorrow, each with how many, every row saying where it stands", () => {
    phone();
    const today = screen.getByRole("region", { name: "Today" });
    expect(today).toHaveTextContent("3 meetings");
    const rows = within(today).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Priya Menon"),
      expect.stringContaining("Karim Aziz"),
      expect.stringContaining("Dana Whitfield"),
    ]);
    expect(rows[0]).toHaveTextContent("Discovery call · Held");
    expect(rows[1]).toHaveTextContent("Pricing walkthrough · Log outcome");
    expect(rows[2]).toHaveTextContent("Discovery call · Calendly");
    const tomorrow = screen.getByRole("region", { name: "Tomorrow" });
    expect(tomorrow).toHaveTextContent("1 meeting");
    // Someone else's meeting names whose it is.
    expect(within(tomorrow).getByRole("button")).toHaveTextContent("Programme fit call · Hana");
  });

  it("a tap opens the meeting", async () => {
    const p = phone();
    await userEvent.click(screen.getByRole("button", { name: /Karim Aziz/ }));
    expect(p.onOpen).toHaveBeenCalledWith("b");
  });

  it("nothing coming: says so plainly", () => {
    phone({ meetings: [] });
    expect(screen.getByText("No meetings coming up.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Next meeting" })).not.toBeInTheDocument();
  });
});

describe("the phone's meeting sheet", () => {
  it("a call to come: Join first, then Open lead and Copy link", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    phone({ openId: "c" });
    const sheet = screen.getByRole("dialog", { name: "Dana Whitfield" });
    expect(sheet).toHaveTextContent("2:30 – 3 pm · Discovery call");
    expect(within(sheet).getByRole("link", { name: "Join" })).toHaveAttribute(
      "href",
      "https://meet.google.com/c",
    );
    expect(within(sheet).getByRole("link", { name: "Open lead" })).toHaveAttribute("href", "/leads?lead=l-c");
    expect(within(sheet).queryByRole("button", { name: "Log how it went" })).not.toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("https://meet.google.com/c");
    expect(within(sheet).getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("an ended call with no outcome: Log how it went", async () => {
    const p = phone({ openId: "b" });
    const sheet = screen.getByRole("dialog", { name: "Karim Aziz" });
    expect(within(sheet).queryByRole("link", { name: "Join" })).not.toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Log how it went" }));
    expect(p.onLogOutcome).toHaveBeenCalledWith(MEETINGS[1]);
  });

  it("the veil and Esc close it", async () => {
    const p = phone({ openId: "c" });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(p.onOpen).toHaveBeenCalledWith(null);
    vi.mocked(p.onOpen).mockClear();
    await userEvent.keyboard("{Escape}");
    expect(p.onOpen).toHaveBeenCalledWith(null);
  });

  // Drags: the clock is the one the sheet reads, so a move's speed is exact.
  const drag = (moves: [number, number][]) => {
    const clock = vi.spyOn(performance, "now");
    const grab = screen.getByRole("button", { name: "Drag down to close" });
    clock.mockReturnValue(moves[0]![0]);
    fireEvent.pointerDown(grab, { pointerId: 1, clientY: moves[0]![1] });
    for (const [t, y] of moves.slice(1)) {
      clock.mockReturnValue(t);
      fireEvent.pointerMove(grab, { pointerId: 1, clientY: y });
    }
    fireEvent.pointerUp(grab, { pointerId: 1 });
  };

  it("a quick flick down closes it, though it moved only 120 px", () => {
    const p = phone({ openId: "c" });
    drag([
      [0, 500],
      [50, 560],
      [100, 620],
    ]);
    expect(p.onOpen).toHaveBeenCalledWith(null);
  });

  it("a slow drag that stops short springs back", () => {
    const p = phone({ openId: "c" });
    drag([
      [0, 500],
      [500, 550],
      [1000, 600],
    ]);
    expect(p.onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Dana Whitfield" })).toHaveStyle({
      transform: "translateY(0px)",
    });
  });

  it("pulled upward it resists: it moves less than the finger", () => {
    phone({ openId: "c" });
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const grab = screen.getByRole("button", { name: "Drag down to close" });
    fireEvent.pointerDown(grab, { pointerId: 1, clientY: 500 });
    clock.mockReturnValue(400);
    fireEvent.pointerMove(grab, { pointerId: 1, clientY: 400 });
    const y = Number(/translateY\((-?[\d.]+)px\)/.exec(screen.getByRole("dialog").style.transform)?.[1]);
    expect(y).toBeLessThan(0);
    expect(y).toBeGreaterThan(-100);
  });
});
