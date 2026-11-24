import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowGraph } from "@lume/core/shared";
import { flowsClient, type FlowAiBuild, type FlowView } from "@/lib/flows/client";
import { api } from "@/lib/api";
import { testCatalog } from "@/lib/leads/test-catalog";
import { ARM_MS } from "./AiBar";
import { BEAT_MS, Builder } from "./Builder";

/** The flow builder (plan 2026-11-23-flow-builder, Task B1): the canvas, its steps, saving and Publish. */
vi.mock("@/lib/flows/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/flows/client")>()),
  flowsClient: {
    save: vi.fn(),
    publish: vi.fn(),
    setTriggers: vi.fn(),
    testKeyword: vi.fn(),
    stats: vi.fn(),
    versions: vi.fn(),
    restore: vi.fn(),
    duplicate: vi.fn(),
    people: vi.fn(),
    runs: vi.fn(),
    aiBuild: vi.fn(),
  },
}));
// Reduce Motion, per test; and every camera fit, to see what came into view first.
const motion = vi.hoisted(() => ({ reduce: false }));
vi.mock("motion/react", async (orig) => ({
  ...(await orig<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduce,
}));
const fits = vi.hoisted(
  () => [] as { box: { x: number; y: number; w: number; h: number }; room?: { left: number } }[],
);
vi.mock("./useCamera", async (orig) => {
  const m = await orig<typeof import("./useCamera")>();
  return {
    ...m,
    useCamera: (o: Parameters<typeof m.useCamera>[0]) => {
      const c = m.useCamera(o);
      const fit = c.fit;
      c.fit = (box, panel, room) => {
        fits.push({ box, ...(room ? { room } : {}) });
        fit(box, panel, room);
      };
      return c;
    },
  };
});
vi.mock("@/lib/api", () => ({ api: { keepalive: vi.fn(() => true), prime: vi.fn(async () => undefined) } }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
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
      id: "t-1",
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
  motion.reduce = false;
  fits.length = 0;
  vi.mocked(flowsClient.save).mockImplementation(async (_id, body) =>
    ok(view({ rev: body.rev + 1, graph: body.graph!, draft: body.graph! })),
  );
});
afterEach(() => vi.useRealTimers());

describe("the flow builder", () => {
  it("shows Starts when and every step, each with its kind and what it says", () => {
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
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
        businessName="Harbour Studio"
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
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
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
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
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
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
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
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    fireEvent.keyDown(screen.getByLabelText("The flow's canvas"), { key: "z", ctrlKey: true });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
  });

  it("leaving with an edit not yet saved: it goes on the way out", async () => {
    const { unmount } = render(
      <Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add Wait" }));
    unmount();
    expect(api.keepalive).toHaveBeenCalledTimes(1);
    const [method, path, body] = vi.mocked(api.keepalive).mock.calls[0]!;
    expect([method, path]).toEqual(["PUT", "/api/v1/instagram/flows/f1"]);
    expect((body as { rev: number; graph: FlowGraph }).graph.nodes.map((n) => n.type)).toContain("wait");
  });

  it("leaving when everything is saved sends nothing on the way out", () => {
    const { unmount } = render(
      <Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />,
    );
    unmount();
    expect(api.keepalive).not.toHaveBeenCalled();
  });

  it("leaving while a save is on its way: no retries after, and anything newer goes once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let finish!: (v: unknown) => void;
    vi.mocked(flowsClient.save).mockImplementationOnce(() => new Promise((r) => (finish = r)) as never);
    const { unmount } = render(
      <Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />,
    );
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
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Add Wait" }));
    await act(async () => void vi.advanceTimersByTime(900));
    expect(await screen.findByText("Couldn't save. Trying again.")).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(2100));
    await waitFor(() => expect(flowsClient.save).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
  });

  it("Redo never undoes new typing: undo, type again straight away, Redo does nothing", () => {
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
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

  it("Starts when opens its panel; Save sends the ways in with the version the flow is at", async () => {
    vi.mocked(flowsClient.setTriggers).mockImplementation(async (_id, r, triggers) =>
      ok(view({ rev: r + 1, triggers })),
    );
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    fireEvent.click(screen.getByLabelText("Starts when"));
    const panel = await screen.findByRole("complementary", { name: "Starts when" });
    fireEvent.change(within(panel).getByRole("textbox", { name: /Keywords/ }), {
      target: { value: "guide, free" },
    });
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(flowsClient.setTriggers).toHaveBeenCalledTimes(1));
    const [id, r, triggers] = vi.mocked(flowsClient.setTriggers).mock.calls[0]!;
    expect([id, r]).toEqual(["f1", 3]);
    expect(triggers[0]!.keywords).toEqual(["guide", "free"]);
    // The server's id isn't sent back: its schema is strict (review 2026-11-24).
    expect(triggers[0]).not.toHaveProperty("id");
    expect(await within(panel).findByRole("status")).toHaveTextContent("Saved.");
    // What's shown is what's saved: nothing left to save.
    expect(within(panel).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("steps changed and not saved go first; the ways in go with the version that save left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(flowsClient.setTriggers).mockImplementation(async (_id, r, triggers) =>
      ok(view({ rev: r + 1, triggers })),
    );
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    fireEvent.click(screen.getByLabelText("Starts when"));
    const panel = await screen.findByRole("complementary", { name: "Starts when" });
    fireEvent.change(within(panel).getByRole("textbox", { name: /Keywords/ }), { target: { value: "free" } });
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(flowsClient.setTriggers).toHaveBeenCalledTimes(1));
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(flowsClient.save).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(flowsClient.setTriggers).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(flowsClient.setTriggers).mock.calls[0]![1]).toBe(4);
    // Nothing left over: no second save of the steps.
    await act(async () => void vi.advanceTimersByTime(2_000));
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
  });

  it("a save of the steps on its way: the ways in wait for it, then go with the version it returned", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release: () => void = () => undefined;
    vi.mocked(flowsClient.save).mockImplementationOnce(
      (_id, body) =>
        new Promise((done) => {
          release = () => done(ok(view({ rev: body.rev + 1, graph: body.graph!, draft: body.graph! })));
        }),
    );
    vi.mocked(flowsClient.setTriggers).mockImplementation(async (_id, r, triggers) =>
      ok(view({ rev: r + 1, triggers })),
    );
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    await act(async () => void vi.advanceTimersByTime(900));
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Starts when"));
    const panel = await screen.findByRole("complementary", { name: "Starts when" });
    fireEvent.change(within(panel).getByRole("textbox", { name: /Keywords/ }), { target: { value: "free" } });
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await act(async () => void vi.advanceTimersByTime(300));
    expect(flowsClient.setTriggers).not.toHaveBeenCalled();
    await act(async () => release());
    await act(async () => void vi.advanceTimersByTime(300));
    await waitFor(() => expect(flowsClient.setTriggers).toHaveBeenCalledTimes(1));
    expect(vi.mocked(flowsClient.setTriggers).mock.calls[0]![1]).toBe(4);
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
  });

  it("Publish pressed while the ways in save: it waits, then goes with the version they left; no false conflict", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release: () => void = () => undefined;
    vi.mocked(flowsClient.setTriggers).mockImplementation(
      (_id, r, triggers) =>
        new Promise((done) => {
          release = () => done(ok(view({ rev: r + 1, triggers })));
        }),
    );
    vi.mocked(flowsClient.publish).mockImplementation(async (_id, r) =>
      ok(view({ rev: r + 1, status: "live", live: { version: 1 } as never })),
    );
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    fireEvent.click(screen.getByLabelText("Starts when"));
    const panel = await screen.findByRole("complementary", { name: "Starts when" });
    fireEvent.change(within(panel).getByRole("textbox", { name: /Keywords/ }), { target: { value: "free" } });
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(flowsClient.setTriggers).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    await act(async () => void vi.advanceTimersByTime(300));
    expect(flowsClient.publish).not.toHaveBeenCalled();
    await act(async () => release());
    await act(async () => void vi.advanceTimersByTime(300));
    await waitFor(() => expect(flowsClient.publish).toHaveBeenCalledWith("f1", 4));
    expect(screen.queryByText(/Someone else changed this flow/)).toBeNull();
  });

  it("ways in saved while Publish is on its way: they wait for it, then go with the version it left", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release: () => void = () => undefined;
    vi.mocked(flowsClient.publish).mockImplementation(
      (_id, r) =>
        new Promise((done) => {
          release = () => done(ok(view({ rev: r + 1, status: "live", live: { version: 1 } as never })));
        }),
    );
    vi.mocked(flowsClient.setTriggers).mockImplementation(async (_id, r, triggers) =>
      ok(view({ rev: r + 1, triggers })),
    );
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(flowsClient.publish).toHaveBeenCalledWith("f1", 3));
    fireEvent.click(screen.getByLabelText("Starts when"));
    const panel = await screen.findByRole("complementary", { name: "Starts when" });
    fireEvent.change(within(panel).getByRole("textbox", { name: /Keywords/ }), { target: { value: "free" } });
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await act(async () => void vi.advanceTimersByTime(300));
    expect(flowsClient.setTriggers).not.toHaveBeenCalled();
    await act(async () => release());
    await act(async () => void vi.advanceTimersByTime(300));
    await waitFor(() => expect(flowsClient.setTriggers).toHaveBeenCalledTimes(1));
    expect(vi.mocked(flowsClient.setTriggers).mock.calls[0]![1]).toBe(4);
  });

  it("left while the ways in waited for a save: they never go after it (review 2026-11-24)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release: () => void = () => undefined;
    vi.mocked(flowsClient.save).mockImplementationOnce(
      (_id, body) =>
        new Promise((done) => {
          release = () => done(ok(view({ rev: body.rev + 1, graph: body.graph!, draft: body.graph! })));
        }),
    );
    const { unmount } = render(
      <Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    await act(async () => void vi.advanceTimersByTime(900));
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Starts when"));
    const panel = await screen.findByRole("complementary", { name: "Starts when" });
    fireEvent.change(within(panel).getByRole("textbox", { name: /Keywords/ }), { target: { value: "free" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    unmount();
    await act(async () => release());
    await act(async () => void vi.advanceTimersByTime(500));
    expect(flowsClient.setTriggers).not.toHaveBeenCalled();
  });

  it("ways in changed and not saved stay when the panel closes, and leaving asks first", async () => {
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    fireEvent.click(screen.getByLabelText("Starts when"));
    let panel = await screen.findByRole("complementary", { name: "Starts when" });
    fireEvent.change(within(panel).getByRole("textbox", { name: /Keywords/ }), { target: { value: "free" } });
    await userEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Starts when" })).toBeNull();
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByLabelText("Starts when"));
    panel = await screen.findByRole("complementary", { name: "Starts when" });
    expect(within(panel).getByRole("textbox", { name: /Keywords/ })).toHaveValue("free");
    expect(within(panel).getByRole("button", { name: "Save" })).toBeEnabled();
    expect(flowsClient.setTriggers).not.toHaveBeenCalled();
  });

  it("the steps' save finds someone else's change: the ways in aren't sent over it", async () => {
    vi.mocked(flowsClient.save).mockResolvedValueOnce({
      ok: false,
      status: 409,
      message: "changed",
      code: "FLOW_CHANGED",
    } as never);
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    fireEvent.click(screen.getByLabelText("Starts when"));
    const panel = await screen.findByRole("complementary", { name: "Starts when" });
    fireEvent.change(within(panel).getByRole("textbox", { name: /Keywords/ }), { target: { value: "free" } });
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByRole("status")).toHaveTextContent(
      "Someone else changed this flow meanwhile",
    );
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
    expect(flowsClient.setTriggers).not.toHaveBeenCalled();
  });

  it("a way in changed while its save is on the way stays changed after", async () => {
    let release: () => void = () => undefined;
    vi.mocked(flowsClient.setTriggers).mockImplementation(
      (_id, r, triggers) =>
        new Promise((done) => {
          release = () => done(ok(view({ rev: r + 1, triggers })));
        }),
    );
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    fireEvent.click(screen.getByLabelText("Starts when"));
    const panel = await screen.findByRole("complementary", { name: "Starts when" });
    const box = () => within(panel).getByRole("textbox", { name: /Keywords/ });
    fireEvent.change(box(), { target: { value: "free" } });
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(flowsClient.setTriggers).toHaveBeenCalledTimes(1));
    fireEvent.change(box(), { target: { value: "free, plan" } });
    await act(async () => release());
    expect(await within(panel).findByRole("status")).toHaveTextContent("Saved.");
    expect(box()).toHaveValue("free, plan");
    expect(within(panel).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("leaving while the ways in save: a step changed meanwhile goes on the way out, with the version they left", async () => {
    let release: () => void = () => undefined;
    vi.mocked(flowsClient.setTriggers).mockImplementation(
      (_id, r, triggers) =>
        new Promise((done) => {
          release = () => done(ok(view({ rev: r + 1, triggers })));
        }),
    );
    const { unmount } = render(
      <Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />,
    );
    fireEvent.click(screen.getByLabelText("Starts when"));
    const panel = await screen.findByRole("complementary", { name: "Starts when" });
    fireEvent.change(within(panel).getByRole("textbox", { name: /Keywords/ }), { target: { value: "free" } });
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(flowsClient.setTriggers).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    unmount();
    expect(api.keepalive).not.toHaveBeenCalled();
    await act(async () => release());
    await waitFor(() => expect(api.keepalive).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.keepalive).mock.calls[0]![2]).toMatchObject({ rev: 4 });
    expect(flowsClient.save).not.toHaveBeenCalled();
  });

  it("a keyword another flow answers is refused in words; it isn't someone else's change", async () => {
    vi.mocked(flowsClient.setTriggers).mockResolvedValue({
      ok: false,
      status: 409,
      code: "TRIGGER_TAKEN",
      message: "Another live flow already answers FREE.",
    } as never);
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    fireEvent.click(screen.getByLabelText("Starts when"));
    const panel = await screen.findByRole("complementary", { name: "Starts when" });
    fireEvent.change(within(panel).getByRole("textbox", { name: /Keywords/ }), { target: { value: "free" } });
    await userEvent.click(within(panel).getByRole("button", { name: "Save" }));
    expect(await within(panel).findByRole("status")).toHaveTextContent(
      "Another live flow already answers FREE.",
    );
    expect(screen.queryByText(/Someone else changed this flow/)).toBeNull();
  });

  it("Test: the flow on the phone as Instagram shows it; a tap goes on, and the steps it went through light up", async () => {
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Test" }));
    const phone = await screen.findByLabelText("The flow as it reads on Instagram");
    expect(phone).toHaveTextContent("Harbour Studio");
    expect(within(phone).getByRole("log")).toHaveTextContent("Hi! Want the guide?");
    await userEvent.click(within(phone).getByRole("button", { name: "Yes please" }));
    expect(within(phone).getByRole("log")).toHaveTextContent("Here it is.");
    expect(screen.getByLabelText("Step: Message, Hi! Want the guide?")).toHaveAttribute("data-lit");
    expect(screen.getByLabelText("Step: Message, Here it is.")).toHaveAttribute("data-lit");
    expect(within(screen.getByRole("complementary", { name: "Test" })).getByRole("status")).toHaveTextContent(
      "The flow has ended.",
    );
    // Nothing is sent: no save, no lead.
    expect(flowsClient.save).not.toHaveBeenCalled();
    // The canvas changes while testing: the test starts again on what's drawn now.
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    expect(within(phone).getByRole("log")).not.toHaveTextContent("Here it is.");
    expect(within(phone).getByRole("log")).toHaveTextContent("Hi! Want the guide?");
  });

  it("Numbers: each step's last 30 days on its card and each line's count on it; Build puts the steps back", async () => {
    vi.mocked(flowsClient.stats).mockResolvedValue(
      ok({ byStep: { hi: { entered: 1200, people: 950, sent: 1190 } }, byLine: { "hi>bye": 410 } }),
    );
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("radio", { name: "Numbers" }));
    await waitFor(() => expect(flowsClient.stats).toHaveBeenCalledTimes(1));
    // The last 30 of the business's days: the server knows where its today ends.
    expect(flowsClient.stats).toHaveBeenCalledWith("f1", 30);
    const hi = screen.getByLabelText("Step: Message, Hi! Want the guide?");
    await waitFor(() => expect(hi).toHaveTextContent("1,200"));
    expect(hi).toHaveTextContent("950");
    // The line from it to the next step carries its count.
    expect(screen.getByText("410")).toBeInTheDocument();
    // A step nobody reached shows its zeros, not nothing.
    expect(screen.getByLabelText("Step: Message, Here it is.")).toHaveTextContent("Entered0");
    expect(screen.getByText("Last 30 days")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Build" }));
    expect(hi).not.toHaveTextContent("1,200");
    // Arrow keys move the choice, and focus goes with it.
    screen.getByRole("radio", { name: "Build" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Numbers" })).toHaveFocus());
    expect(screen.getByRole("radio", { name: "Numbers" })).toHaveAttribute("aria-checked", "true");
  });

  it("a restore over steps that couldn't be saved: the draft is the version now, so no 'Trying again' stays", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(flowsClient.save).mockResolvedValue({
      ok: false,
      status: 500,
      code: "X",
      message: "down",
    } as never);
    vi.mocked(flowsClient.versions).mockResolvedValue(
      ok({
        versions: [
          {
            id: "v1",
            version: 1,
            createdAt: "2026-11-10T10:00:00Z",
            createdBy: null,
            live: true,
            changes: { added: 2, removed: 0, changed: 0 },
          },
        ],
      }),
    );
    vi.mocked(flowsClient.restore).mockImplementation(async (_id, _v, r) => ok(view({ rev: r + 1 })));
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    await act(async () => void vi.advanceTimersByTime(900));
    expect(await screen.findByText("Couldn't save. Trying again.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Versions" }));
    const panel = await screen.findByRole("complementary", { name: "Versions" });
    await userEvent.click(await within(panel).findByRole("button", { name: "Restore into the draft" }));
    await waitFor(() => expect(flowsClient.restore).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("Couldn't save. Trying again.")).toBeNull());
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("Versions: a version back into the draft with the version the flow is at; Undo saves the draft before it back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const old: FlowGraph = {
      ...graph,
      nodes: [{ ...graph.nodes[0]!, text: "An older hello" } as never, graph.nodes[1]!],
    };
    vi.mocked(flowsClient.versions).mockResolvedValue(
      ok({
        versions: [
          {
            id: "v2",
            version: 2,
            createdAt: "2026-11-20T10:00:00Z",
            createdBy: { id: "u1", name: "Maya" },
            live: true,
            changes: { added: 1, removed: 0, changed: 2 },
          },
          {
            id: "v1",
            version: 1,
            createdAt: "2026-11-10T10:00:00Z",
            createdBy: null,
            live: false,
            changes: { added: 2, removed: 0, changed: 0 },
          },
        ],
      }),
    );
    vi.mocked(flowsClient.restore).mockImplementation(async (_id, _v, r) =>
      ok(view({ rev: r + 1, graph: old, draft: old })),
    );
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Versions" }));
    const panel = await screen.findByRole("complementary", { name: "Versions" });
    const v2 = await within(panel).findByRole("button", { name: /Version 2/ });
    expect(v2).toHaveTextContent("Live");
    expect(v2).toHaveTextContent("Maya");
    expect(panel).toHaveTextContent("1 step added");
    expect(panel).toHaveTextContent("2 steps changed");
    await userEvent.click(within(panel).getByRole("button", { name: /Version 1/ }));
    expect(panel).toHaveTextContent("Version 1: the first");
    await userEvent.click(within(panel).getByRole("button", { name: "Restore into the draft" }));
    await waitFor(() => expect(flowsClient.restore).toHaveBeenCalledWith("f1", "v1", 3));
    expect(await screen.findByLabelText("Step: Message, An older hello")).toBeInTheDocument();
    expect(within(panel).getByRole("status")).toHaveTextContent(
      "Version 1 is in the draft now. Undo takes it back.",
    );
    // Nothing more to save: the server has it.
    await act(async () => void vi.advanceTimersByTime(900));
    expect(flowsClient.save).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("The flow's canvas"), { key: "z", ctrlKey: true });
    expect(screen.getByLabelText("Step: Message, Hi! Want the guide?")).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(900));
    await waitFor(() => expect(flowsClient.save).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(flowsClient.save).mock.calls[0]!;
    expect(body.rev).toBe(4);
    expect((body.graph!.nodes[0] as { text: string }).text).toBe("Hi! Want the guide?");
  });

  it("the side panel's tabs: arrow keys open the next one, and focus goes to its tab", async () => {
    vi.mocked(flowsClient.people).mockResolvedValue(ok({ people: [] }));
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Test" }));
    screen.getByRole("radio", { name: "Test" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByRole("complementary", { name: "Replay" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Replay" })).toHaveFocus());
  });

  it("Numbers that don't load say so where it's always seen", async () => {
    vi.mocked(flowsClient.stats).mockResolvedValue({
      ok: false,
      status: 500,
      code: "X",
      message: "LUME couldn't reach the server.",
    } as never);
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("radio", { name: "Numbers" }));
    expect(
      await screen.findByText("The numbers didn't load. LUME couldn't reach the server."),
    ).toBeInTheDocument();
  });

  it("a version isn't copied over changes to Starts when that aren't saved", async () => {
    vi.mocked(flowsClient.versions).mockResolvedValue(
      ok({
        versions: [
          {
            id: "v1",
            version: 1,
            createdAt: "2026-11-10T10:00:00Z",
            createdBy: null,
            live: true,
            changes: { added: 2, removed: 0, changed: 0 },
          },
        ],
      }),
    );
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    fireEvent.click(screen.getByLabelText("Starts when"));
    const start = await screen.findByRole("complementary", { name: "Starts when" });
    fireEvent.change(within(start).getByRole("textbox", { name: /Keywords/ }), { target: { value: "free" } });
    await userEvent.click(screen.getByRole("button", { name: "Versions" }));
    const panel = await screen.findByRole("complementary", { name: "Versions" });
    await userEvent.click(await within(panel).findByRole("button", { name: "Copy as a new flow" }));
    expect(
      await within(panel).findByText(/Save or undo your changes to Starts when first/),
    ).toBeInTheDocument();
    expect(flowsClient.duplicate).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("Versions: one copied as a new flow opens the copy; a refusal is said", async () => {
    vi.mocked(flowsClient.versions).mockResolvedValue(
      ok({
        versions: [
          {
            id: "v1",
            version: 1,
            createdAt: "2026-11-10T10:00:00Z",
            createdBy: null,
            live: true,
            changes: { added: 2, removed: 0, changed: 0 },
          },
        ],
      }),
    );
    vi.mocked(flowsClient.duplicate).mockResolvedValueOnce(ok(view({ id: "f9" })));
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Versions" }));
    const panel = await screen.findByRole("complementary", { name: "Versions" });
    await userEvent.click(await within(panel).findByRole("button", { name: "Copy as a new flow" }));
    expect(flowsClient.duplicate).toHaveBeenCalledWith("f1", "v1");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/instagram/flows/f9"));
    vi.mocked(flowsClient.duplicate).mockResolvedValueOnce({
      ok: false,
      status: 404,
      code: "VERSION_NOT_FOUND",
      message: "That version isn't in LUME any more.",
    } as never);
    await userEvent.click(within(panel).getByRole("button", { name: "Copy as a new flow" }));
    expect(await within(panel).findByText("That version isn't in LUME any more.")).toBeInTheDocument();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("Replay: pick someone who went through it; their steps light up, with where it waits", async () => {
    vi.mocked(flowsClient.people).mockResolvedValue(
      ok({
        people: [
          {
            leadId: "l1",
            name: "Priya Shah",
            photo: null,
            startedAt: new Date().toISOString(),
            status: "waiting",
          },
        ],
      }),
    );
    vi.mocked(flowsClient.runs).mockResolvedValue(
      ok({
        runs: [
          {
            id: "r1",
            status: "waiting",
            reason: null,
            version: 2,
            startedAt: new Date().toISOString(),
            sent: 1,
            trail: [{ step: "hi", at: new Date().toISOString() }],
            waiting: { step: "hi", why: "reply", until: null },
          },
        ],
      }),
    );
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Test" }));
    await userEvent.click(screen.getByRole("radio", { name: "Replay" }));
    const panel = await screen.findByRole("complementary", { name: "Replay" });
    await userEvent.click(await within(panel).findByRole("button", { name: /Priya Shah/ }));
    expect(flowsClient.runs).toHaveBeenCalledWith("f1", "l1");
    const trail = await within(panel).findByRole("list", { name: "Their way through it" });
    expect(trail).toHaveTextContent("Message: Hi! Want the guide?");
    expect(trail).toHaveTextContent("Waiting here for a tap on a quick reply");
    expect(panel).toHaveTextContent("1 of 20");
    // The canvas lights a moment after the trail is drawn (the builder renders again with it).
    await waitFor(() =>
      expect(screen.getByLabelText("Step: Message, Hi! Want the guide?")).toHaveAttribute("data-lit"),
    );
    expect(screen.getByLabelText("Step: Message, Here it is.")).not.toHaveAttribute("data-lit");
    // Closing lets the steps go dark again.
    await userEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.getByLabelText("Step: Message, Hi! Want the guide?")).not.toHaveAttribute("data-lit");
  });

  it("someone else saved first: LUME says so and never saves over them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(flowsClient.save).mockResolvedValueOnce({
      ok: false,
      status: 409,
      message: "changed",
      code: "FLOW_CHANGED",
    } as never);
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    await act(async () => void vi.advanceTimersByTime(900));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else changed this flow meanwhile");
    await userEvent.click(screen.getByRole("button", { name: "Add Wait" }));
    await act(async () => void vi.advanceTimersByTime(900));
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
  });
});

describe("LUME AI builds the flow (plan 2026-11-23-flow-builder, Task C2)", () => {
  const built = (o: Partial<FlowAiBuild> = {}): FlowAiBuild => ({
    plan: ["Say thanks", "Hand to the team"],
    said: "LUME AI added a thank-you and a handover.",
    refused: false,
    ops: [
      {
        op: "add",
        node: { id: "n1", type: "message", text: "Thanks for asking!", buttons: [], replies: [], next: null },
        pos: { x: 640, y: 0 },
      },
      { op: "connect", from: { node: "bye", exit: "next" }, to: "n1" },
      { op: "add", node: { id: "n2", type: "handoff", to: "person" }, pos: { x: 960, y: 400 } },
      { op: "connect", from: { node: "n1", exit: "next" }, to: "n2" },
    ],
    ...o,
  });
  const thanks = () => screen.queryByLabelText("Step: Message, Thanks for asking!");
  const handover = () => screen.queryByLabelText(/^Step: Hand over/);
  const ask = async (words = "Thank them, then hand to the team") => {
    // Its words name what it changes: the whole flow, or the steps selected.
    await userEvent.type(screen.getByRole("textbox", { name: /^Tell LUME AI what/ }), words);
    await userEvent.click(screen.getByRole("button", { name: "Build it" }));
  };
  const open = () =>
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);

  it("asks with the words, fits the whole next flow in view, then each step lands as the cursor arrives, 950 ms apart", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const timers = vi.spyOn(globalThis, "setTimeout");
    vi.mocked(flowsClient.aiBuild).mockResolvedValue(ok(built()));
    open();
    await ask();
    expect(flowsClient.aiBuild).toHaveBeenCalledWith("f1", { prompt: "Thank them, then hand to the team" });
    const plan = await screen.findByRole("region", { name: "What LUME AI is building" });
    expect(plan).toHaveTextContent("Say thanks");
    expect(plan).toHaveTextContent("1 of 2");
    // The camera fits the flow as it will be, the new steps too, before any lands.
    const { box, room } = fits.at(-1)!;
    expect(box.x + box.w).toBeGreaterThanOrEqual(960 + 244);
    expect(box.y + box.h).toBeGreaterThanOrEqual(400);
    // Clear of the plan card (68 px in, 300 wide), so no step lands under it.
    expect(room!.left).toBeGreaterThanOrEqual(68 + 300);
    // The cursor sets off for the first step before it lands, to the step's place.
    const cur = () => document.querySelector<HTMLElement>("[data-ai-cursor]");
    expect(cur()).toHaveTextContent("Writing a message");
    expect(cur()!.style.transform).toBe("translate(658px, 22px)");
    // A beat is the cursor's move, at least 900 ms: the steps land one a beat, never at once.
    expect(BEAT_MS).toBeGreaterThanOrEqual(900);
    const delays = timers.mock.calls.map((c) => c[1]);
    expect(delays).toContain(BEAT_MS);
    expect(delays).toContain(2 * BEAT_MS);
    timers.mockRestore();
    expect(thanks()).toBeNull();
    await act(async () => void vi.advanceTimersByTime(BEAT_MS));
    expect(thanks()).toHaveAttribute("data-fresh");
    // As it lands, the cursor is already on its way to the next.
    expect(cur()).toHaveTextContent("Handing over");
    expect(cur()!.style.transform).toBe("translate(978px, 422px)");
    expect(handover()).toBeNull();
    await act(async () => void vi.advanceTimersByTime(BEAT_MS));
    expect(handover()).toHaveAttribute("data-fresh");
    expect(screen.getByText(/LUME AI built 2 steps\./)).toBeInTheDocument();
    expect(plan).toHaveTextContent("LUME AI added a thank-you and a handover.");
    expect(cur()).toBeNull();
    // Until Keep or Discard the canvas is still LUME AI's: no edits, no Undo, no Publish.
    expect(screen.getByRole("button", { name: "Add Wait" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /problem|Ready/ })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText("The flow's canvas"), { key: "z", ctrlKey: true });
    expect(handover()).toBeInTheDocument();
    // Keep and Discard wait a moment after they appear: a stray double click never decides.
    expect(screen.getByRole("button", { name: "Keep" })).toBeDisabled();
    await act(async () => void vi.advanceTimersByTime(ARM_MS));
    // Keep: the tint goes, and Undo takes the whole build back in one step.
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(thanks()).not.toHaveAttribute("data-fresh");
    expect(screen.getByText("Kept. Undo takes the whole build back in one step.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "What LUME AI is building" })).toBeNull();
    fireEvent.keyDown(screen.getByLabelText("The flow's canvas"), { key: "z", ctrlKey: true });
    expect(thanks()).toBeNull();
    expect(handover()).toBeNull();
  });

  it("the steps on screen are saved before it asks; changed elsewhere: it asks nothing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(flowsClient.save).mockResolvedValueOnce({
      ok: false,
      status: 409,
      message: "changed",
      code: "FLOW_CHANGED",
    } as never);
    open();
    await userEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    await ask();
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else changed this flow meanwhile");
    expect(flowsClient.aiBuild).not.toHaveBeenCalled();
    // Said once, by the banner: not as a save that failed.
    expect(screen.queryByText(/couldn't save the flow first/)).toBeNull();
  });

  it("a step added just now is saved first, then LUME AI is asked about the flow as saved", async () => {
    vi.mocked(flowsClient.aiBuild).mockResolvedValue(ok(built({ ops: [] })));
    open();
    // All at once, so the save's own timer never comes first.
    fireEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Tell LUME AI what/ }), {
      target: { value: "Tidy it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    await waitFor(() => expect(flowsClient.aiBuild).toHaveBeenCalledTimes(1));
    expect(flowsClient.save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(flowsClient.save).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(flowsClient.aiBuild).mock.invocationCallOrder[0]!,
    );
  });

  it("a save that fails first: LUME AI isn't asked, and LUME says so", async () => {
    vi.mocked(flowsClient.save).mockResolvedValueOnce({ ok: false, status: 500, message: "down" } as never);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Add Ends" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Tell LUME AI what/ }), {
      target: { value: "Tidy it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    expect(
      await screen.findByText(
        "LUME couldn't save the flow first, so LUME AI hasn't started. Try again in a moment.",
      ),
    ).toBeInTheDocument();
    expect(flowsClient.aiBuild).not.toHaveBeenCalled();
  });

  it("with steps selected, only they go, and the words say so", async () => {
    vi.mocked(flowsClient.aiBuild).mockResolvedValue(ok(built({ ops: [] })));
    open();
    fireEvent.click(screen.getByLabelText("Step: Message, Here it is."));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Tell LUME AI what to change in the selected steps" }),
      "Warmer",
    );
    await userEvent.click(screen.getByRole("button", { name: "Build it" }));
    expect(flowsClient.aiBuild).toHaveBeenCalledWith("f1", { prompt: "Warmer", selection: ["bye"] });
  });

  it("while it builds the canvas is LUME AI's: the rail is off; Stop keeps what landed, marked New", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(flowsClient.aiBuild).mockResolvedValue(ok(built()));
    open();
    await ask();
    await screen.findByRole("region", { name: "What LUME AI is building" });
    expect(screen.getByRole("button", { name: "Add Wait" })).toBeDisabled();
    await act(async () => void vi.advanceTimersByTime(950));
    expect(thanks()).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("The flow's canvas"), { key: "z", ctrlKey: true });
    expect(thanks()).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(handover()).toBeNull();
    expect(thanks()).toHaveAttribute("data-fresh");
    expect(screen.getByText("Stopped. What LUME AI made so far stays, marked New.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep" })).toBeInTheDocument();
  });

  it("Discard puts the draft from before back as one change, and saves it; Undo brings the build back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(flowsClient.aiBuild).mockResolvedValue(ok(built()));
    open();
    await ask();
    await screen.findByRole("region", { name: "What LUME AI is building" });
    await act(async () => void vi.advanceTimersByTime(2 * BEAT_MS));
    expect(handover()).toBeInTheDocument();
    const discard = screen.getByRole("button", { name: "Discard" });
    await act(async () => void vi.advanceTimersByTime(ARM_MS));
    await waitFor(() => expect(discard).toBeEnabled());
    await userEvent.click(discard);
    expect(thanks()).toBeNull();
    expect(handover()).toBeNull();
    expect(screen.getByText("Discarded. The canvas is as it was.")).toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(900));
    await waitFor(() =>
      expect(
        vi
          .mocked(flowsClient.save)
          .mock.calls.at(-1)![1]
          .graph!.nodes.map((n) => n.id),
      ).toEqual(["hi", "bye"]),
    );
    fireEvent.keyDown(screen.getByLabelText("The flow's canvas"), { key: "z", ctrlKey: true });
    expect(handover()).toBeInTheDocument();
  });

  it("Reduce Motion: every step lands at once, with no cursor", async () => {
    motion.reduce = true;
    vi.mocked(flowsClient.aiBuild).mockResolvedValue(ok(built()));
    open();
    await ask();
    await waitFor(() => expect(handover()).toBeInTheDocument());
    expect(thanks()).toBeInTheDocument();
    expect(document.querySelector("[data-ai-cursor]")).toBeNull();
  });

  it("a refused answer, or one LUME AI couldn't give, changes nothing and says why; the words stay", async () => {
    vi.mocked(flowsClient.aiBuild)
      .mockResolvedValueOnce(
        ok(
          built({
            refused: true,
            said: "LUME AI couldn't make this flow work on Instagram. Nothing changed.",
          }),
        ),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        message: "LUME AI couldn't build this just now. Try again.",
        code: "AI_UNAVAILABLE",
      } as never);
    open();
    await ask("Something long");
    expect(await screen.findByText(/couldn't make this flow work on Instagram/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Tell LUME AI what this flow should do" })).toHaveValue(
      "Something long",
    );
    expect(screen.getAllByLabelText(/^Step: /)).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Build it" }));
    expect(await screen.findByText("LUME AI couldn't build this just now. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build it" })).toBeEnabled();
    expect(flowsClient.save).not.toHaveBeenCalled();
  });

  it("Stop while LUME AI thinks: nothing changes when the answer comes", async () => {
    let answer!: (v: unknown) => void;
    vi.mocked(flowsClient.aiBuild).mockImplementation(() => new Promise((r) => (answer = r)) as never);
    open();
    await ask();
    // Stop is pressed once it has been there a moment (a double click on Build it never stops it).
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toBeDisabled();
    await waitFor(() => expect(stop).toBeEnabled());
    await userEvent.click(stop);
    await act(async () => void answer(ok(built())));
    expect(thanks()).toBeNull();
    expect(screen.queryByRole("region", { name: "What LUME AI is building" })).toBeNull();
    expect(screen.getByRole("button", { name: "Build it" })).toBeInTheDocument();
  });

  it("Build it waits for words, and the bar is in Build only", async () => {
    vi.mocked(flowsClient.stats).mockResolvedValue(ok({ byStep: {}, byLine: {} }));
    open();
    expect(screen.getByRole("button", { name: "Build it" })).toBeDisabled();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Tell LUME AI what this flow should do" }),
      "   ",
    );
    expect(screen.getByRole("button", { name: "Build it" })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: "Numbers" }));
    expect(screen.queryByRole("button", { name: "Build it" })).toBeNull();
  });
});

describe("LUME AI builds the flow: the second review (2026-11-24)", () => {
  const ops = (): FlowAiBuild["ops"] => [
    {
      op: "add",
      node: { id: "n1", type: "message", text: "Thanks for asking!", buttons: [], replies: [], next: null },
      pos: { x: 640, y: 0 },
    },
    { op: "add", node: { id: "n2", type: "end" }, pos: { x: 960, y: 0 } },
  ];
  const answer = (o: Partial<FlowAiBuild> = {}): FlowAiBuild => ({
    plan: ["Do it"],
    said: "Done.",
    refused: false,
    ops: ops(),
    ...o,
  });
  const start = async () => {
    render(<Builder initial={view()} catalog={testCatalog()} flows={[]} businessName="Harbour Studio" />);
    fireEvent.change(screen.getByRole("textbox", { name: /^Tell LUME AI what/ }), {
      target: { value: "Go" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
  };

  it("someone else saved meanwhile: no more steps land on a flow that can't be saved", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(flowsClient.save).mockResolvedValueOnce({
      ok: false,
      status: 409,
      message: "changed",
      code: "FLOW_CHANGED",
    } as never);
    vi.mocked(flowsClient.aiBuild).mockResolvedValue(ok(answer()));
    await start();
    await screen.findByRole("region", { name: "What LUME AI is building" });
    await act(async () => void vi.advanceTimersByTime(BEAT_MS));
    expect(screen.getByLabelText("Step: Message, Thanks for asking!")).toBeInTheDocument();
    // Its save finds someone else's change before the next beat.
    await act(async () => void vi.advanceTimersByTime(900));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else changed this flow meanwhile");
    await act(async () => void vi.advanceTimersByTime(BEAT_MS));
    expect(screen.queryByLabelText(/^Step: Ends/)).toBeNull();
    expect(screen.queryByRole("region", { name: "What LUME AI is building" })).toBeNull();
    expect(screen.getByRole("button", { name: "Build it" })).toBeInTheDocument();
  });

  it("Reduce Motion: the whole next flow is still brought into view", async () => {
    motion.reduce = true;
    vi.mocked(flowsClient.aiBuild).mockResolvedValue(ok(answer()));
    await start();
    await waitFor(() => expect(screen.getByLabelText(/^Step: Ends/)).toBeInTheDocument());
    const { box } = fits.at(-1)!;
    expect(box.x + box.w).toBeGreaterThanOrEqual(960 + 244);
  });

  it("a build that only joins steps says so, and never claims steps are marked New", async () => {
    vi.mocked(flowsClient.aiBuild).mockResolvedValue(
      ok(answer({ ops: [{ op: "connect", from: { node: "bye", exit: "next" }, to: "hi" }] })),
    );
    motion.reduce = true;
    await start();
    expect(await screen.findByText("LUME AI changed the lines between steps.")).toBeInTheDocument();
    expect(screen.queryByText(/marked New/)).toBeNull();
  });
});
