import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popover, pressedWithin } from "./Popover";

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
  it("inline on the page's scroller, its room ends where the scroller ends, not the window (Analytics' Filters)", async () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    const box = (top: number, bottom: number) => ({
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
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-scroll") ? box(60, 700) : box(300, 332);
    });
    render(
      <div data-scroll style={{ overflowY: "auto" }}>
        <Popover label="Panel" trigger="Open" size="form">
          <p>Inside</p>
        </Popover>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    // 700 (the scroller's foot) - 332 - 12.
    expect(screen.getByRole("dialog", { name: "Panel" }).style.maxHeight).toContain("356px");
  });
  it("turns over when it doesn't fit below and there's more room above (owner, 2026-11-04: off the foot of a phone)", async () => {
    triggerAt(700, 732);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(143);
    expect(await open("below")).toHaveAttribute("data-side", "above");
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
  it("wider than the room on either side of its trigger: moved back onto the window (a phone)", async () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 60,
      bottom: 92,
      left: 140,
      right: 200,
      width: 60,
      height: 32,
      x: 140,
      y: 60,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(358);
    const panel = await open("below");
    // Start-aligned it would end at 498, past 382 (8px in from the edge): 116px back.
    expect(panel.style.getPropertyValue("--nudge")).toBe("-116px");
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

  it("goes on <body> by itself when its trigger sits inside something that clips (owner, 2026-11-04: the template sheet cut by the chat window)", async () => {
    render(
      <div data-testid="chat" style={{ overflow: "hidden" }}>
        <Popover label="Templates" trigger="WhatsApp" size="form">
          <p>First hello</p>
        </Popover>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
    const panel = screen.getByRole("dialog", { name: "Templates" });
    expect(screen.getByTestId("chat")).not.toContainElement(panel);
    expect(panel.parentElement).toBe(document.body);
    expect(panel.style.position).toBe("fixed");
  });

  it("inside a dialog (a chat window, a lead's drawer) it goes into that dialog, so a screen reader in it still reaches it", async () => {
    render(
      <div role="dialog" aria-modal="true" aria-label="WhatsApp with Meera" style={{ overflow: "hidden" }}>
        <form aria-label="Reply" style={{ overflowY: "auto" }}>
          <Popover label="Attach" trigger="Add" role="menu">
            <button type="button" role="menuitem">
              From Media
            </button>
          </Popover>
        </form>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const panel = screen.getByRole("menu", { name: "Attach" });
    expect(panel.parentElement).toBe(screen.getByRole("dialog", { name: "WhatsApp with Meera" }));
    expect(panel.style.position).toBe("fixed");
  });

  it("a dialog that moves its fixed children with it (a transform) can't hold it: it goes on <body>", async () => {
    render(
      <div role="dialog" aria-label="Sliding" style={{ overflow: "hidden", transform: "translateX(0px)" }}>
        <Popover label="Attach" trigger="Add">
          <p>Inside</p>
        </Popover>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("dialog", { name: "Attach" }).parentElement).toBe(document.body);
  });

  it("stays beside its trigger on the page's own scroller, which scrolls it into view", async () => {
    render(
      <div data-testid="page" data-scroll style={{ overflowY: "auto" }}>
        <Popover label="Filter" trigger="Stage">
          <p>Inside</p>
        </Popover>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Stage" }));
    expect(screen.getByTestId("page")).toContainElement(screen.getByRole("dialog", { name: "Filter" }));
  });

  it("stays inline on the page's scroller even though the shell around it clips (the real app's .main)", async () => {
    render(
      <main style={{ overflow: "hidden" }}>
        <div data-testid="page" data-scroll style={{ overflowY: "auto" }}>
          <Popover label="Filter" trigger="Stage">
            <p>Inside</p>
          </Popover>
        </div>
      </main>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Stage" }));
    expect(screen.getByTestId("page")).toContainElement(screen.getByRole("dialog", { name: "Filter" }));
  });

  it("goes on <body> from a box that scrolls on its own (a chat's thread, its reply bar stuck to the foot)", async () => {
    render(
      <div data-scroll style={{ overflowY: "auto" }}>
        <div data-testid="thread" style={{ overflowY: "auto" }}>
          <Popover label="Templates" trigger="WhatsApp">
            <p>First hello</p>
          </Popover>
        </div>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
    const panel = screen.getByRole("dialog", { name: "Templates" });
    expect(screen.getByTestId("thread")).not.toContainElement(panel);
    expect(panel.parentElement).toBe(document.body);
  });

  it("on <body>, it follows its trigger as the page scrolls", async () => {
    let top = 300;
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      top,
      bottom: top + 40,
      left: 100,
      right: 200,
      width: 100,
      height: 40,
      x: 100,
      y: top,
      toJSON: () => ({}),
    }));
    render(
      <div style={{ overflow: "hidden" }}>
        <Popover label="Templates" trigger="WhatsApp">
          <p>First hello</p>
        </Popover>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
    const panel = screen.getByRole("dialog", { name: "Templates" });
    expect(panel.style.top).toBe("346px");
    top = 200;
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(panel.style.top).toBe("246px");
  });

  it("on <body>, a panel that grows after opening (its list loads) turns over when it no longer fits below", async () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 560,
      bottom: 590,
      left: 100,
      right: 200,
      width: 100,
      height: 30,
      x: 100,
      y: 560,
      toJSON: () => ({}),
    });
    let tall = 120;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => tall);
    render(
      <div style={{ overflow: "hidden" }}>
        <Popover label="Save view" trigger="Save view" size="form">
          <p>Name</p>
        </Popover>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Save view" }));
    const panel = screen.getByRole("dialog", { name: "Save view" });
    expect(panel).toHaveAttribute("data-side", "below");
    tall = 260;
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    });
    expect(panel).toHaveAttribute("data-side", "above");
  });

  it("a panel opened from inside another stays its own: pressing in it never closes the one it came from", async () => {
    render(
      <div style={{ overflow: "hidden" }}>
        <Popover label="Outer" trigger="Filters" size="form">
          <div style={{ overflow: "hidden" }}>
            <Popover label="Inner" trigger="Stage">
              <button type="button">New</button>
            </Popover>
          </div>
        </Popover>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.click(screen.getByRole("button", { name: "Stage" }));
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeInTheDocument();
  });

  it("pressedWithin: a press in a panel whose trigger is inside a box counts as inside it (the notification centre)", async () => {
    render(
      <>
        <div data-testid="centre" style={{ overflow: "hidden" }}>
          <Popover label="WhatsApp Arjun" trigger="WhatsApp">
            <button type="button">First hello</button>
          </Popover>
        </div>
        <button type="button">Elsewhere</button>
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "WhatsApp" }));
    const centre = screen.getByTestId("centre");
    expect(pressedWithin(screen.getByRole("button", { name: "First hello" }), centre)).toBe(true);
    expect(pressedWithin(screen.getByRole("button", { name: "Elsewhere" }), centre)).toBe(false);
  });

  it("moved out of its trigger's box, Tab past its last control closes it and goes back to the trigger", async () => {
    render(
      <div style={{ overflow: "hidden" }}>
        <Popover label="Templates" trigger="WhatsApp">
          <button type="button">First hello</button>
          <button type="button">Thanks</button>
        </Popover>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "WhatsApp" });
    await userEvent.click(trigger);
    screen.getByRole("button", { name: "Thanks" }).focus();
    await userEvent.tab();
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Templates" })).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(trigger);
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
