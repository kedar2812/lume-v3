import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { scrollsSideways, swipeOutcome, useSwipe } from "./useSwipe";

/** Where a swipe between files ends (apple-design §6): where it's headed, not where the finger let go. */
describe("a swipe between files", () => {
  const width = 400;
  const both = () => true;

  it("a quick short flick counts: it's thrown past half the width", () => {
    expect(swipeOutcome({ dx: -30, velocity: -900, width, canGo: both })).toBe("next");
    expect(swipeOutcome({ dx: 30, velocity: 900, width, canGo: both })).toBe("previous");
  });

  it("a slow drag under half the width springs back", () => {
    expect(swipeOutcome({ dx: -120, velocity: -60, width, canGo: both })).toBe("stay");
  });

  it("a slow drag past half the width goes", () => {
    expect(swipeOutcome({ dx: -230, velocity: -40, width, canGo: both })).toBe("next");
  });

  it("a flick back the other way cancels a long drag", () => {
    expect(swipeOutcome({ dx: -230, velocity: 900, width, canGo: both })).toBe("stay");
  });

  it("at the last file there's nowhere to go: it springs back", () => {
    expect(swipeOutcome({ dx: -300, velocity: -1500, width, canGo: (d) => d === "previous" })).toBe("stay");
  });
});

describe("where a swipe may start", () => {
  const box = (scrollWidth: number, overflowX: string) => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollWidth", { value: scrollWidth });
    Object.defineProperty(el, "clientWidth", { value: 300 });
    el.style.overflowX = overflowX;
    return el;
  };

  it("not on a table that scrolls sideways: that drag is its scroll", () => {
    const stage = document.createElement("div");
    const table = box(900, "auto");
    const cell = document.createElement("span");
    table.appendChild(cell);
    stage.appendChild(table);
    document.body.appendChild(stage);
    expect(scrollsSideways(cell, stage)).toBe(true);
  });

  it("on a photo, or a page that fits, it may", () => {
    const stage = document.createElement("div");
    const fits = box(300, "auto");
    const hidden = box(900, "hidden");
    hidden.appendChild(fits);
    stage.appendChild(hidden);
    document.body.appendChild(stage);
    expect(scrollsSideways(fits, stage)).toBe(false);
  });
});

describe("the swipe itself", () => {
  function Stage(p: { onSwipe(d: string): void; canGo?: (d: "next" | "previous") => boolean }) {
    const s = useSwipe({ enabled: true, canGo: p.canGo ?? (() => true), onSwipe: p.onSwipe });
    return <div data-testid="stage" style={{ width: 390 }} {...s.bind} />;
  }
  const drag = (el: HTMLElement, xs: number[], step = 16) => {
    let t = 0;
    const at = (type: string, x: number) =>
      fireEvent(
        el,
        Object.defineProperties(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 400 }), {
          pointerId: { value: 7 },
          pointerType: { value: "touch" },
          isPrimary: { value: true },
          timeStamp: { value: (t += step) },
        }),
      );
    at("pointerdown", xs[0]!);
    for (const x of xs.slice(1, -1)) at("pointermove", x);
    at("pointerup", xs.at(-1)!);
  };

  it("a finger thrown to the left moves to the next file", async () => {
    const onSwipe = vi.fn();
    render(<Stage onSwipe={onSwipe} />);
    drag(screen.getByTestId("stage"), [330, 300, 250, 190, 120, 120]);
    await waitFor(() => expect(onSwipe).toHaveBeenCalledWith("next"));
  });

  it("events that arrive all at once (a burst, a slow device catching up) still swipe, and soon", async () => {
    const onSwipe = vi.fn();
    render(<Stage onSwipe={onSwipe} />);
    drag(screen.getByTestId("stage"), [330, 300, 250, 190, 120, 120], 0);
    await waitFor(() => expect(onSwipe).toHaveBeenCalledWith("next"), { timeout: 900 });
  });

  it("a small slow drag doesn't", async () => {
    const onSwipe = vi.fn();
    render(<Stage onSwipe={onSwipe} />);
    drag(screen.getByTestId("stage"), [200, 196, 190, 185, 185], 400);
    await new Promise((r) => setTimeout(r, 900));
    expect(onSwipe).not.toHaveBeenCalled();
  });
});
