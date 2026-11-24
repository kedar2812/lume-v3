import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowGraph } from "@lume/core/shared";
import { flowsClient, type FlowRun } from "@/lib/flows/client";
import { PanelHead } from "./PanelHead";
import { ReplayPanel } from "./ReplayPanel";
import { VersionsPanel } from "./VersionsPanel";

/** Replay and Versions on their own (plan 2026-11-23-flow-builder, Task B4): the states the builder tests don't walk. */
vi.mock("@/lib/flows/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/flows/client")>()),
  flowsClient: { versions: vi.fn(), people: vi.fn(), runs: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (message: string) => ({ ok: false as const, status: 500, code: "X", message }) as never;
const graph: FlowGraph = {
  v: 2,
  start: "hi",
  nodes: [{ id: "hi", type: "message", text: "Hello there", buttons: [], replies: [], next: null }],
  pos: {},
  notes: [],
};
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

const versions = (o: Partial<Parameters<typeof VersionsPanel>[0]> = {}) =>
  render(
    <VersionsPanel
      flowId="f1"
      onTool={vi.fn()}
      onClose={vi.fn()}
      onRestore={vi.fn(async () => ({ ok: true }))}
      onCopy={vi.fn(async () => ({ ok: true }))}
      {...o}
    />,
  );
const replay = (onLit = vi.fn()) =>
  render(<ReplayPanel flowId="f1" graph={graph} onTool={vi.fn()} onClose={vi.fn()} onLit={onLit} />);
const run = (o: Partial<FlowRun> = {}): FlowRun => ({
  id: "r",
  status: "done",
  reason: "finished",
  version: 1,
  startedAt: "2026-11-20T10:00:00Z",
  sent: 1,
  trail: [{ step: "hi", at: "2026-11-20T10:00:00Z" }],
  waiting: null,
  ...o,
});

describe("Versions", () => {
  it("nothing live yet is said, not an empty list", async () => {
    vi.mocked(flowsClient.versions).mockResolvedValue(ok({ versions: [] }));
    versions();
    expect(await screen.findByText(/Nothing has gone live yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore into the draft" })).toBeNull();
  });

  it("a failed read says so in its own words; Try again reads again", async () => {
    vi.mocked(flowsClient.versions)
      .mockResolvedValueOnce(fail("LUME couldn't reach the server."))
      .mockResolvedValueOnce(ok({ versions: [] }));
    versions();
    expect(await screen.findByText("LUME couldn't reach the server.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Nothing has gone live yet/)).toBeInTheDocument();
  });

  it("a version where no step changed says so; a refused restore is said", async () => {
    vi.mocked(flowsClient.versions).mockResolvedValue(
      ok({
        versions: [
          {
            id: "v2",
            version: 2,
            createdAt: "2026-11-20T10:00:00Z",
            createdBy: null,
            live: true,
            changes: { added: 0, removed: 0, changed: 0 },
          },
          {
            id: "v1",
            version: 1,
            createdAt: "2026-11-10T10:00:00Z",
            createdBy: null,
            live: false,
            changes: { added: 1, removed: 0, changed: 0 },
          },
        ],
      }),
    );
    const onRestore = vi.fn(async () => ({
      ok: false,
      message: "Someone else changed this flow meanwhile.",
    }));
    versions({ onRestore });
    expect(await screen.findByText(/No step changed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restore into the draft" }));
    expect(screen.getByRole("status")).toHaveTextContent("Someone else changed this flow meanwhile.");
  });
});

describe("Replay", () => {
  it("nobody yet is said; a search asks again a moment after typing, and says when nobody matches", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(flowsClient.people).mockResolvedValue(ok({ people: [] }));
    replay();
    expect(await screen.findByText(/Nobody has been through this flow yet/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Find someone by name" }), "pri");
    // Not one request per letter.
    expect(flowsClient.people).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(300));
    await waitFor(() => expect(flowsClient.people).toHaveBeenLastCalledWith("f1", "pri"));
    expect(flowsClient.people).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByText("Nobody by that name has been through this flow lately."),
    ).toBeInTheDocument();
  });

  it("their runs can't be read (the lead was deleted meanwhile): it says so, and back is the list", async () => {
    vi.mocked(flowsClient.people).mockResolvedValue(
      ok({
        people: [
          { leadId: "l1", name: "Sam", photo: null, startedAt: "2026-11-20T10:00:00Z", status: "done" },
        ],
      }),
    );
    vi.mocked(flowsClient.runs).mockResolvedValue(fail("Lead not found"));
    replay();
    await userEvent.click(await screen.findByRole("button", { name: /Sam/ }));
    expect(await screen.findByText("Lead not found")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading their way through it")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Choose someone else/ }));
    expect(await screen.findByRole("button", { name: /Sam/ })).toBeInTheDocument();
    expect(screen.queryByText("Lead not found")).toBeNull();
  });

  it("several times through: each can be shown; a step since taken out is said; how a run ended is said", async () => {
    vi.mocked(flowsClient.people).mockResolvedValue(
      ok({
        people: [
          { leadId: "l1", name: "Sam", photo: null, startedAt: "2026-11-20T10:00:00Z", status: "stopped" },
        ],
      }),
    );
    vi.mocked(flowsClient.runs).mockResolvedValue(
      ok({
        runs: [
          run({
            id: "r2",
            status: "stopped",
            reason: "Instagram's time to reply ran out before this step.",
            trail: [
              { step: "hi", at: "2026-11-20T10:00:00Z" },
              { step: "gone", at: "2026-11-20T10:01:00Z" },
            ],
          }),
          run({ id: "r1", trail: [{ step: "hi", at: "2026-11-01T10:00:00Z" }] }),
        ],
      }),
    );
    const onLit = vi.fn();
    replay(onLit);
    await userEvent.click(await screen.findByRole("button", { name: /Sam/ }));
    const trail = await screen.findByRole("list", { name: "Their way through it" });
    expect(trail).toHaveTextContent("A step that isn't in the flow now");
    expect(trail).toHaveTextContent("Stopped");
    expect(trail).toHaveTextContent("Instagram's time to reply ran out before this step.");
    expect(onLit).toHaveBeenLastCalledWith(["hi", "gone"]);
    const times = screen.getByRole("group", { name: "Their times through it" });
    await userEvent.click(within(times).getAllByRole("button")[1]!);
    expect(screen.getByRole("list", { name: "Their way through it" })).toHaveTextContent("Finished");
    expect(onLit).toHaveBeenLastCalledWith(["hi"]);
    // Back to the list.
    await userEvent.click(screen.getByRole("button", { name: /Choose someone else/ }));
    expect(await screen.findByRole("searchbox", { name: "Find someone by name" })).toBeInTheDocument();
    expect(onLit).toHaveBeenLastCalledWith([]);
  });
});

describe("the panel's head", () => {
  it("arrow keys move between Test, Replay and Versions, round the ends, as a radio group does", async () => {
    const onTool = vi.fn();
    render(<PanelHead tool="test" onTool={onTool} onClose={vi.fn()} />);
    const test = screen.getByRole("radio", { name: "Test" });
    expect(test).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Replay" })).toHaveAttribute("tabindex", "-1");
    test.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onTool).toHaveBeenLastCalledWith("replay");
    await userEvent.keyboard("{ArrowLeft}");
    expect(onTool).toHaveBeenLastCalledWith("versions");
  });
});
