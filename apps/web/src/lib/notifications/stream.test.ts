import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribe, useStream } from "./stream";

class FakeSource {
  static made: FakeSource[] = [];
  static CLOSED = 2;
  closed = false;
  readyState = 1;
  onerror: (() => void) | null = null;
  handlers: ((e: MessageEvent<string>) => void)[] = [];
  constructor(public url: string) {
    FakeSource.made.push(this);
  }
  addEventListener(_: string, h: (e: MessageEvent<string>) => void) {
    this.handlers.push(h);
  }
  close() {
    this.closed = true;
  }
  emit(data: { id: number } & Record<string, unknown>) {
    for (const h of this.handlers)
      h({ data: JSON.stringify(data), lastEventId: String(data.id) } as MessageEvent<string>);
  }
  /** The server went away for good (a 502 during a restart): the browser gives up on this one. */
  die() {
    this.readyState = FakeSource.CLOSED;
    this.onerror?.();
  }
}
beforeEach(() => {
  FakeSource.made = [];
  vi.stubGlobal("EventSource", FakeSource);
});
afterEach(() => vi.unstubAllGlobals());

describe("the live stream", () => {
  it("one connection per tab, shared, and closed when the last listener goes", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribe(a);
    const offB = subscribe(b);
    expect(FakeSource.made).toHaveLength(1);
    expect(FakeSource.made[0]!.url).toBe("/api/v1/stream");
    FakeSource.made[0]!.emit({ id: 1, title: "Follow up — Aisha" });
    expect(a).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    expect(FakeSource.made[0]!.closed).toBe(false);
    offB();
    expect(FakeSource.made[0]!.closed).toBe(true);
  });

  it("useStream listens while mounted and lets go on unmount", () => {
    const on = vi.fn();
    const { unmount } = renderHook(() => useStream(on));
    FakeSource.made[0]!.emit({ id: 2, title: "x" });
    expect(on).toHaveBeenCalledTimes(1);
    unmount();
    expect(FakeSource.made[0]!.closed).toBe(true);
  });
});

describe("3A final review", () => {
  it("Important 4: when the browser gives up (a restart's 502), LUME opens a new one from where it was", async () => {
    vi.useFakeTimers();
    const on = vi.fn();
    const off = subscribe(on);
    const first = FakeSource.made[0]!;
    first.emit({ id: 41, title: "Before" });
    first.die();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSource.made).toHaveLength(2);
    expect(FakeSource.made[1]!.url).toBe("/api/v1/stream?after=41");
    off();
    vi.useRealTimers();
  });

  it("Important 3: the same notification twice (a replay's overlap) reaches listeners once", () => {
    const on = vi.fn();
    const off = subscribe(on);
    const s = FakeSource.made[0]!;
    s.emit({ id: 7, title: "Once" });
    s.emit({ id: 7, title: "Once" });
    expect(on).toHaveBeenCalledTimes(1);
    off();
  });
});
