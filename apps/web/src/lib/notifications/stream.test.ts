import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribe, useStream } from "./stream";

class FakeSource {
  static made: FakeSource[] = [];
  closed = false;
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
  emit(data: unknown) {
    for (const h of this.handlers) h({ data: JSON.stringify(data) } as MessageEvent<string>);
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
