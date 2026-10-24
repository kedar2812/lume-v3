import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

let phone = false;
vi.mock("@/lib/usePhone", () => ({ usePhone: () => phone }));

const open = (onClose = vi.fn()) => {
  render(
    <>
      <button type="button">Before</button>
      <Sheet
        label="Let LUME AI handle 3 leads"
        onClose={onClose}
        footer={<button type="button">Start</button>}
      >
        <input aria-label="First field" />
      </Sheet>
    </>,
  );
  return onClose;
};

beforeEach(() => {
  phone = false;
});

/** A sheet (Autopilot A3): a right-side panel on a computer, a bottom sheet on a phone (spec 2026-10-19 §1, §2.3). */
describe("Sheet", () => {
  it("a modal dialog with its name; focus moves in and stays in", async () => {
    open();
    const d = screen.getByRole("dialog", { name: "Let LUME AI handle 3 leads" });
    expect(d).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close (Esc)" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText("First field")).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Start" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Close (Esc)" })).toHaveFocus();
  });

  it("Escape, the close button and the dimmed window each close it", async () => {
    const onClose = open();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
    await userEvent.click(document.querySelector("[data-sheet-scrim]")!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("on a phone it's a bottom sheet with a handle that closes it", async () => {
    phone = true;
    const onClose = open();
    const d = screen.getByRole("dialog", { name: "Let LUME AI handle 3 leads" });
    expect(d).toHaveAttribute("data-phone");
    await userEvent.click(screen.getByRole("button", { name: "Close, or drag down" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dragging the handle down and letting go short of closing isn't a tap to close", () => {
    phone = true;
    const onClose = open();
    const handle = screen.getByRole("button", { name: "Close, or drag down" });
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 160, pointerId: 1 });
    fireEvent.click(handle);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientY: 103, pointerId: 1 });
    fireEvent.click(handle);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
