import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Scrim } from "./Scrim";

describe("Scrim (7C)", () => {
  it("sits on <body>, outside the page that opened it, so nothing there can crop it", () => {
    render(
      <main data-testid="page" style={{ transform: "translateY(0)" }}>
        <Scrim>
          <div role="dialog" aria-label="A popup" />
        </Scrim>
      </main>,
    );
    const layer = screen.getByRole("dialog", { name: "A popup" }).parentElement!;
    expect(layer).toHaveAttribute("data-scrim");
    expect(layer.parentElement).toBe(document.body);
    expect(screen.getByTestId("page")).not.toContainElement(layer);
  });

  it("a click on the dimmed window closes; a click in the popup doesn't", async () => {
    const onClose = vi.fn();
    render(
      <Scrim onClose={onClose}>
        <div role="dialog" aria-label="A popup">
          <button type="button">Inside</button>
        </div>
      </Scrim>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Inside" }));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(document.querySelector("[data-scrim] > [aria-hidden]")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
