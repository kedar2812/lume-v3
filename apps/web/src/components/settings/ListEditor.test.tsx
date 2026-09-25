import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ListEditor } from "./ListEditor";

const items = [
  { id: "a", label: "Price" },
  { id: "b", label: "Timing" },
];
const handlers = () => ({ onAdd: vi.fn(), onRename: vi.fn(), onReorder: vi.fn(), onArchive: vi.fn() });

describe("ListEditor", () => {
  it("adds, renames, reorders from the keyboard and archives only after asking", async () => {
    const h = handlers();
    render(<ListEditor items={items} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    await userEvent.type(screen.getByRole("textbox", { name: "New reason" }), "No budget{Enter}");
    expect(h.onAdd).toHaveBeenCalledWith("No budget");
    expect(screen.getByRole("textbox", { name: "New reason" })).toHaveValue("");

    await userEvent.click(screen.getByRole("button", { name: "Rename Price" }));
    const name = screen.getByRole("textbox", { name: "Reason name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Too expensive{Enter}");
    expect(h.onRename).toHaveBeenCalledWith("a", "Too expensive");

    screen.getByRole("button", { name: "Move Timing" }).focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(h.onReorder).toHaveBeenCalledWith(["b", "a"]);

    await userEvent.click(screen.getByRole("button", { name: "Archive Timing" }));
    expect(h.onArchive).not.toHaveBeenCalled();
    expect(screen.getByText(/Archive Timing\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(h.onArchive).toHaveBeenCalledWith("b");
  });

  it("cancels a rename with Escape and never adds an empty item", async () => {
    const h = handlers();
    render(<ListEditor items={items} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    await userEvent.type(screen.getByRole("textbox", { name: "New reason" }), "   {Enter}");
    expect(h.onAdd).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Rename Price" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Reason name" }), "zz{Escape}");
    expect(h.onRename).not.toHaveBeenCalled();
    expect(screen.getByText("Price")).toBeInTheDocument();
  });

  it("won't move the first item up or the last one down", async () => {
    const h = handlers();
    render(<ListEditor items={items} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    screen.getByRole("button", { name: "Move Price" }).focus();
    await userEvent.keyboard("{Alt>}{ArrowUp}{/Alt}");
    screen.getByRole("button", { name: "Move Timing" }).focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(h.onReorder).not.toHaveBeenCalled();
  });

  it("shows each item's extra controls, and hides archive where there is nothing to archive", () => {
    const h = handlers();
    render(
      <ListEditor
        items={items}
        itemLabel="Reason"
        addLabel="Add a reason"
        {...h}
        onArchive={undefined}
        renderExtra={(item) => <span>extra for {item.label}</span>}
      />,
    );
    expect(screen.getByText("extra for Price")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Archive/ })).not.toBeInTheDocument();
  });
});
