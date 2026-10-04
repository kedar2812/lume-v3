import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopProgress } from "@/components/ui/TopProgress";
import { LoadingProvider, creep, useAfter, useCountdown, useLoadingSignal } from "./loading";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function Loader({ on }: { on: boolean }) {
  useLoadingSignal(on);
  return null;
}

describe("loading (7C)", () => {
  it("the bar leaps to a third at once, then creeps, never reaching the end on its own", () => {
    expect(creep(0)).toBeCloseTo(0.3, 2);
    expect(creep(1000)).toBeGreaterThan(0.5);
    expect(creep(1000)).toBeLessThan(creep(3000));
    expect(creep(60_000)).toBeLessThan(0.93);
  });

  it("shows under the top bar only once something has loaded for a moment, and completes when all are done", () => {
    const view = (a: boolean, b: boolean) => (
      <LoadingProvider>
        <TopProgress />
        <Loader on={a} />
        <Loader on={b} />
      </LoadingProvider>
    );
    const { rerender } = render(view(true, false));
    const bar = () => screen.queryByTestId("top-progress");
    expect(bar()).toHaveAttribute("data-state", "idle"); // a quick answer never flashes a bar
    act(() => void vi.advanceTimersByTime(200));
    expect(bar()).toHaveAttribute("data-state", "running");
    rerender(view(true, true));
    rerender(view(false, true)); // one still loading: the bar stays
    act(() => void vi.advanceTimersByTime(400));
    expect(bar()).toHaveAttribute("data-state", "running");
    rerender(view(false, false));
    expect(bar()).toHaveAttribute("data-state", "done");
    act(() => void vi.advanceTimersByTime(600));
    expect(bar()).toHaveAttribute("data-state", "idle");
  });

  it("useAfter turns on only after the wait, and off at once", () => {
    const { result, rerender } = renderHook(({ on }) => useAfter(on, 1200), { initialProps: { on: true } });
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1199));
    expect(result.current).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
  });

  it("the countdown says the seconds left, then tries again, and starts over if that fails too", () => {
    const retry = vi.fn();
    const { result, rerender } = renderHook(({ on }) => useCountdown(on, 5, retry), {
      initialProps: { on: true },
    });
    expect(result.current).toBe(5);
    act(() => void vi.advanceTimersByTime(2000));
    expect(result.current).toBe(3);
    act(() => void vi.advanceTimersByTime(3000));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender({ on: false });
    expect(result.current).toBeNull();
    rerender({ on: true });
    expect(result.current).toBe(5);
  });
});
