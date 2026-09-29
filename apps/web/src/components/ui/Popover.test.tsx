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
