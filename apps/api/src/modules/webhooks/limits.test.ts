import { describe, expect, it } from "vitest";
import { createLimiter } from "./limits";

describe("createLimiter (2C spec §2 Rate; final review, Important 2 and 3)", () => {
  it("a source gets its share per window, and says how long to wait", () => {
    let t = 0;
    const l = createLimiter({ perSource: 2, perInstance: 100, windowMs: 60_000, now: () => t });
    expect(l.source("a")).toEqual({ ok: true });
    expect(l.source("a")).toEqual({ ok: true });
    t = 15_000;
    expect(l.source("a")).toEqual({ ok: false, retryAfterSec: 45, first: true });
    expect(l.source("a")).toEqual({ ok: false, retryAfterSec: 45, first: false }); // counted once a window
    expect(l.source("b")).toEqual({ ok: true });
    t = 60_000;
    expect(l.source("a")).toEqual({ ok: true });
  });

  it("the instance's share is spent only by posts that proved themselves", () => {
    const l = createLimiter({ perSource: 60, perInstance: 3, windowMs: 60_000, now: () => 0 });
    for (let i = 0; i < 3; i++) expect(l.instance()).toEqual({ ok: true });
    expect(l.instance()).toMatchObject({ ok: false });
  });

  it("the gate turns a flood away before any lookup, at five times the instance's share", () => {
    const l = createLimiter({ perSource: 60, perInstance: 2, windowMs: 60_000, now: () => 0 });
    for (let i = 0; i < 10; i++) expect(l.gate()).toEqual({ ok: true });
    expect(l.gate()).toMatchObject({ ok: false });
  });

  it("remembers a bounded number of addresses, however many it's asked about", () => {
    const l = createLimiter({
      perSource: 60,
      perInstance: 600,
      windowMs: 60_000,
      now: () => 0,
      maxKeys: 100,
    });
    for (let i = 0; i < 20_000; i++) l.source(`id-${i}`);
    expect(l.size()).toBeLessThanOrEqual(100);
  });
});
