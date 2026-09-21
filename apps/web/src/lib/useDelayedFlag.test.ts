import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDelayedFlag } from "./useDelayedFlag";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useDelayedFlag", () => {
  it("stays false for fast loads and turns true only after the delay", () => {
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 150), {
      initialProps: { on: true },
    });
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(149));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
  });
});
