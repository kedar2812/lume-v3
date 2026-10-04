import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { ScrollRail, useWheelAcross } from "./ScrollRail";

/** jsdom lays nothing out: the strip's sizes are set by hand. */
function size(el: HTMLElement, o: { client: number; scroll: number }) {
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => o.client });
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => o.scroll });
}

function Strip({ client, scroll }: { client: number; scroll: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useWheelAcross(ref);
  return (
    <>
      <div
        data-testid="strip"
        ref={(el) => {
          ref.current = el;
          if (el) size(el, { client, scroll });
        }}
      />
      <ScrollRail target={ref} label="Scroll the stages" />
    </>
  );
}

describe("ScrollRail", () => {
  it("shows a thumb sized to what's in view when the strip overflows, and none when it fits", () => {
    const { rerender } = render(<Strip client={400} scroll={1000} />);
    const rail = screen.getByTitle("Scroll the stages");
    // The track is as wide as the strip here.
    size(rail, { client: 400, scroll: 400 });
    act(() => {
      fireEvent.scroll(screen.getByTestId("strip"));
    });
    const thumb = screen.getByTestId("scroll-thumb");
    expect(thumb.style.width).toBe("160px");
    expect(rail.hasAttribute("data-shown")).toBe(true);
    rerender(<Strip client={400} scroll={400} />);
    act(() => {
      fireEvent.scroll(screen.getByTestId("strip"));
    });
    expect(screen.queryByTestId("scroll-thumb")).toBeNull();
  });

  it("a mouse wheel scrolls the strip across until an end, then leaves the page to scroll", () => {
    render(<Strip client={400} scroll={1000} />);
    const strip = screen.getByTestId("strip");
    const down = new WheelEvent("wheel", { deltaY: 120, cancelable: true });
    strip.dispatchEvent(down);
    expect(strip.scrollLeft).toBe(120);
    expect(down.defaultPrevented).toBe(true);
    strip.scrollLeft = 600;
    const atEnd = new WheelEvent("wheel", { deltaY: 120, cancelable: true });
    strip.dispatchEvent(atEnd);
    expect(atEnd.defaultPrevented).toBe(false);
  });
});
