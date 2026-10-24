import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotEvent } from "@/lib/notifications/stream";
import { autopilotClient } from "./client";
import type { RunDetail } from "./types";
import { useLiveRuns, useRun } from "./use-run";

vi.mock("./client", () => ({ autopilotClient: { run: vi.fn(), runs: vi.fn() } }));
let hear: ((e: AutopilotEvent) => void) | null = null;
vi.mock("@/lib/notifications/stream", () => ({
  useAutopilot: (on: (e: AutopilotEvent) => void) => {
    hear = on;
  },
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const detail = (id: string, name = "Run"): RunDetail =>
  ({ run: { id, name }, counts: {}, leads: [], asks: [] }) as unknown as RunDetail;
/** A promise the test resolves when it wants the answer to land. */
function later<T>() {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => (resolve = r));
  return { p, resolve };
}

beforeEach(() => {
  // Reset, not clear: an answer queued for one test must never reach the next.
  vi.resetAllMocks();
  hear = null;
});

describe("useRun (Autopilot A3)", () => {
  it("reads the run once, then again when the stream says it changed", async () => {
    vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail("r1")));
    const { result } = renderHook(() => useRun("r1"));
    await waitFor(() => expect(result.current.data?.run.id).toBe("r1"));
    expect(autopilotClient.run).toHaveBeenCalledTimes(1);
    act(() => hear!({ run: "r2", lead: null, kind: "sent" }));
    expect(autopilotClient.run).toHaveBeenCalledTimes(1);
    act(() => hear!({ run: "r1", lead: "l1", kind: "sent" }));
    await waitFor(() => expect(autopilotClient.run).toHaveBeenCalledTimes(2));
    act(() => hear!({ run: "*", lead: null, kind: "reconnected" }));
    await waitFor(() => expect(autopilotClient.run).toHaveBeenCalledTimes(3));
  });

  it("a burst of changes while a read is out asks once more, not once each", async () => {
    vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail("r1")));
    const { result } = renderHook(() => useRun("r1"));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    const slow = later<ReturnType<typeof ok<RunDetail>>>();
    vi.mocked(autopilotClient.run).mockReturnValueOnce(slow.p);
    act(() => {
      for (let i = 0; i < 10; i++) hear!({ run: "r1", lead: "l1", kind: "draft" });
    });
    expect(autopilotClient.run).toHaveBeenCalledTimes(2);
    await act(async () => slow.resolve(ok(detail("r1"))));
    await waitFor(() => expect(autopilotClient.run).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(autopilotClient.run).toHaveBeenCalledTimes(3);
  });

  it("switching runs: an answer for the run left behind never shows", async () => {
    const first = later<ReturnType<typeof ok<RunDetail>>>();
    vi.mocked(autopilotClient.run)
      .mockReturnValueOnce(first.p)
      .mockResolvedValueOnce(ok(detail("r2", "Second")));
    const { result, rerender } = renderHook(({ id }) => useRun(id), { initialProps: { id: "r1" } });
    rerender({ id: "r2" });
    await waitFor(() => expect(result.current.data?.run.name).toBe("Second"));
    await act(async () => first.resolve(ok(detail("r1", "First"))));
    expect(result.current.data?.run.name).toBe("Second");
  });

  it("a failed read keeps what's shown and says why", async () => {
    vi.mocked(autopilotClient.run).mockResolvedValueOnce(ok(detail("r1")));
    const { result } = renderHook(() => useRun("r1"));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    vi.mocked(autopilotClient.run).mockResolvedValueOnce({
      ok: false,
      status: 0,
      code: "OFFLINE",
      message: "LUME can’t reach the server right now.",
    });
    act(() => hear!({ run: "r1", lead: null, kind: "paused" }));
    await waitFor(() => expect(result.current.problem).toBe("LUME can’t reach the server right now."));
    expect(result.current.data?.run.id).toBe("r1");
  });

  it("coming back to the tab reads it again", async () => {
    vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail("r1")));
    renderHook(() => useRun("r1"));
    await waitFor(() => expect(autopilotClient.run).toHaveBeenCalledTimes(1));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(autopilotClient.run).toHaveBeenCalledTimes(2));
  });

  it("no run chosen: nothing is read", () => {
    const { result } = renderHook(() => useRun(null));
    expect(autopilotClient.run).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ data: null, loading: false });
  });
});

describe("useLiveRuns (the Autopilot nav's Live pill)", () => {
  it("how many runs are going, read again when any run changes", async () => {
    vi.mocked(autopilotClient.runs).mockResolvedValueOnce(ok({ runs: [], running: 1 }));
    const { result } = renderHook(() => useLiveRuns(true));
    await waitFor(() => expect(result.current).toBe(1));
    vi.mocked(autopilotClient.runs).mockResolvedValueOnce(ok({ runs: [], running: 0 }));
    act(() => hear!({ run: "r9", lead: null, kind: "run_ended" }));
    await waitFor(() => expect(result.current).toBe(0));
  });

  it("not asked at all for someone who can't see runs", () => {
    const { result } = renderHook(() => useLiveRuns(false));
    expect(result.current).toBe(0);
    expect(autopilotClient.runs).not.toHaveBeenCalled();
  });
});
