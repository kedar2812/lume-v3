import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATCH_UP_SPREAD_MS,
  subscribe,
  subscribeLeads,
  useAutopilot,
  useLeadsChanged,
  useStream,
  useWhatsApp,
} from "./stream";

class FakeSource {
  static made: FakeSource[] = [];
  static CLOSED = 2;
  closed = false;
  readyState = 1;
  onerror: (() => void) | null = null;
  handlers: ((e: MessageEvent<string>) => void)[] = [];
  named: Record<string, (() => void)[]> = {};
  /** Named events that carry data (Autopilot's), handed their own text. */
  raw: Record<string, ((e: MessageEvent<string>) => void)[]> = {};
  constructor(public url: string) {
    FakeSource.made.push(this);
  }
  addEventListener(name: string, h: (e: MessageEvent<string>) => void) {
    if (name === "notification") this.handlers.push(h);
    else {
      (this.named[name] ??= []).push(() => h({ data: "{}" } as MessageEvent<string>));
      (this.raw[name] ??= []).push(h);
    }
  }
  /** Leads changed somewhere (4B): an event with no id and no data worth reading. */
  emitLeads() {
    for (const h of this.named.leads ?? []) h();
  }
  close() {
    this.closed = true;
  }
  /** A named event with its own text (Autopilot A2: `autopilot`, its run, lead and kind). */
  emitText(name: string, text: string) {
    for (const h of this.raw[name] ?? []) h({ data: text } as MessageEvent<string>);
  }
  emit(data: { id: number } & Record<string, unknown>) {
    for (const h of this.handlers)
      h({ data: JSON.stringify(data), lastEventId: String(data.id) } as MessageEvent<string>);
  }
  /** The connection is (re)open: the first time, and again after the browser's own retry. */
  opened() {
    for (const h of this.named.open ?? []) h();
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

describe("leads changed (4B Task 4)", () => {
  const setVisible = (v: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => setVisible("visible"));

  it("useLeadsChanged fires on `leads`, not on a notification, sharing the tab's one stream", () => {
    const on = vi.fn();
    const note = vi.fn();
    renderHook(() => useLeadsChanged(on));
    renderHook(() => useStream(note));
    expect(FakeSource.made).toHaveLength(1);
    FakeSource.made[0]!.emit({ id: 9, title: "A note" });
    expect(on).not.toHaveBeenCalled();
    FakeSource.made[0]!.emitLeads();
    expect(on).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledTimes(1);
  });

  it("a hidden tab doesn't ask; shown again, it asks once", () => {
    const on = vi.fn();
    renderHook(() => useLeadsChanged(on));
    setVisible("hidden");
    FakeSource.made[0]!.emitLeads();
    FakeSource.made[0]!.emitLeads();
    expect(on).not.toHaveBeenCalled();
    setVisible("visible");
    expect(on).toHaveBeenCalledTimes(1);
  });

  it("back after a dropped connection, leads may have changed meanwhile: listeners hear it once", async () => {
    vi.useFakeTimers();
    const heard = vi.fn();
    const off = subscribeLeads(heard);
    const src = FakeSource.made.at(-1)!;
    src.opened();
    await vi.advanceTimersByTimeAsync(CATCH_UP_SPREAD_MS);
    expect(heard).not.toHaveBeenCalled(); // the first connection isn't a change
    src.opened(); // the browser reconnected on its own
    src.opened(); // and again, before catching up: still once
    await vi.advanceTimersByTimeAsync(CATCH_UP_SPREAD_MS);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    vi.useRealTimers();
  });

  it("after an update restarts LUME, a thousand browsers catch up at moments of their own, within 5 s, never all at once", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const heard = vi.fn();
    const off = subscribeLeads(heard);
    const src = FakeSource.made.at(-1)!;
    src.opened();
    src.opened();
    expect(CATCH_UP_SPREAD_MS).toBe(5000);
    await vi.advanceTimersByTimeAsync(2499);
    expect(heard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("a tab that lets go before catching up asks for nothing", async () => {
    vi.useFakeTimers();
    const heard = vi.fn();
    const off = subscribeLeads(heard);
    const src = FakeSource.made.at(-1)!;
    src.opened();
    src.opened();
    off();
    await vi.advanceTimersByTimeAsync(CATCH_UP_SPREAD_MS);
    expect(heard).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("when the browser gives up, LUME's own retries are spread too: half the back-off, plus a share of the rest", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const off = subscribe(vi.fn());
    const before = FakeSource.made.length;
    FakeSource.made.at(-1)!.die();
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeSource.made).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSource.made).toHaveLength(before + 1);
    off();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
});

describe("Autopilot on the stream (A2 Task 9)", () => {
  it("useAutopilot hears each change, its run, lead and kind, on the tab's one stream; anything malformed is dropped", () => {
    const on = vi.fn();
    const note = vi.fn();
    renderHook(() => useAutopilot(on));
    renderHook(() => useStream(note));
    expect(FakeSource.made).toHaveLength(1);
    FakeSource.made[0]!.emitText("autopilot", JSON.stringify({ run: "r1", lead: "l1", kind: "draft" }));
    expect(on).toHaveBeenCalledWith({ run: "r1", lead: "l1", kind: "draft" });
    FakeSource.made[0]!.emitText("autopilot", "not json");
    FakeSource.made[0]!.emitText("autopilot", JSON.stringify({ kind: "draft" }));
    expect(on).toHaveBeenCalledTimes(1);
    expect(note).not.toHaveBeenCalled();
  });
  it("back after a drop, Autopilot's listeners hear that anything may have changed (run '*')", async () => {
    vi.useFakeTimers();
    const on = vi.fn();
    renderHook(() => useAutopilot(on));
    // The first open may be this tab's first connection or not (the stream outlives a test); the second is a return.
    FakeSource.made[0]!.opened();
    FakeSource.made[0]!.opened();
    await vi.advanceTimersByTimeAsync(CATCH_UP_SPREAD_MS);
    expect(on).toHaveBeenCalledWith({ run: "*", lead: null, kind: "reconnected" });
    vi.useRealTimers();
  });
  it("useWhatsApp hears each message in, out or tick, its lead and kind (and whose lead, in); anything else is dropped (2026-11-01)", () => {
    const on = vi.fn();
    renderHook(() => useWhatsApp(on));
    const src = FakeSource.made[0]!;
    src.emitText("whatsapp", JSON.stringify({ lead: "l1", kind: "in", owner: "u1" }));
    src.emitText("whatsapp", JSON.stringify({ lead: "l1", kind: "status" }));
    expect(on.mock.calls).toEqual([
      [{ lead: "l1", kind: "in", owner: "u1" }],
      [{ lead: "l1", kind: "status" }],
    ]);
    src.emitText("whatsapp", "not json");
    src.emitText("whatsapp", JSON.stringify({ lead: "l1", kind: "typing" }));
    src.emitText("whatsapp", JSON.stringify({ kind: "in" }));
    expect(on).toHaveBeenCalledTimes(2);
  });
  it("back after a drop, a chat hears that it may have missed messages (lead '*')", async () => {
    vi.useFakeTimers();
    const on = vi.fn();
    renderHook(() => useWhatsApp(on));
    FakeSource.made[0]!.opened();
    FakeSource.made[0]!.opened();
    await vi.advanceTimersByTimeAsync(CATCH_UP_SPREAD_MS);
    expect(on).toHaveBeenCalledWith({ lead: "*", kind: "reconnected" });
    vi.useRealTimers();
  });
});
