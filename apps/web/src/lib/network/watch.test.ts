import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACK_MS, createNetWatch, type NetState } from "./watch";

let seen: NetState[];
let w: ReturnType<typeof createNetWatch>;
const SLOW = 2000;
const QUICK = 200;
beforeEach(() => {
  vi.useFakeTimers();
  seen = [];
  w = createNetWatch((s) => seen.push(s));
  w.trip(QUICK, 10); // the first answer after opening LUME never counts
});
afterEach(() => {
  w.stop();
  vi.useRealTimers();
});
const trips = (...ms: number[]) => ms.forEach((m) => w.trip(m, 20));

describe("the connection watch", () => {
  it("the first answer after opening LUME never counts, however slow", () => {
    const fresh = createNetWatch((s) => seen.push(s));
    fresh.trip(SLOW, 10);
    fresh.trip(SLOW, 10);
    fresh.trip(SLOW, 10);
    expect(fresh.state()).toBe("fine");
    fresh.trip(SLOW, 10);
    expect(fresh.state()).toBe("slow");
    fresh.stop();
  });

  it("slow when 3 of the last 5 answers spent over 1.5 seconds on the way", () => {
    trips(SLOW, QUICK, SLOW);
    expect(w.state()).toBe("fine");
    trips(QUICK, SLOW);
    expect(w.state()).toBe("slow");
    expect(seen).toEqual(["slow"]);
  });

  it("1.5 seconds exactly is not slow", () => {
    trips(1500, 1500, 1500, 1500, 1500);
    expect(w.state()).toBe("fine");
    trips(1501, 1501, 1501);
    expect(w.state()).toBe("slow");
  });

  it("two slow answers in five, spread out, never say slow", () => {
    trips(SLOW, QUICK, QUICK, QUICK, SLOW, QUICK, QUICK, QUICK, SLOW, QUICK);
    expect(w.state()).toBe("fine");
  });

  it("goes after 5 quick answers in a row, and not after 4", () => {
    trips(SLOW, SLOW, SLOW);
    trips(QUICK, QUICK, QUICK, QUICK);
    expect(w.state()).toBe("slow");
    trips(QUICK);
    expect(w.state()).toBe("fine");
    expect(seen).toEqual(["slow", "fine"]);
  });

  it("a slow LUME never blames the network: an answer LUME itself took a second on doesn't count", () => {
    w.trip(SLOW, 1200);
    w.trip(SLOW, 1200);
    w.trip(SLOW, 1200);
    expect(w.state()).toBe("fine");
    w.trip(SLOW, 999);
    w.trip(SLOW, 999);
    w.trip(SLOW, 999);
    expect(w.state()).toBe("slow");
  });

  it("dismissed, it stays away while it's still slow, and can come back once it has been quick again", () => {
    trips(SLOW, SLOW, SLOW);
    w.dismiss();
    expect(w.state()).toBe("fine");
    trips(SLOW, SLOW, SLOW, SLOW, SLOW, QUICK, QUICK, QUICK, QUICK, SLOW, SLOW, SLOW);
    expect(w.state()).toBe("fine");
    trips(QUICK, QUICK, QUICK, QUICK, QUICK);
    trips(SLOW, SLOW, SLOW);
    expect(w.state()).toBe("slow");
  });

  it("offline at once, ignores answers while offline, and stays until it's back", () => {
    w.offline();
    expect(w.state()).toBe("offline");
    trips(SLOW, SLOW, SLOW);
    vi.advanceTimersByTime(60_000);
    expect(w.state()).toBe("offline");
    w.offline();
    expect(seen).toEqual(["offline"]);
  });

  it("back: Back online for 3 seconds, then nothing, with what came before forgotten", () => {
    trips(SLOW, SLOW);
    w.offline();
    w.online();
    expect(w.state()).toBe("back");
    vi.advanceTimersByTime(BACK_MS - 1);
    expect(w.state()).toBe("back");
    vi.advanceTimersByTime(1);
    expect(w.state()).toBe("fine");
    trips(SLOW);
    expect(w.state()).toBe("fine");
    expect(seen).toEqual(["offline", "back", "fine"]);
  });

  it("offline replaces slow, and a dismissed slow starts afresh after a drop", () => {
    trips(SLOW, SLOW, SLOW);
    w.dismiss();
    w.offline();
    w.online();
    vi.advanceTimersByTime(BACK_MS);
    trips(SLOW, SLOW, SLOW);
    expect(w.state()).toBe("slow");
  });

  it("dropping again during Back online: offline, and the old 3 seconds never end it", () => {
    w.offline();
    w.online();
    vi.advanceTimersByTime(1000);
    w.offline();
    vi.advanceTimersByTime(BACK_MS);
    expect(w.state()).toBe("offline");
  });

  it("online while it never went offline changes nothing", () => {
    w.online();
    expect(w.state()).toBe("fine");
    expect(seen).toEqual([]);
  });

  it("dismiss when nothing shows changes nothing, and never keeps a later slow spell away", () => {
    w.dismiss();
    expect(seen).toEqual([]);
    trips(SLOW, SLOW, SLOW);
    expect(w.state()).toBe("slow");
  });

  it("answers that came while offline never count once it's back", () => {
    w.offline();
    trips(SLOW, SLOW, SLOW);
    w.online();
    vi.advanceTimersByTime(BACK_MS);
    trips(SLOW);
    expect(w.state()).toBe("fine");
  });

  it("stopped: no timer is left to fire", () => {
    w.offline();
    w.online();
    w.stop();
    vi.advanceTimersByTime(BACK_MS);
    expect(seen).toEqual(["offline", "back"]);
  });
});
