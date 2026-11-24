import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GNode } from "@lume/core/shared";
import { testCatalog } from "@/lib/leads/test-catalog";
import { Inspector } from "./Inspector";

/** The step's panel (plan 2026-11-23-flow-builder, Task B2): every setting, Instagram's limits as they're written. */
const catalog = { ...testCatalog(), tags: [{ id: "t-hot", label: "Hot", color: "#f00" }] };
const show = (node: GNode, onChange = vi.fn(), onDelete = vi.fn()) => {
  render(
    <Inspector
      node={node}
      problems={[]}
      catalog={catalog}
      flows={[]}
      onChange={onChange}
      onDelete={onDelete}
      onClose={vi.fn()}
    />,
  );
  return { onChange, onDelete };
};
const msg: GNode = { id: "m", type: "message", text: "Hi", buttons: [], replies: [], next: null };

describe("the step's panel", () => {
  it("a message's words change the step, whole; Instagram's limits are said as it's written", () => {
    const { onChange } = show({ ...msg, text: "x".repeat(1001) });
    expect(screen.getByText("1,001 of 1,000")).toBeInTheDocument();
    expect(
      screen.getByText(/This message is too long for Instagram: 1001 of 1000 bytes/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: /Message/ }), { target: { value: "Hello there" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...msg, text: "Hello there" });
  });

  it("quick replies or buttons, never both; a reply's words at most 20", async () => {
    const { onChange } = show(msg);
    await userEvent.click(screen.getByRole("button", { name: "+ Add a quick reply" }));
    const withReply = onChange.mock.calls.at(-1)![0] as Extract<GNode, { type: "message" }>;
    expect(withReply.replies).toHaveLength(1);
    expect(withReply.replies[0]!.next).toBeNull();
  });

  it("with a reply, Add a button isn't offered (Instagram takes one kind)", () => {
    show({ ...msg, replies: [{ id: "r", title: "Yes", next: null }] });
    expect(screen.queryByRole("button", { name: "+ Add a button" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Quick reply" })).toHaveAttribute("maxlength", "20");
    expect(
      screen.getByText("Instagram takes quick replies or buttons in one message, not both."),
    ).toBeInTheDocument();
  });

  it("a question with choices starts with two to fill in", () => {
    const ask: GNode = {
      id: "q",
      type: "ask",
      text: "Which?",
      save: { field: "plan", kind: "text" },
      retry: "Tap one.",
      next: null,
      noAnswer: { afterMinutes: 0, next: null },
    };
    const { onChange } = show(ask);
    fireEvent.change(screen.getByRole("combobox", { name: "The answer is" }), {
      target: { value: "choice" },
    });
    const next = onChange.mock.calls.at(-1)![0] as Extract<GNode, { type: "ask" }>;
    expect(next.save.kind).toBe("choice");
    expect(next.choices).toHaveLength(2);
  });

  it("a check's tag rule picks from the business's own tags", () => {
    const check: GNode = {
      id: "c",
      type: "check",
      match: "all",
      rules: [{ on: "tag", key: "", op: "is" }],
      yes: null,
      no: null,
    };
    const { onChange } = show(check);
    fireEvent.change(screen.getByRole("combobox", { name: "Tag" }), { target: { value: "t-hot" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...check, rules: [{ on: "tag", key: "t-hot", op: "is" }] });
  });

  it("a split test says when its paths don't add up to 100%", () => {
    show({
      id: "s",
      type: "split",
      paths: [
        { id: "a", weight: 60, next: null },
        { id: "b", weight: 30, next: null },
      ],
    });
    expect(screen.getByText("90% of 100%")).toHaveAttribute("data-off");
  });

  it("a wait of 120 minutes stays in minutes as it's typed; the number can be cleared to type another", () => {
    const wait: GNode = { id: "w", type: "wait", for: { minutes: 5 }, next: null };
    const { onChange } = show(wait);
    const box = screen.getByRole("spinbutton", { name: "How long" });
    fireEvent.change(box, { target: { value: "" } });
    expect(box).toHaveValue(null);
    fireEvent.change(box, { target: { value: "120" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...wait, for: { minutes: 120 } });
    expect(screen.getByRole("combobox", { name: "Unit" })).toHaveValue("1");
  });

  it("Delete removes the step", async () => {
    const { onDelete } = show(msg);
    await userEvent.click(
      within(screen.getByRole("complementary", { name: "Message step" })).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(onDelete).toHaveBeenCalled();
  });
});
