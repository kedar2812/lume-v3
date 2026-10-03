import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCsrfForTests } from "@/lib/api";
import { bulkRunsClient, reasonWords, runLine, selectionBody, useBulkRun, type RunView } from "./bulk-runs";
import { EMPTY_FILTERS } from "./filters";

const run = (over: Partial<RunView> = {}): RunView => ({
  id: "r1",
  userId: "u1",
  action: { type: "assign", ownerId: "u2" },
  selection: { kind: "ids", total: 3 },
  status: "running",
  total: 3,
  done: 1,
  skipped: 0,
  failed: 0,
  skippedBy: {},
  error: null,
  createdAt: "2026-10-03T10:00:00Z",
  startedAt: "2026-10-03T10:00:00Z",
  finishedAt: null,
  undoOf: null,
  undoUntil: null,
  canUndo: false,
  ...over,
});
const calls: { url: string; init: RequestInit }[] = [];
let answer: (url: string) => Response = () => new Response("{}");
beforeEach(() => {
  resetCsrfForTests();
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/auth/csrf")) return new Response(JSON.stringify({ token: "t" }));
      return answer(url);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bulk runs client (7C)", () => {
  it("picked leads go as ids; everything that matches goes as the filter, minus the unticked, with the count seen", () => {
    expect(selectionBody({ mode: "ids", ids: ["a", "b"], except: [] }, EMPTY_FILTERS, 2)).toEqual({
      ids: ["a", "b"],
    });
    const body = selectionBody(
      { mode: "all", ids: [], except: ["x"] },
      { ...EMPTY_FILTERS, q: "mar", stageIds: ["s1"] },
      12408,
    );
    expect(body).toEqual({
      filters: expect.objectContaining({ q: "mar", stageId: "s1" }),
      except: ["x"],
      expected: 12408,
    });
    expect(JSON.stringify(body)).not.toContain('"ids"');
  });

  it("creates a run, cancels and undoes it at their own addresses", async () => {
    answer = () => new Response(JSON.stringify({ run: run() }), { status: 202 });
    await bulkRunsClient.create({ ids: ["a"] }, { type: "delete" });
    await bulkRunsClient.cancel("r1");
    await bulkRunsClient.undo("r1");
    const posts = calls.filter((c) => c.init.method === "POST").map((c) => c.url);
    expect(posts).toEqual([
      "/api/v1/leads/bulk-runs",
      "/api/v1/leads/bulk-runs/r1/cancel",
      "/api/v1/leads/bulk-runs/r1/undo",
    ]);
  });

  it("polls a running run every second, and stops once it finishes or the screen closes", async () => {
    vi.useFakeTimers();
    let n = 0;
    answer = () => {
      n += 1;
      return new Response(
        JSON.stringify({ run: run(n >= 2 ? { status: "done", done: 3, finishedAt: "x" } : { done: n }) }),
      );
    };
    const { result, unmount } = renderHook(() => useBulkRun(run({ status: "queued", done: 0 })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current?.done).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current?.status).toBe("done");
    const seen = calls.filter((c) => c.url === "/api/v1/leads/bulk-runs/r1").length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls.filter((c) => c.url === "/api/v1/leads/bulk-runs/r1").length).toBe(seen);
    unmount();
  });

  it("says why leads were skipped, and what a run did, in words", () => {
    expect(reasonWords("CHANGED_SINCE", 4)).toBe(
      "4 were changed by someone after the action, so LUME kept the newer change",
    );
    expect(reasonWords("LEAD_NOT_FOUND", 1)).toBe(
      "1 was deleted, or stopped being yours to see, before LUME reached it",
    );
    expect(reasonWords("SOMETHING_NEW", 2)).toBe("2 couldn’t be changed");
    const names = { person: () => "Riya Shah", stage: () => "Contacted", tag: () => "VIP" };
    expect(runLine(run({ status: "done", done: 12396 }), names)).toBe("12,396 leads assigned to Riya Shah");
    expect(runLine(run({ status: "running", action: { type: "stage", stageId: "s" } }), names)).toBe(
      "Moving to Contacted",
    );
    expect(runLine(run({ status: "done", done: 1, action: { type: "delete" } }), names)).toBe(
      "1 lead deleted",
    );
    expect(runLine(run({ status: "done", done: 40, action: { type: "undo", of: "assign" } }), names)).toBe(
      "40 leads put back",
    );
  });
});
