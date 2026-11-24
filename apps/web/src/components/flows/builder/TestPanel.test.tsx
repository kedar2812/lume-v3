import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FlowGraph } from "@lume/core/shared";
import { testCatalog } from "@/lib/leads/test-catalog";
import { TestPanel } from "./TestPanel";

/** The phone test's panel (plan 2026-11-23-flow-builder, Task B3; review 2026-11-24). */
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const graph: FlowGraph = {
  v: 2,
  start: "hi",
  nodes: [
    {
      id: "hi",
      type: "message",
      text: "Hi! Want the guide?",
      buttons: [],
      replies: [{ id: "y", title: "Yes please", next: "bye" }],
      next: null,
    },
    { id: "bye", type: "message", text: "Here it is.", buttons: [], replies: [], next: null },
  ],
  pos: { hi: { x: 0, y: 0 }, bye: { x: 320, y: 0 } },
  notes: [],
};
const panel = (g: FlowGraph, byComment = false) => (
  <TestPanel
    graph={g}
    businessName="Harbour Studio"
    catalog={testCatalog()}
    byComment={byComment}
    onLit={vi.fn()}
    onTool={vi.fn()}
    onClose={vi.fn()}
  />
);
const log = () =>
  within(screen.getByRole("group", { name: "The flow as it reads on Instagram" })).getByRole("log");

describe("the phone test's panel", () => {
  it("a card moved goes on with the test; a step changed starts it again", async () => {
    const { rerender } = render(panel(graph));
    await userEvent.click(screen.getByRole("button", { name: "Yes please" }));
    expect(log()).toHaveTextContent("Here it is.");
    rerender(panel({ ...graph, pos: { ...graph.pos, bye: { x: 400, y: 80 } } }));
    expect(log()).toHaveTextContent("Here it is.");
    rerender(panel({ ...graph, nodes: [...graph.nodes] }));
    expect(log()).not.toHaveTextContent("Here it is.");
    expect(log()).toHaveTextContent("Hi! Want the guide?");
  });

  it("a flow a comment starts can be tested that way: the private reply's limit is said", async () => {
    render(panel(graph, true));
    const starts = screen.getByRole("group", { name: "Starts with" });
    await userEvent.click(within(starts).getByRole("button", { name: "A comment" }));
    expect(within(starts).getByRole("button", { name: "A comment" })).toHaveAttribute("aria-pressed", "true");
    expect(log()).toHaveTextContent("Started by a comment: one private reply goes until they write back");
    expect(log()).toHaveTextContent("Hi! Want the guide?");
  });

  it("without a comment way in there's nothing to choose", () => {
    render(panel(graph));
    expect(screen.queryByRole("group", { name: "Starts with" })).toBeNull();
  });

  it("an end that isn't the flow's last step is said in words", () => {
    render(
      panel({
        v: 2,
        start: "w",
        nodes: [
          { id: "w", type: "wait", for: { minutes: 48 * 60 }, next: "bye" },
          { id: "bye", type: "message", text: "Here it is.", buttons: [], replies: [], next: null },
        ],
        pos: {},
        notes: [],
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Instagram's time to reply would run out during this wait.",
    );
  });
});
