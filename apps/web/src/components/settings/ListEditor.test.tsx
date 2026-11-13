import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("shows what a caller puts before an item's name (a stage's colour dot)", () => {
    render(
      <ListEditor
        items={[{ id: "a", label: "New" }]}
        itemLabel="Stage"
        addLabel="Add a stage"
        leading={(item) => <i data-testid={`dot-${item.id}`} />}
      />,
    );
    const dot = screen.getByTestId("dot-a");
    expect(
      dot.compareDocumentPosition(screen.getByText("New")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

const three = [
  { id: "a", label: "Price" },
  { id: "b", label: "Timing" },
  { id: "c", label: "Trust" },
];
/** jsdom lays nothing out: each row is 40px tall, stacked from the top. */
const layOut = () => {
  const rows = screen.getAllByRole("listitem");
  rows.forEach((row, i) => {
    row.getBoundingClientRect = () =>
      ({
        top: i * 40,
        bottom: i * 40 + 40,
        height: 40,
        left: 0,
        right: 300,
        width: 300,
        x: 0,
        y: i * 40,
      }) as DOMRect;
  });
};
const press = (el: Element, y: number, pointerType = "mouse") =>
  fireEvent.pointerDown(el, {
    clientX: 10,
    clientY: y,
    button: 0,
    pointerId: 1,
    pointerType,
    isPrimary: true,
  });
const moveTo = (y: number) =>
  act(() => {
    fireEvent.pointerMove(window, { clientX: 10, clientY: y, pointerId: 1 });
  });
const lift = (y: number) =>
  act(() => {
    fireEvent.pointerUp(window, { clientX: 10, clientY: y, pointerId: 1 });
  });

describe("ListEditor drag to reorder", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drags a row by its handle to a new place, and saves the new order once, on the drop", () => {
    const h = handlers();
    render(<ListEditor items={three} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    layOut();
    press(screen.getByRole("button", { name: "Move Price" }), 20);
    moveTo(50);
    moveTo(70); // Price's middle (20) is now at 70: past Timing's (60), short of Trust's (100)
    expect(screen.getAllByRole("listitem")[0]).toHaveAttribute("data-dragging");
    expect(h.onReorder).not.toHaveBeenCalled(); // nothing saves mid-drag
    lift(70);
    expect(h.onReorder).toHaveBeenCalledTimes(1);
    expect(h.onReorder).toHaveBeenCalledWith(["b", "a", "c"]);
    expect(screen.getAllByRole("listitem")[0]).not.toHaveAttribute("data-dragging");
  });

  it("drags up to the very top, and down past the end clamps to last", () => {
    const h = handlers();
    render(<ListEditor items={three} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    layOut();
    press(screen.getByRole("button", { name: "Move Trust" }), 100);
    moveTo(-400);
    lift(-400);
    expect(h.onReorder).toHaveBeenLastCalledWith(["c", "a", "b"]);
    press(screen.getByRole("button", { name: "Move Price" }), 20);
    moveTo(900);
    lift(900);
    expect(h.onReorder).toHaveBeenLastCalledWith(["b", "c", "a"]);
  });

  it("drags a row by its name with a mouse, once it has moved a few pixels", () => {
    const h = handlers();
    render(<ListEditor items={three} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    layOut();
    press(screen.getByText("Trust"), 100);
    moveTo(102); // a click's wobble isn't a drag
    expect(screen.getAllByRole("listitem")[2]).not.toHaveAttribute("data-dragging");
    moveTo(30);
    lift(30);
    expect(h.onReorder).toHaveBeenCalledWith(["a", "c", "b"]);
  });

  it("never drags from the row's buttons, or from its name on touch (that's a scroll)", () => {
    const h = handlers();
    render(<ListEditor items={three} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    layOut();
    press(screen.getByRole("button", { name: "Rename Trust" }), 100);
    moveTo(10);
    lift(10);
    press(screen.getByText("Trust"), 100, "touch");
    moveTo(10);
    lift(10);
    expect(h.onReorder).not.toHaveBeenCalled();
  });

  it("drags on touch from the handle", () => {
    const h = handlers();
    render(<ListEditor items={three} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    layOut();
    press(screen.getByRole("button", { name: "Move Trust" }), 100, "touch");
    moveTo(10);
    lift(10);
    expect(h.onReorder).toHaveBeenCalledWith(["c", "a", "b"]);
  });

  it("dropping where it started, Escape, or a cancelled pointer saves nothing and puts the row back", () => {
    const h = handlers();
    render(<ListEditor items={three} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    layOut();
    const handle = () => screen.getByRole("button", { name: "Move Price" });
    press(handle(), 20);
    moveTo(70);
    moveTo(25);
    lift(25);
    press(handle(), 20);
    moveTo(90);
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.getAllByRole("listitem")[0]).not.toHaveAttribute("data-dragging");
    lift(90);
    press(handle(), 20);
    moveTo(90);
    act(() => {
      fireEvent.pointerCancel(window, { pointerId: 1 });
    });
    lift(90);
    expect(h.onReorder).not.toHaveBeenCalled();
  });

  it("moves with the arrow keys on a focused handle, with or without Alt", async () => {
    const h = handlers();
    render(<ListEditor items={three} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    screen.getByRole("button", { name: "Move Price" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(h.onReorder).toHaveBeenLastCalledWith(["b", "a", "c"]);
    expect(screen.getByText("Price moved to 2 of 3")).toBeInTheDocument();
  });

  it("a row asking whether to archive can't be dragged", async () => {
    const h = handlers();
    render(<ListEditor items={three} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    await userEvent.click(screen.getByRole("button", { name: "Archive Price" }));
    layOut();
    press(screen.getByText(/Leads keep it/), 20);
    moveTo(90);
    lift(90);
    expect(h.onReorder).not.toHaveBeenCalled();
  });

  it("leaving the window mid-drag puts the row back and saves nothing", () => {
    const h = handlers();
    render(<ListEditor items={three} itemLabel="Reason" addLabel="Add a reason" {...h} />);
    layOut();
    press(screen.getByRole("button", { name: "Move Price" }), 20);
    moveTo(90);
    act(() => {
      fireEvent.blur(window);
    });
    expect(screen.getAllByRole("listitem")[0]).not.toHaveAttribute("data-dragging");
    lift(90);
    expect(h.onReorder).not.toHaveBeenCalled();
  });

  it("has no handle, and no drag, where the list can't be reordered", () => {
    const h = handlers();
    render(
      <ListEditor items={three} itemLabel="Reason" addLabel="Add a reason" {...h} onReorder={undefined} />,
    );
    layOut();
    expect(screen.queryByRole("button", { name: "Move Price" })).toBeNull();
    press(screen.getByText("Price"), 20);
    moveTo(90);
    expect(screen.getAllByRole("listitem")[0]).not.toHaveAttribute("data-dragging");
    lift(90);
  });
});
