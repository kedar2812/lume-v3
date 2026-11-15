import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DayItem } from "@/lib/today/day-items";
import { GroupPanel, ItemPanel } from "./ItemPanel";
import { useItemFocus } from "./useItemFocus";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-10-05T06:10:00Z"); // 11:40 am in Kolkata
const at = (hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 5, hh, mm) - 330 * 60_000).toISOString();
const fu = (id: string, hh: number, state: DayItem["state"], title = `Task ${id}`): DayItem => ({
  id,
  kind: "follow_up",
  at: at(hh),
  endsAt: null,
  title,
  lead: { id: `l-${id}`, name: `Lead ${id}` },
  state,
  link: null,
  before: false,
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

describe("ItemPanel: one panel, the same wherever it shows", () => {
  it("a follow-up: its words first, then the lead and time, its state, and Open lead", () => {
    render(<ItemPanel item={fu("p", 12, "soon", "Send pricing PDF")} now={NOW} tz={TZ} />);
    expect(screen.getByText("Send pricing PDF")).toBeTruthy();
    expect(screen.getByText("Lead p")).toBeTruthy();
    expect(screen.getByText("12 pm")).toBeTruthy();
    expect(screen.getByText("Due soon").getAttribute("data-tone")).toBe("warn");
    expect(screen.getByRole("link", { name: "Open lead" }).getAttribute("href")).toBe("/leads?lead=l-p");
    expect(screen.queryByRole("link", { name: "Join" })).toBeNull();
  });

  it("a call before it ends, with a link: Join (in a new tab) and Open lead; after it ends, only Open lead", () => {
    const { unmount } = render(<ItemPanel item={call("c", 15)} now={NOW} tz={TZ} />);
    const join = screen.getByRole("link", { name: "Join" });
    expect(join.getAttribute("href")).toBe("https://meet.example/x");
    expect(join.getAttribute("target")).toBe("_blank");
    expect(join.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText("3 pm – 3:30 pm")).toBeTruthy();
    unmount();
    render(<ItemPanel item={call("c", 9, { state: "done" })} now={NOW} tz={TZ} />);
    expect(screen.queryByRole("link", { name: "Join" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open lead" })).toBeTruthy();
  });

  it("renders the same for the same item, so the card and the timeline can't drift apart", () => {
    const a = render(<ItemPanel item={fu("p", 12, "soon")} now={NOW} tz={TZ} />).container.innerHTML;
    const b = render(<ItemPanel item={fu("p", 12, "soon")} now={NOW} tz={TZ} />).container.innerHTML;
    expect(a).toBe(b);
  });
});

describe("GroupPanel: several at about the same time", () => {
  it("names how many and when, and each row opens its own lead", () => {
    render(
      <GroupPanel
        items={[fu("a", 16, "later", "Check if she paid"), fu("b", 16, "over", "Send diet plan")]}
        now={NOW}
        tz={TZ}
      />,
    );
    expect(screen.getByText("2 follow-ups around 4 pm")).toBeTruthy();
    const rows = screen.getAllByRole("link");
    expect(rows.map((r) => r.getAttribute("href"))).toEqual(["/leads?lead=l-a", "/leads?lead=l-b"]);
    expect(rows[0]!.textContent).toContain("Check if she paid");
    expect(rows[0]!.textContent).toContain("Lead a");
  });
});

/** Two items and the panel, as the card and the timeline wire them. */
function Harness({ onOpen }: { onOpen: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const f = useItemFocus();
  return (
    <div ref={box} data-testid="box" className={f.focused ? "focusing" : undefined}>
      {["a", "b"].map((id) => (
        <a
          key={id}
          href={`#${id}`}
          data-day-item
          data-on={f.focused?.key === id || undefined}
          {...f.bind(id)}
          onClickCapture={(e) => {
            // The hook's click handler runs after this one (bubble phase), on its own synthetic event: read the native
            // event once both have run, to record what got through.
            const native = e.nativeEvent;
            setTimeout(() => !native.defaultPrevented && onOpen(id));
          }}
        >
          {id}
        </a>
      ))}
      {f.focused && (
        <div data-testid="panel" {...f.panelBind}>
          panel {f.focused.key}
          <button type="button" aria-label="act" />
          <button type="button" aria-label="act2" />
        </div>
      )}
    </div>
  );
}

const touch = (el: Element, type: string) =>
  el.dispatchEvent(
    Object.defineProperties(new MouseEvent(type, { bubbles: true, cancelable: true }), {
      pointerType: { value: "touch" },
      pointerId: { value: 1 },
    }),
  );

describe("useItemFocus: hover, keyboard and touch bring one item forward", () => {
  afterEach(() => vi.useRealTimers());

  it("hover brings it forward; leaving closes after a short grace, unless the pointer reaches the panel", () => {
    vi.useFakeTimers();
    render(<Harness onOpen={() => {}} />);
    fireEvent.pointerEnter(screen.getByText("a"));
    expect(screen.getByTestId("panel").textContent).toBe("panel a");
    expect(screen.getByTestId("box").className).toBe("focusing");
    expect(screen.getByText("a").hasAttribute("data-on")).toBe(true);
    fireEvent.pointerLeave(screen.getByText("a"));
    act(() => vi.advanceTimersByTime(60));
    fireEvent.pointerEnter(screen.getByTestId("panel"));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId("panel")).toBeTruthy();
    fireEvent.pointerLeave(screen.getByTestId("panel"));
    act(() => vi.advanceTimersByTime(119));
    expect(screen.queryByTestId("panel")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2));
    expect(screen.queryByTestId("panel")).toBeNull();
    expect(screen.getByTestId("box").className).toBe("");
  });

  it("keyboard: focus opens it, Esc closes it", () => {
    render(<Harness onOpen={() => {}} />);
    act(() => screen.getByText("b").focus());
    expect(screen.getByTestId("panel").textContent).toBe("panel b");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("touch: first tap peeks, a second tap opens", async () => {
    vi.useFakeTimers();
    const opened: string[] = [];
    render(<Harness onOpen={(id) => opened.push(id)} />);
    const a = screen.getByText("a");
    act(() => {
      touch(a, "pointerdown");
      a.click();
    });
    act(() => vi.runAllTimers());
    expect(screen.getByTestId("panel").textContent).toBe("panel a");
    expect(opened).toEqual([]);
    act(() => {
      touch(a, "pointerdown");
      a.click();
    });
    act(() => vi.runAllTimers());
    expect(opened).toEqual(["a"]);
  });

  it("a mouse click opens at once", () => {
    vi.useFakeTimers();
    const opened: string[] = [];
    render(<Harness onOpen={(id) => opened.push(id)} />);
    fireEvent.pointerDown(screen.getByText("b"));
    fireEvent.click(screen.getByText("b"));
    act(() => vi.runAllTimers());
    expect(opened).toEqual(["b"]);
  });
});

describe("useItemFocus inside the full screen", () => {
  it("Esc closes an open panel first, and only the next Esc reaches the window around it", () => {
    const closes: string[] = [];
    render(
      <div
        onKeyDown={(e) => {
          // What the full screen's modal focus does with Escape.
          if (e.key === "Escape") {
            e.stopPropagation();
            closes.push("window");
          }
        }}
      >
        <Harness onOpen={() => {}} />
      </div>,
    );
    const a = screen.getByText("a");
    act(() => a.focus());
    expect(screen.getByTestId("panel")).toBeTruthy();
    fireEvent.keyDown(a, { key: "Escape" });
    expect(screen.queryByTestId("panel")).toBeNull();
    expect(closes).toEqual([]);
    fireEvent.keyDown(a, { key: "Escape" });
    expect(closes).toEqual(["window"]);
  });
});

describe("useItemFocus: review fixes (2026-11-15)", () => {
  afterEach(() => vi.useRealTimers());

  it("touch on Chrome: the browser focuses the tapped link before its click, and the first tap still only peeks", () => {
    vi.useFakeTimers();
    const opened: string[] = [];
    render(<Harness onOpen={(id) => opened.push(id)} />);
    const a = screen.getByText("a");
    act(() => {
      touch(a, "pointerdown");
      a.focus(); // what Chrome does on the mousedown it fires after a tap
    });
    act(() => a.click());
    act(() => vi.runAllTimers());
    expect(screen.getByTestId("panel").textContent).toBe("panel a");
    expect(opened).toEqual([]);
    act(() => {
      touch(a, "pointerdown");
      a.click();
    });
    act(() => vi.runAllTimers());
    expect(opened).toEqual(["a"]);
  });

  it("a press anywhere else closes it (touch has no pointer-leave)", () => {
    render(<Harness onOpen={() => {}} />);
    const a = screen.getByText("a");
    act(() => {
      touch(a, "pointerdown");
      a.click();
    });
    expect(screen.getByTestId("panel")).toBeTruthy();
    act(() => {
      touch(document.body, "pointerdown");
    });
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("a press on the panel itself keeps it open", () => {
    render(<Harness onOpen={() => {}} />);
    act(() => screen.getByText("a").focus());
    act(() => {
      touch(screen.getByRole("button", { name: "act" }), "pointerdown");
    });
    expect(screen.getByTestId("panel")).toBeTruthy();
  });

  it("keyboard: Down arrow moves into the panel; Esc there closes it and goes back to the item", () => {
    render(<Harness onOpen={() => {}} />);
    const a = screen.getByText("a");
    act(() => a.focus());
    fireEvent.keyDown(a, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "act" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByTestId("panel")).toBeNull();
    expect(document.activeElement).toBe(a);
  });
});

describe("useItemFocus: second review (2026-11-15)", () => {
  afterEach(() => vi.useRealTimers());

  it("keyboard inside the panel: the pointer leaving doesn't close it under the keyboard", () => {
    vi.useFakeTimers();
    render(<Harness onOpen={() => {}} />);
    const a = screen.getByText("a");
    act(() => a.focus());
    fireEvent.keyDown(a, { key: "ArrowDown" });
    fireEvent.pointerLeave(a);
    fireEvent.pointerLeave(screen.getByTestId("panel"));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId("panel")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "act" }));
  });

  it("Tab moves through the panel's own controls and isn't taken by the window around it; past the end it goes back to the item", () => {
    const outer: string[] = [];
    render(
      <div onKeyDown={(e) => e.key === "Tab" && outer.push(e.shiftKey ? "shift-tab" : "tab")}>
        <Harness onOpen={() => {}} />
      </div>,
    );
    const a = screen.getByText("a");
    act(() => a.focus());
    fireEvent.keyDown(a, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "act2" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "act" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(a);
    expect(outer).toEqual([]);
  });

  it("touch: scrolling or lifting a finger inside the panel doesn't close it", () => {
    vi.useFakeTimers();
    render(<Harness onOpen={() => {}} />);
    const a = screen.getByText("a");
    act(() => {
      touch(a, "pointerdown");
      a.click();
    });
    act(() => {
      touch(screen.getByTestId("panel"), "pointerout");
    });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId("panel")).toBeTruthy();
  });

  it("after Esc hands focus back, Down arrow opens the panel again and goes in", () => {
    render(<Harness onOpen={() => {}} />);
    const a = screen.getByText("a");
    act(() => a.focus());
    fireEvent.keyDown(a, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByTestId("panel")).toBeNull();
    fireEvent.keyDown(a, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "act" }));
  });
});

describe("useItemFocus: third review (2026-11-16)", () => {
  afterEach(() => vi.useRealTimers());

  it("Shift+Tab past the panel's first control goes back to the item and the panel stays open", () => {
    vi.useFakeTimers();
    render(<Harness onOpen={() => {}} />);
    const a = screen.getByText("a");
    act(() => a.focus());
    fireEvent.keyDown(a, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(a);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByTestId("panel").textContent).toBe("panel a");
  });

  it("with the keyboard in a panel, hovering another item doesn't switch the panel under it", () => {
    render(<Harness onOpen={() => {}} />);
    const a = screen.getByText("a");
    act(() => a.focus());
    fireEvent.keyDown(a, { key: "ArrowDown" });
    fireEvent.pointerEnter(screen.getByText("b"));
    expect(screen.getByTestId("panel").textContent).toBe("panel a");
  });
});
