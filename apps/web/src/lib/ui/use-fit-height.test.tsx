import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFitHeight } from "./use-fit-height";

let top = 200;
function Panes({ on = true, min }: { on?: boolean; min?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useFitHeight(ref, { on, ...(min ? { min } : {}) });
  return <div ref={ref} data-testid="panes" />;
}
const panes = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-testid=panes]")!;

describe("useFitHeight: the LUME AI panes fill the window, so only what's in them scrolls (2026-11-01)", () => {
  beforeEach(() => {
    top = 200;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((f) => {
      f(0);
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ top }) as DOMRect);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("from where it starts to 24px above the window's foot, and again when the window changes", () => {
    const { container } = render(<Panes />);
    expect(panes(container).style.height).toBe("676px");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(panes(container).style.height).toBe("776px");
  });

  it("never shorter than its least; off (a phone, still loading), it's left to the page", () => {
    top = 700;
    const { container, rerender } = render(<Panes min={420} />);
    expect(panes(container).style.height).toBe("420px");
    rerender(<Panes on={false} />);
    expect(panes(container).style.height).toBe("");
  });
});
