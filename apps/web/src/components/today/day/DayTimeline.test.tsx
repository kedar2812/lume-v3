import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type MouseEvent, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DayItem } from "@/lib/today/day-items";
import type { Show } from "./DayList";
import { DayTimeline, PAD } from "./DayTimeline";

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
        if (!e.defaultPrevented) opened.push(href);
        e.preventDefault();
      }}
    >
      {children}
    </a>
  ),
}));
let opened: string[] = [];

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-05T06:10:00Z"); // 11:40 am in Kolkata
const at = (hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 5, hh, mm) - 330 * 60_000).toISOString();
const fu = (id: string, hh: number, mm = 0, o: Partial<DayItem> = {}): DayItem => ({
  id,
  kind: "follow_up",
  at: at(hh, mm),
  endsAt: null,
  title: `Task ${id}`,
  lead: { id: `l-${id}`, name: `Lead ${id}` },
  state: "later",
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
  link: null,
  before: false,
  ...o,
});

// jsdom lays nothing out: a 1000 px wide window, and every chip 200 px wide.
const props = ["clientWidth", "clientHeight", "offsetWidth"] as const;
const saved = props.map((p) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, p));
beforeEach(() => {
  opened = [];
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1000 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-chip") ? 200 : 0;
    },
  });
});
afterEach(() => {
  props.forEach((p, i) => saved[i] && Object.defineProperty(HTMLElement.prototype, p, saved[i]!));
  vi.useRealTimers();
});

/** The timeline with its zoom held the way the full screen holds it. */
function Held({
  items,
  show = "all",
  isToday = true,
  now = NOW,
  start = 0,
}: {
  items: DayItem[];
  show?: Show;
  isToday?: boolean;
  now?: Date;
  start?: number;
}) {
  const [pph, setPph] = useState(start);
  return (
    <>
      <output data-testid="pph">{pph}</output>
      <DayTimeline items={items} show={show} now={now} tz={TZ} isToday={isToday} pph={pph} onPph={setPph} />
    </>
  );
}
const scroller = () => document.querySelector("[data-day-scroller]") as HTMLElement;
const chips = () => [...document.querySelectorAll<HTMLElement>("[data-chip]")];
const xOf = (el: HTMLElement) => parseFloat(el.style.left);
const yOf = (el: HTMLElement) => parseFloat(el.style.top);
const mouse = (el: Element, type: string, x: number, y = 100) =>
  el.dispatchEvent(
    Object.defineProperties(
      new globalThis.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }),
      {
        pointerId: { value: 1 },
        pointerType: { value: "mouse" },
      },
    ),
  );

describe("DayTimeline: rows", () => {
  it("one row per kind shown, labelled; Show leaves out the other", () => {
    const items = [call("c", 15), fu("f", 12)];
    const { unmount } = render(<Held items={items} />);
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual([
      "Calls",
      "Follow-ups",
    ]);
    unmount();
    render(<Held items={items} show="call" />);
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Calls"]);
    expect(chips()).toHaveLength(1);
  });

  it("things that would touch stack onto the next line; nothing on a line overlaps", () => {
    // Fit day: 13 hours across 1000 - 2*PAD px. Chips are 200 px: four within 20 minutes can't share a line.
    render(<Held items={[fu("a", 16), fu("b", 16, 5), fu("c", 16, 10), fu("d", 16, 15), fu("e", 20)]} />);
    const cs = chips();
    const lines = cs.map(yOf);
    expect(new Set(lines.slice(0, 4)).size).toBe(4);
    expect(lines[4]).toBe(lines[0]); // 8 pm has room on the first line
    for (const a of cs)
      for (const b of cs)
        if (a !== b && yOf(a) === yOf(b)) expect(Math.abs(xOf(a) - xOf(b))).toBeGreaterThanOrEqual(208);
  });

  it("300 at the same minute all render, each on its own line", () => {
    const many = Array.from({ length: 300 }, (_, i) => fu(`m${i}`, 14));
    render(<Held items={many} />);
    expect(chips()).toHaveLength(300);
    expect(new Set(chips().map(yOf)).size).toBe(300);
  });

  it("a late chip widens the canvas so it isn't cut off", () => {
    render(<Held items={[fu("late", 23, 30)]} start={200} />);
    const canvas = document.querySelector("[data-day-canvas]") as HTMLElement;
    const late = chips()[0]!;
    expect(parseFloat(canvas.style.width)).toBeGreaterThanOrEqual(xOf(late) + 200 + PAD);
  });
});

describe("DayTimeline: now", () => {
  it("today has a now line that moves with the clock; another day has none", () => {
    const { rerender, unmount } = render(<Held items={[fu("a", 12)]} />);
    const line = () => document.querySelector("[data-now]") as HTMLElement | null;
    const before = parseFloat(line()!.style.left);
    rerender(<Held items={[fu("a", 12)]} now={new Date(NOW.getTime() + 60_000)} />);
    expect(parseFloat(line()!.style.left)).toBeGreaterThan(before);
    unmount();
    render(<Held items={[fu("a", 12)]} isToday={false} />);
    expect(line()).toBeNull();
  });

  it("today opens with now about a third of the way in", () => {
    render(<Held items={[fu("a", 12)]} start={140} />);
    const nowX = parseFloat((document.querySelector("[data-now]") as HTMLElement).style.left);
    expect(scroller().scrollLeft).toBeCloseTo(nowX - 1000 / 3, 0);
  });

  it("another day opens at its first thing", () => {
    render(<Held items={[fu("a", 14), fu("b", 18)]} isToday={false} start={140} />);
    expect(scroller().scrollLeft).toBeCloseTo(xOf(chips()[0]!) - PAD, 0);
  });
});

describe("DayTimeline: from before today", () => {
  const old = fu("old", 9, 0, {
    before: true,
    state: "over",
    at: new Date("2026-10-03T10:30:00Z").toISOString(),
  });

  it("today: one pile at the start of Follow-ups, opening the list of them", () => {
    render(<Held items={[old, fu("a", 12)]} />);
    const pile = screen.getByRole("button", { name: "1 from before" });
    fireEvent.click(pile);
    const panel = document.querySelector("[data-day-panel]") as HTMLElement;
    expect(panel).toHaveTextContent("1 from before");
    expect(within(panel).getByRole("link")).toHaveAttribute("href", "/leads?lead=l-old");
    expect(panel).toHaveTextContent("Oct 3, Sat, 4 pm");
  });

  it("another day: no pile", () => {
    render(<Held items={[fu("a", 12)]} isToday={false} />);
    expect(screen.queryByRole("button", { name: /from before/ })).toBeNull();
  });
});

describe("DayTimeline: hover and click", () => {
  it("hover brings one forward with the shared panel; the rest steps back", () => {
    render(<Held items={[fu("a", 12), fu("b", 16)]} />);
    fireEvent.pointerEnter(chips()[1]!);
    expect(chips()[1]).toHaveAttribute("data-on");
    expect(scroller().className).toMatch(/focusing/);
    expect(document.querySelector("[data-day-panel]")).toHaveTextContent("Task b");
  });

  it("a click opens it", () => {
    render(<Held items={[fu("a", 12)]} />);
    fireEvent.click(chips()[0]!);
    expect(opened).toEqual(["/leads?lead=l-a"]);
  });
});

describe("DayTimeline: drag to move", () => {
  it("a drag of 10 px moves it and doesn't open what it started on", () => {
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    const from = s.scrollLeft;
    const chip = chips()[0]!;
    act(() => {
      mouse(chip, "pointerdown", 500);
      mouse(chip, "pointermove", 495);
      mouse(chip, "pointermove", 490);
      mouse(chip, "pointerup", 490);
    });
    fireEvent.click(chip);
    expect(s.scrollLeft).toBeCloseTo(from + 10, 0);
    expect(opened).toEqual([]);
  });

  it("a 3 px wobble is still a click", () => {
    render(<Held items={[fu("a", 12)]} start={140} />);
    const chip = chips()[0]!;
    act(() => {
      mouse(chip, "pointerdown", 500);
      mouse(chip, "pointermove", 497);
      mouse(chip, "pointerup", 497);
    });
    fireEvent.click(chip);
    expect(opened).toEqual(["/leads?lead=l-a"]);
  });

  it("let go mid-flick, it carries on and slows to a stop", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance", "Date"] });
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    act(() => {
      mouse(s, "pointerdown", 600);
      vi.advanceTimersByTime(16);
      mouse(s, "pointermove", 580);
      vi.advanceTimersByTime(16);
      mouse(s, "pointermove", 560);
      mouse(s, "pointerup", 560);
    });
    const released = s.scrollLeft;
    act(() => vi.advanceTimersByTime(100));
    const mid = s.scrollLeft;
    act(() => vi.advanceTimersByTime(3000));
    expect(mid).toBeGreaterThan(released);
    expect(s.scrollLeft).toBeGreaterThan(mid);
    const stopped = s.scrollLeft;
    act(() => vi.advanceTimersByTime(1000));
    expect(s.scrollLeft).toBe(stopped);
  });
});

describe("DayTimeline: zoom", () => {
  it("Ctrl + scroll zooms around the pointer: the time under it stays put", () => {
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    act(() => {
      s.scrollLeft = 700;
    });
    const x = 400;
    const timeAt = (pph: number) => (s.scrollLeft + x - PAD) / pph;
    const before = timeAt(140);
    act(() => {
      s.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -50, clientX: x }),
      );
    });
    const pph = Number(screen.getByTestId("pph").textContent);
    expect(pph).toBeGreaterThan(140);
    expect(timeAt(pph)).toBeCloseTo(before, 6);
  });

  it("the ruler thins out far away and fills in close up", () => {
    // A 700 px window: Fit day is under 60 px an hour, so 60 is allowed.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 700 });
    const { unmount } = render(<Held items={[fu("a", 12)]} start={60} />);
    const labels = () => [...document.querySelectorAll("[data-tick]")].map((t) => t.textContent);
    expect(labels()).toContain("8 am");
    expect(labels()).not.toContain("9 am");
    unmount();
    render(<Held items={[fu("a", 12)]} start={300} />);
    expect(labels()).toContain("8:30");
  });
});

describe("DayTimeline: review fixes (2026-11-15)", () => {
  it("a chip can't be dragged as a link: the press stays a pan", () => {
    render(<Held items={[fu("a", 12)]} start={140} />);
    const chip = chips()[0]!;
    expect(chip.getAttribute("draggable")).toBe("false");
    expect(fireEvent.dragStart(chip)).toBe(false); // the browser's own link drag is cancelled
  });

  it("a flick, then a hold, then letting go: it stays where it was put", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance", "Date"] });
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    act(() => {
      mouse(s, "pointerdown", 600);
      vi.advanceTimersByTime(16);
      mouse(s, "pointermove", 580);
      vi.advanceTimersByTime(16);
      mouse(s, "pointermove", 560);
      vi.advanceTimersByTime(300); // held still
      mouse(s, "pointerup", 560);
    });
    const at = s.scrollLeft;
    act(() => vi.advanceTimersByTime(1000));
    expect(s.scrollLeft).toBe(at);
  });

  it("a press on the scrollbar isn't a drag", () => {
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    const from = s.scrollLeft;
    act(() => {
      mouse(s, "pointerdown", 500, 610); // below the 600 px content box: the horizontal scrollbar
      mouse(s, "pointermove", 400, 610);
      mouse(s, "pointerup", 400, 610);
    });
    expect(s.scrollLeft).toBe(from);
  });

  it("a plain mouse wheel moves the day sideways (smoothly) when there's nothing to scroll up and down", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    const from = s.scrollLeft;
    act(() => {
      s.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }));
      s.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }));
    });
    act(() => vi.advanceTimersByTime(16));
    expect(s.scrollLeft).toBeGreaterThan(from);
    expect(s.scrollLeft).toBeLessThan(from + 200); // eased, not a jump
    act(() => vi.advanceTimersByTime(1000));
    expect(s.scrollLeft).toBeCloseTo(from + 200, 0); // both notches count
  });

  it("one Ctrl + wheel notch is a gentle step, and quick steps add up", () => {
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    const pph = () => Number(screen.getByTestId("pph").textContent);
    act(() => {
      s.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -100,
          clientX: 400,
        }),
      );
    });
    const one = pph();
    expect(one).toBeGreaterThan(140);
    expect(one).toBeLessThanOrEqual(140 * 1.35);
    act(() => {
      s.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -10,
          clientX: 400,
        }),
      );
      s.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -10,
          clientX: 400,
        }),
      );
    });
    expect(pph()).toBeCloseTo(one * Math.exp(0.2), 6);
  });

  it("the row's label sits above its first line, not over its first chips", () => {
    render(<Held items={[fu("a", 8, 10)]} isToday={false} start={140} />);
    expect(yOf(chips()[0]!)).toBeGreaterThanOrEqual(28);
  });

  it("scrolling keeps an open panel (it follows its chip); starting a drag closes it", () => {
    render(<Held items={[fu("a", 12), fu("b", 16)]} start={140} />);
    fireEvent.pointerEnter(chips()[1]!);
    fireEvent.scroll(scroller());
    expect(document.querySelector("[data-day-panel]")).not.toBeNull();
    const s = scroller();
    act(() => {
      mouse(s, "pointerdown", 500);
      mouse(s, "pointermove", 480);
    });
    expect(document.querySelector("[data-day-panel]")).toBeNull();
  });

  it("the pile, clicked, puts the keyboard on its first row; its list never runs past the window", () => {
    const old = fu("old", 9, 0, {
      before: true,
      state: "over",
      at: new Date("2026-10-03T10:30:00Z").toISOString(),
    });
    render(<Held items={[old, fu("a", 12)]} />);
    fireEvent.click(screen.getByRole("button", { name: "1 from before" }));
    const panel = document.querySelector("[data-day-panel]") as HTMLElement;
    expect(document.activeElement).toBe(within(panel).getByRole("link"));
  });

  it("a thing that vanishes in a live update takes its panel with it", () => {
    const { rerender } = render(<Held items={[fu("a", 12), fu("b", 16)]} />);
    fireEvent.pointerEnter(chips()[1]!);
    rerender(<Held items={[fu("a", 12)]} />);
    expect(document.querySelector("[data-day-panel]")).toBeNull();
    expect(scroller().className).not.toMatch(/focusing/);
  });
});

/** A touch event with the given finger positions (jsdom has no Touch constructor). */
const touches = (el: Element, type: string, pts: [number, number][]) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = pts.map(([clientX, clientY], identifier) => ({ clientX, clientY, identifier }));
  Object.defineProperty(e, "touches", { value: Object.assign(list, { item: (i: number) => list[i] }) });
  el.dispatchEvent(e);
  return e;
};
const gesture = (el: Element, type: string, scale: number, clientX?: number) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "scale", { value: scale });
  if (clientX != null) Object.defineProperty(e, "clientX", { value: clientX });
  el.dispatchEvent(e);
};

describe("DayTimeline: second review (2026-11-15)", () => {
  it("a panel that closes with the keyboard inside it hands focus back to its item (here: a drag starts)", () => {
    const old = fu("old", 9, 0, {
      before: true,
      state: "over",
      at: new Date("2026-10-03T10:30:00Z").toISOString(),
    });
    render(<Held items={[old, fu("a", 12)]} />);
    const pile = screen.getByRole("button", { name: "1 from before" });
    fireEvent.click(pile);
    expect(document.activeElement?.closest("[data-day-panel]")).not.toBeNull();
    act(() => {
      mouse(scroller(), "pointerdown", 500);
      mouse(scroller(), "pointermove", 480);
    });
    expect(document.querySelector("[data-day-panel]")).toBeNull();
    expect(document.activeElement).toBe(pile);
  });

  it("iOS: a two-finger pinch zooms once, not once for its touches and again for its gesture events", () => {
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    const pph = () => Number(screen.getByTestId("pph").textContent);
    act(() => {
      touches(s, "touchstart", [
        [300, 100],
        [400, 100],
      ]);
      gesture(s, "gesturestart", 1, 350);
      touches(s, "touchmove", [
        [280, 100],
        [420, 100],
      ]);
      gesture(s, "gesturechange", 1.4, 350);
    });
    expect(pph()).toBeCloseTo(140 * 1.4, 6);
  });

  it("a gesture with no position (Safari) zooms around the middle instead of jumping to the start", () => {
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    act(() => {
      s.scrollLeft = 600;
    });
    act(() => {
      gesture(s, "gesturestart", 1);
      gesture(s, "gesturechange", 1.2);
    });
    expect(Number.isFinite(s.scrollLeft)).toBe(true);
    expect(s.scrollLeft).toBeGreaterThan(300);
  });

  it("a wheel during the give at an end puts the day back in place", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance", "Date"] });
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    const canvas = document.querySelector("[data-day-canvas]") as HTMLElement;
    act(() => {
      s.scrollLeft = 0;
      mouse(s, "pointerdown", 300);
      mouse(s, "pointermove", 400); // past the start: it gives
      mouse(s, "pointerup", 400);
    });
    expect(canvas.style.transform).toMatch(/translateX/);
    act(() => {
      s.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: -10,
          clientX: 400,
        }),
      );
    });
    expect(canvas.style.transform).toBe("");
  });
});

/** A real browser keeps scrollLeft in whole pixels (jsdom keeps fractions, which hid a never-ending ease). */
function wholePixels(el: HTMLElement) {
  let v = el.scrollLeft;
  Object.defineProperty(el, "scrollLeft", {
    configurable: true,
    get: () => v,
    set: (n: number) => {
      v = Math.round(n);
    },
  });
}

describe("DayTimeline: third review (2026-11-16)", () => {
  it("the wheel's ease ends with whole-pixel scrolling, and lets go of the timeline when it's done", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    wholePixels(s);
    const from = s.scrollLeft;
    act(() => {
      s.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 }));
    });
    act(() => vi.advanceTimersByTime(2000));
    expect(s.scrollLeft).toBe(Math.round(from + 100));
    // Done: something else moving the timeline afterwards (a zoom button, the keyboard) isn't pulled back.
    act(() => {
      s.scrollLeft = 50;
      fireEvent.scroll(s);
    });
    act(() => vi.advanceTimersByTime(500));
    expect(s.scrollLeft).toBe(50);
  });

  it("a scroll the wheel didn't cause (a zoom button, the keyboard) stops the ease at once", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
    render(<Held items={[fu("a", 12)]} start={140} />);
    const s = scroller();
    wholePixels(s);
    act(() => {
      s.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 300 }));
    });
    act(() => vi.advanceTimersByTime(16));
    act(() => {
      s.scrollLeft = 40;
      fireEvent.scroll(s);
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(s.scrollLeft).toBe(40);
  });

  it("a press inside the panel isn't a drag of the timeline", () => {
    render(<Held items={[fu("a", 12), fu("b", 16)]} start={140} />);
    fireEvent.pointerEnter(chips()[1]!);
    const panel = document.querySelector("[data-day-panel]") as HTMLElement;
    const s = scroller();
    const from = s.scrollLeft;
    act(() => {
      mouse(panel, "pointerdown", 500);
      mouse(panel, "pointermove", 470);
      mouse(panel, "pointerup", 470);
    });
    expect(s.scrollLeft).toBe(from);
    expect(document.querySelector("[data-day-panel]")).not.toBeNull();
  });

  it("a thing that vanishes while the keyboard is in its panel leaves focus in the window, not on the page", () => {
    const old = fu("old", 9, 0, {
      before: true,
      state: "over",
      at: new Date("2026-10-03T10:30:00Z").toISOString(),
    });
    const { rerender } = render(
      <div role="dialog" aria-label="Your day" tabIndex={-1}>
        <Held items={[old, fu("a", 12)]} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "1 from before" }));
    expect(document.activeElement?.closest("[data-day-panel]")).not.toBeNull();
    rerender(
      <div role="dialog" aria-label="Your day" tabIndex={-1}>
        <Held items={[fu("a", 12)]} />
      </div>,
    );
    expect(document.querySelector("[data-day-panel]")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("in a window, the panel lives inside it (screen readers, Tab order); outside one, on the page", () => {
    const { unmount } = render(
      <div role="dialog" aria-label="Your day" tabIndex={-1}>
        <Held items={[fu("a", 12)]} />
      </div>,
    );
    fireEvent.pointerEnter(chips()[0]!);
    expect(document.querySelector("[data-day-panel]")!.closest('[role="dialog"]')).not.toBeNull();
    unmount();
    render(<Held items={[fu("a", 12)]} />);
    fireEvent.pointerEnter(chips()[0]!);
    expect(document.querySelector("[data-day-panel]")!.parentElement!.closest('[role="dialog"]')).toBeNull();
  });
});
