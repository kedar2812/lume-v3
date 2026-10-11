import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popover } from "./Popover";

/** Puts the trigger at a height in a 800px-tall window. */
function triggerAt(top: number, bottom: number) {
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
}
afterEach(() => vi.restoreAllMocks());

const open = async (side?: "below" | "above" | "auto") => {
  render(
    <Popover label="Panel" trigger="Open" size="form" side={side}>
      <p>Inside</p>
    </Popover>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  return screen.getByRole("dialog", { name: "Panel" });
};

describe("Popover closing", () => {
  it("leaves the way it came (a short exit), then is gone", async () => {
    const panel = await open("below");
    await userEvent.keyboard("{Escape}");
    expect(panel).toHaveAttribute("data-closing");
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Panel" })).not.toBeInTheDocument());
  });
});

describe("Popover placement (4C)", () => {
  it("auto: below while there's room below", async () => {
    triggerAt(100, 132);
    expect(await open("auto")).toHaveAttribute("data-side", "below");
  });
  it("auto: above when the trigger sits low and there's more room above, never taller than the room", async () => {
    triggerAt(600, 632);
    const panel = await open("auto");
    expect(panel).toHaveAttribute("data-side", "above");
    expect(panel.style.maxHeight).toContain("588px");
  });
  it("a fixed side stays where it's asked, fitted to its room", async () => {
    triggerAt(600, 632);
    const panel = await open("below");
    expect(panel).toHaveAttribute("data-side", "below");
    expect(panel.style.maxHeight).toContain("160px");
  });
});

describe("Popover placement: sideways (tour, 2026-10-11)", () => {
  /** The trigger's box and the panel's width in a 1440px-wide window; everything else measures as the trigger. */
  function across(left: number, width: number, panelWidth: number) {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 100,
      bottom: 132,
      left,
      right: left + width,
      width,
      height: 32,
      x: left,
      y: 100,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(panelWidth);
  }

  it("start-aligned, but turned to end when it would run past the window's right edge", async () => {
    // A drawer's Follow-up near the right: a 480px form from x=1100 would end at 1580.
    across(1100, 130, 480);
    expect(await open("below")).toHaveAttribute("data-align", "end");
  });
  it("stays start-aligned while it fits", async () => {
    across(200, 130, 480);
    expect(await open("below")).toHaveAttribute("data-align", "start");
  });
  it("focuses its first field without scrolling anything sideways", async () => {
    across(1100, 130, 480);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    render(
      <Popover label="Form" trigger="Go" size="form">
        <input aria-label="What" />
      </Popover>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe("Popover on <body> (tour, 2026-10-11)", () => {
  /** A clipping parent (the bulk island is overflow: hidden) must not hide the panel. */
  const openPortal = async () => {
    render(
      <div data-testid="clip" style={{ overflow: "hidden" }}>
        <Popover label="Queue" trigger="Message" size="form" side="above" align="end" portal>
          <button type="button">Choose</button>
        </Popover>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Message" }));
    return screen.getByRole("dialog", { name: "Queue" });
  };

  it("renders the panel on <body>, outside the clipping parent, fixed beside its trigger", async () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 820,
      bottom: 860,
      left: 900,
      right: 1000,
      width: 100,
      height: 40,
      x: 900,
      y: 820,
      toJSON: () => ({}),
    });
    const panel = await openPortal();
    expect(screen.getByTestId("clip")).not.toContainElement(panel);
    expect(panel.parentElement).toBe(document.body);
    expect(panel.style.position).toBe("fixed");
    // Above its trigger, lined up with its right edge.
    expect(panel.style.bottom).toBe("86px");
    expect(panel.style.right).toBe("440px");
  });

  it("stays open when something inside it is clicked, and closes on a click outside", async () => {
    const panel = await openPortal();
    await userEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(panel).toBeInTheDocument();
    expect(panel).not.toHaveAttribute("data-closing");
    await userEvent.click(document.body);
    expect(panel).toHaveAttribute("data-closing");
  });
});
