import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowGraph } from "@lume/core/shared";
import { flowsClient, type FlowView } from "@/lib/flows/client";
import { api } from "@/lib/api";
import { testCatalog } from "@/lib/leads/test-catalog";
import { Builder } from "./Builder";

/** The flow builder (plan 2026-11-23-flow-builder, Task B1): the canvas, its steps, saving and Publish. */
vi.mock("@/lib/flows/client", () => ({ flowsClient: { save: vi.fn(), publish: vi.fn() } }));
vi.mock("@/lib/api", () => ({ api: { keepalive: vi.fn(() => true), prime: vi.fn(async () => undefined) } }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

// React Flow measures with browser APIs jsdom doesn't have (its own testing guide's stand-ins).
beforeAll(() => {
  class RO {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      this.cb([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;
  class DM {
    m22 = 1;
    constructor(t?: string) {
      const m = t?.match(/scale\(([\d.]+)\)/);
      if (m) this.m22 = Number(m[1]);
    }
  }
  globalThis.DOMMatrixReadOnly = DM as unknown as typeof DOMMatrixReadOnly;
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { get: () => 100, configurable: true },
    offsetWidth: { get: () => 240, configurable: true },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
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
  pos: { _start: { x: -300, y: 0 }, hi: { x: 0, y: 0 }, bye: { x: 320, y: 0 } },
  notes: [],
};
const view = (o: Partial<FlowView> = {}): FlowView => ({
  id: "f1",
  name: "Guide flow",
  status: "draft",
  priority: 0,
  rev: 3,
  draft: graph,
  graph,
  live: null,
  problems: [],
  issues: [],
  triggers: [
    {
      kind: "comment",
      accountId: null,
      keywords: ["guide"],
      mode: "word",
      mediaIds: [],
      adIds: [],
      publicReplies: [],
      cooldownHours: 24,
      enabled: true,
    },
  ],
  ...o,
});
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(flowsClient.save).mockImplementation(async (_id, body) =>
    ok(view({ rev: body.rev + 1, graph: body.graph!, draft: body.graph! })),
  );
});
afterEach(() => vi.useRealTimers());

describe("the flow builder", () => {
  it("shows Starts when and every step, each with its kind and what it says", () => {
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} />);
    expect(screen.getByLabelText("Starts when")).toHaveTextContent("Comments on a post");
    expect(screen.getByLabelText("Starts when")).toHaveTextContent("guide");
    expect(screen.getByLabelText("Step: Message, Hi! Want the guide?")).toHaveTextContent("Yes please");
    expect(screen.getByLabelText("Step: Message, Here it is.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ready to publish" })).toBeInTheDocument();
  });

  it("a problem: Publish waits, and Show me lists it", async () => {
    render(
      <Builder
        catalog={testCatalog()}
        flows={[]}
        initial={view({
          problems: ["Write a message or add a file."],
          issues: [{ nodeId: "bye", words: "Write a message or add a file." }],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "1 problem" }));
    const list = screen.getByRole("dialog", { name: "Problems" });
    expect(list).toHaveTextContent("Write a message or add a file.");
    expect(within(list).getByRole("button", { name: "Show me" })).toBeInTheDocument();
  });

  it("a step added from the rail saves the whole graph with the version it read; Undo takes it back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add Wait" }));
    expect(screen.getByLabelText(/^Step: Wait/)).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(900));
    await waitFor(() => expect(flowsClient.save).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(flowsClient.save).mock.calls[0]!;
    expect(body.rev).toBe(3);
    expect(body.graph!.nodes.map((n) => n.type)).toEqual(["message", "message", "wait"]);
    await waitFor(() => expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Saved"));
    fireEvent.keyDown(screen.getByLabelText("The flow's canvas"), { key: "z", ctrlKey: true });
    expect(screen.queryByLabelText(/^Step: Wait/)).toBeNull();
  });

  it("a step clicked opens its panel; changing it there changes the card", async () => {
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} />);
    // A plain click (React Flow selects on click; its drag handler needs a real window behind a mouse-down).
    fireEvent.click(screen.getByLabelText("Step: Message, Here it is."));
    const panel = await screen.findByRole("complementary", { name: "Message step" });
    fireEvent.change(within(panel).getByRole("textbox", { name: /Message/ }), {
      target: { value: "Enjoy it!" },
    });
    expect(screen.getByLabelText("Step: Message, Enjoy it!")).toBeInTheDocument();
  });

  it("one save at a time: an edit made while saving waits, then goes with the new version; Saved only after", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let finish!: (v: unknown) => void;
    vi.mocked(flowsClient.save).mockImplementationOnce(
      (_id, body) =>
        new Promise((r) => {
          finish = () => r(ok(view({ rev: body.rev + 1, graph: body.graph!, draft: body.graph! })));
        }) as never,
    );
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add Wait" }));
    await act(async () => void vi.advanceTimersByTime(900));
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
    // An edit while the first save is still on its way: no second save with the same version.
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    await act(async () => void vi.advanceTimersByTime(900));
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    await act(async () => void finish(null));
    await waitFor(() => expect(flowsClient.save).toHaveBeenCalledTimes(2));
    const [, second] = vi.mocked(flowsClient.save).mock.calls[1]!;
    expect(second.rev).toBe(4);
    expect(second.graph!.nodes.map((n) => n.type)).toEqual(["message", "message", "wait", "end"]);
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
  });

  it("Undo with nothing to undo changes nothing: still saved, Publish still there", () => {
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} />);
    fireEvent.keyDown(screen.getByLabelText("The flow's canvas"), { key: "z", ctrlKey: true });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
  });

  it("leaving with an edit not yet saved: it goes on the way out", async () => {
    const { unmount } = render(<Builder initial={view()} catalog={testCatalog()} flows={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add Wait" }));
    unmount();
    expect(api.keepalive).toHaveBeenCalledTimes(1);
    const [method, path, body] = vi.mocked(api.keepalive).mock.calls[0]!;
    expect([method, path]).toEqual(["PUT", "/api/v1/instagram/flows/f1"]);
    expect((body as { rev: number; graph: FlowGraph }).graph.nodes.map((n) => n.type)).toContain("wait");
  });

  it("leaving when everything is saved sends nothing on the way out", () => {
    const { unmount } = render(<Builder initial={view()} catalog={testCatalog()} flows={[]} />);
    unmount();
    expect(api.keepalive).not.toHaveBeenCalled();
  });

  it("leaving while a save is on its way: no retries after, and anything newer goes once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let finish!: (v: unknown) => void;
    vi.mocked(flowsClient.save).mockImplementationOnce(() => new Promise((r) => (finish = r)) as never);
    const { unmount } = render(<Builder initial={view()} catalog={testCatalog()} flows={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add Wait" }));
    await act(async () => void vi.advanceTimersByTime(900));
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    unmount();
    // The save fails after the builder has gone: nothing retries.
    await act(async () => void finish({ ok: false, status: 503, message: "busy" }));
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
  });

  it("a save that fails is tried again on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(flowsClient.save).mockResolvedValueOnce({
      ok: false,
      status: 503,
      message: "busy",
      code: "X",
    } as never);
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add Wait" }));
    await act(async () => void vi.advanceTimersByTime(900));
    expect(await screen.findByText("Couldn't save. Trying again.")).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(2100));
    await waitFor(() => expect(flowsClient.save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
  });

  it("Redo never undoes new typing: undo, type again straight away, Redo does nothing", () => {
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} />);
    fireEvent.click(screen.getByLabelText("Step: Message, Here it is."));
    const panel = screen.getByRole("complementary", { name: "Message step" });
    const box = within(panel).getByRole("textbox", { name: /Message/ });
    fireEvent.change(box, { target: { value: "A" } });
    fireEvent.change(box, { target: { value: "AB" } });
    const canvas = screen.getByLabelText("The flow's canvas");
    fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
    expect(screen.getByLabelText("Step: Message, Here it is.")).toBeInTheDocument();
    // Typing again within the second: no Undo step of its own, but Redo must not bring "AB" back over it.
    fireEvent.change(
      within(screen.getByRole("complementary", { name: "Message step" })).getByRole("textbox", {
        name: /Message/,
      }),
      {
        target: { value: "Z" },
      },
    );
    fireEvent.keyDown(canvas, { key: "y", ctrlKey: true });
    expect(screen.getByLabelText("Step: Message, Z")).toBeInTheDocument();
    // And that typing is its own step to undo.
    fireEvent.keyDown(canvas, { key: "z", ctrlKey: true });
    expect(screen.getByLabelText("Step: Message, Here it is.")).toBeInTheDocument();
  });

  it("someone else saved first: LUME says so and never saves over them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(flowsClient.save).mockResolvedValueOnce({
      ok: false,
      status: 409,
      message: "changed",
      code: "FLOW_CHANGED",
    } as never);
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    await act(async () => void vi.advanceTimersByTime(900));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else changed this flow meanwhile");
    await userEvent.click(screen.getByRole("button", { name: "Add Wait" }));
    await act(async () => void vi.advanceTimersByTime(900));
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
  });
});
