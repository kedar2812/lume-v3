import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import { CatalogProvider } from "../CatalogProvider";
import { FieldEditor } from "./FieldEditor";

const cat = testCatalog();
const def = (key: string) => cat.fields.find((f) => f.key === key)!;
const edit = (key: string, value: unknown, catalog = cat) => {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <CatalogProvider catalog={catalog}>
      <FieldEditor def={def(key)} value={value} onCommit={onCommit} onCancel={onCancel} autoFocus />
    </CatalogProvider>,
  );
  return { onCommit, onCancel, ...utils };
};

describe("FieldEditor", () => {
  it("commits text on Enter and cancels on Escape without saving", async () => {
    const a = edit("name", "Aisha");
    const box = screen.getByRole("textbox", { name: "Name" });
    expect(box).toHaveFocus();
    await userEvent.clear(box);
    await userEvent.type(box, "Aisha K{Enter}");
    expect(a.onCommit).toHaveBeenCalledWith("Aisha K");
    a.unmount();
    const b = edit("name", "Aisha");
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), "zz{Escape}");
    expect(b.onCancel).toHaveBeenCalled();
    expect(b.onCommit).not.toHaveBeenCalled();
  });

  it("commits when focus leaves, but not when nothing changed", async () => {
    const a = edit("name", "Aisha");
    await userEvent.type(screen.getByRole("textbox", { name: "Name" }), " K");
    await userEvent.tab();
    expect(a.onCommit).toHaveBeenCalledWith("Aisha K");
    a.unmount();
    const b = edit("name", "Aisha");
    await userEvent.tab();
    expect(b.onCommit).not.toHaveBeenCalled();
    expect(b.onCancel).toHaveBeenCalled();
  });

  it("edits money as a number, refusing text", async () => {
    const a = edit("value", 4500);
    const box = screen.getByRole("textbox", { name: "Deal value" });
    await userEvent.clear(box);
    await userEvent.type(box, "4,750.50{Enter}");
    expect(a.onCommit).toHaveBeenCalledWith(4750.5);
    a.unmount();
    const b = edit("value", 4500);
    const box2 = screen.getByRole("textbox", { name: "Deal value" });
    await userEvent.clear(box2);
    await userEvent.type(box2, "lots{Enter}");
    expect(b.onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/number/i);
  });

  it("clears a value when the box is emptied", async () => {
    const a = edit("value", 4500);
    await userEvent.clear(screen.getByRole("textbox", { name: "Deal value" }));
    await userEvent.keyboard("{Enter}");
    expect(a.onCommit).toHaveBeenCalledWith(null);
  });

  it("picks several options and commits them as ids, in option order", async () => {
    const a = edit("struggles", []);
    await userEvent.click(screen.getByRole("checkbox", { name: "Career switch" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Confidence" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(a.onCommit).toHaveBeenCalledWith(["o1", "o2"]);
  });

  it("offers only active people for a person field", () => {
    edit("handled_by", null, {
      ...cat,
      people: [...cat.people, { id: "u-old", name: "Old Rep", active: false }],
    });
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("Riya Sharma");
    expect(options).not.toContain("Old Rep");
  });
});
