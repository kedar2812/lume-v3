import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TimezonePicker } from "./TimezonePicker";

// jsdom draws nothing, so it has no scrollIntoView: the list keeps its active option in view with it.
Element.prototype.scrollIntoView = vi.fn();

describe("TimezonePicker", () => {
  it("Escape closes its open list only — not the sheet or panel around it", async () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(e) => e.key === "Escape" && outer()}>
        <label htmlFor="tz">Time zone</label>
        <TimezonePicker value="Asia/Kolkata" onChange={vi.fn()} control={{ id: "tz" } as never} />
      </div>,
    );
    const box = screen.getByRole("combobox");
    await userEvent.click(box);
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    // With the list closed, Escape is the sheet's again.
    await userEvent.keyboard("{Escape}");
    expect(outer).toHaveBeenCalledTimes(1);
  });
});
