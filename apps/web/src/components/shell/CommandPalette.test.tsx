import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

const go = vi.fn();
vi.mock("./PageTransition", () => ({ usePageNav: () => ({ go }) }));

describe("CommandPalette", () => {
  it("filters commands and runs the selected one with Enter", async () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} can={() => true} />);
    const input = screen.getByRole("combobox", { name: /search/i });
    await userEvent.type(input, "anal");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(go).toHaveBeenCalledWith("/analytics");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("never offers sections the role can't open", () => {
    render(<CommandPalette open onOpenChange={() => undefined} can={(p) => p === "leads.view"} />);
    expect(screen.queryByRole("option", { name: /Analytics/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Leads/ })).toBeInTheDocument();
  });

  it("moves the selection with the arrow keys", async () => {
    render(<CommandPalette open onOpenChange={() => undefined} can={() => true} />);
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  });
});
