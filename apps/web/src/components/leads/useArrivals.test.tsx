import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sheetsClient } from "@/lib/sheets/client";
import { GLOW_MS, useArrivals } from "./useArrivals";

vi.mock("@/lib/sheets/client", () => ({ sheetsClient: { arrivals: vi.fn(), seen: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sheetsClient.seen).mockResolvedValue(ok(null));
});
afterEach(() => vi.useRealTimers());

describe("useArrivals", () => {
  it("on opening Leads, what arrived since the last visit glows, staggered, and then fades", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(sheetsClient.arrivals).mockResolvedValue(
      ok({ since: "2026-09-26T18:00:00Z", count: 2, ids: ["a", "b"] }),
    );
    const { result } = renderHook(() => useArrivals());
    await waitFor(() => expect(result.current.glowing.size).toBe(2));
    expect([...result.current.glowing.entries()]).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    expect(result.current.count).toBe(2);
    act(() => void vi.advanceTimersByTime(GLOW_MS + 2 * 70 + 50));
    expect(result.current.glowing.size).toBe(0);
    expect(result.current.count).toBe(2); // the line stays until they leave
  });

  it("a first visit shows nothing; leaving (or hiding the tab) marks Leads seen", async () => {
    vi.mocked(sheetsClient.arrivals).mockResolvedValue(ok({ since: null, count: 0, ids: [] }));
    const { result, unmount } = renderHook(() => useArrivals());
    await waitFor(() => expect(sheetsClient.arrivals).toHaveBeenCalled());
    expect(result.current.glowing.size).toBe(0);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sheetsClient.seen).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    unmount();
    expect(sheetsClient.seen).toHaveBeenCalledTimes(2);
  });

  it("flash() glows the rows a Refresh brought in", async () => {
    vi.mocked(sheetsClient.arrivals).mockResolvedValue(ok({ since: null, count: 0, ids: [] }));
    const { result } = renderHook(() => useArrivals());
    await waitFor(() => expect(sheetsClient.arrivals).toHaveBeenCalled());
    act(() => result.current.flash(["x", "y", "z"]));
    expect([...result.current.glowing.keys()]).toEqual(["x", "y", "z"]);
  });
});
