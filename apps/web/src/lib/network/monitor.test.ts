import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIRM_MS, PROBE_MS, startNetMonitor, tripOf, unreachable } from "./monitor";
import type { createNetWatch } from "./watch";

const ORIGIN = "https://lume.example";
const entry = (over: Record<string, unknown> = {}) =>
  ({
    initiatorType: "fetch",
    name: `${ORIGIN}/api/v1/leads?limit=50`,
    startTime: 5000,
    requestStart: 5010,
    responseStart: 7210,
    serverTiming: [{ name: "app", duration: 200 }],
    ...over,
  }) as unknown as PerformanceResourceTiming;

describe("one answer's trip", () => {
  it("the wait from sending to the first byte, less LUME's own time", () => {
    expect(tripOf(entry(), 0, ORIGIN)).toEqual({ net: 2000, server: 200 });
  });

  it("never below nothing", () => {
    expect(tripOf(entry({ responseStart: 5100 }), 0, ORIGIN)).toEqual({ net: 0, server: 200 });
  });

  it("not counted: uploads, other sites, LUME's live stream, no LUME timing, no timing at all, a background tab", () => {
    expect(tripOf(entry({ initiatorType: "xmlhttprequest" }), 0, ORIGIN)).toBeNull();
    expect(tripOf(entry({ name: "https://elsewhere.example/api/v1/leads" }), 0, ORIGIN)).toBeNull();
    expect(tripOf(entry({ name: `${ORIGIN}/f/abc.pdf` }), 0, ORIGIN)).toBeNull();
    expect(tripOf(entry({ name: `${ORIGIN}/api/v1/notifications/stream` }), 0, ORIGIN)).toBeNull();
    expect(tripOf(entry({ serverTiming: [] }), 0, ORIGIN)).toBeNull();
    expect(tripOf(entry({ serverTiming: [{ name: "edge", duration: 1 }] }), 0, ORIGIN)).toBeNull();
    expect(tripOf(entry({ responseStart: 0 }), 0, ORIGIN)).toBeNull();
    expect(tripOf(entry({ requestStart: 0 }), 0, ORIGIN)).toBeNull();
    // Started before the tab came back to the front: the browser held it back on purpose.
    expect(tripOf(entry(), 5001, ORIGIN)).toBeNull();
    expect(tripOf(entry(), 5000, ORIGIN)).not.toBeNull();
  });
});

describe("the monitor", () => {
  let calls: string[];
  let watch: ReturnType<typeof createNetWatch>;
  let stop: () => void;
  let answer: () => Promise<unknown>;
  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    let st: "fine" | "offline" = "fine";
    watch = {
      trip: () => undefined,
      offline: () => (calls.push("offline"), (st = "offline")),
      online: () => (calls.push("online"), (st = "fine")),
      dismiss: () => undefined,
      state: () => st,
      stop: () => undefined,
    } as unknown as ReturnType<typeof createNetWatch>;
    answer = () => Promise.resolve(new Response("ok", { status: 200 }));
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => (calls.push(`probe ${url}`), answer())),
    );
    stop = startNetMonitor(watch);
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("the browser's own offline and online: at once", async () => {
    window.dispatchEvent(new Event("offline"));
    expect(calls).toEqual(["offline"]);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["offline", "probe /healthz", "online"]);
  });

  it("a request that couldn't reach LUME, while LUME itself answers (restarting: 502): never offline", async () => {
    answer = () => Promise.resolve(new Response("", { status: 502 }));
    unreachable();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["probe /healthz"]);
  });

  it("couldn't reach LUME and two checks 3 seconds apart fail too: offline, checked every 5 seconds until it's back", async () => {
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    unreachable();
    unreachable(); // one check at a time
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["probe /healthz"]);
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    expect(calls).toEqual(["probe /healthz", "probe /healthz", "offline"]);
    await vi.advanceTimersByTimeAsync(PROBE_MS);
    expect(calls).toEqual(["probe /healthz", "probe /healthz", "offline", "probe /healthz"]);
    answer = () => Promise.resolve(new Response("ok"));
    await vi.advanceTimersByTimeAsync(PROBE_MS);
    expect(calls.slice(-2)).toEqual(["probe /healthz", "online"]);
    await vi.advanceTimersByTimeAsync(PROBE_MS * 3);
    expect(calls.length).toBe(6);
  });

  it("LUME's own update (refused for a moment, then back): never offline", async () => {
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    unreachable();
    await vi.advanceTimersByTimeAsync(0);
    answer = () => Promise.resolve(new Response("ok"));
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    expect(calls).toEqual(["probe /healthz", "probe /healthz"]);
    await vi.advanceTimersByTimeAsync(PROBE_MS * 3);
    expect(calls).toEqual(["probe /healthz", "probe /healthz"]);
    // Back: the next lone failure is checked again too, never taken as the second.
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    unreachable();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["probe /healthz", "probe /healthz", "probe /healthz"]);
  });

  it("stopped while a check is on its way: its answer changes nothing", async () => {
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    unreachable();
    await vi.advanceTimersByTimeAsync(0);
    // The second look, the one that would say offline, is on its way when the page goes.
    let fail: (e: unknown) => void = () => {};
    answer = () => new Promise((_ok, no) => (fail = no));
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    stop();
    fail(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(PROBE_MS * 3);
    expect(calls).toEqual(["probe /healthz", "probe /healthz"]);
  });

  it("stopped: nothing more is checked, and nothing more is heard", async () => {
    answer = () => Promise.reject(new TypeError("Failed to fetch"));
    unreachable();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(CONFIRM_MS);
    stop();
    await vi.advanceTimersByTimeAsync(PROBE_MS * 3);
    window.dispatchEvent(new Event("offline"));
    unreachable();
    expect(calls).toEqual(["probe /healthz", "probe /healthz", "offline"]);
  });
});
