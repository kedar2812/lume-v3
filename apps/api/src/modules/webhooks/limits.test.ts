import { describe, expect, it } from "vitest";
import { createLimiter } from "./limits";

describe("createLimiter (2C spec §2 Rate)", () => {
  it("a source gets its share per window, and the instance its own; each says how long to wait", () => {
    let t = 0;
    const l = createLimiter({ perSource: 2, perInstance: 3, windowMs: 60_000, now: () => t });
    expect(l.take("a")).toEqual({ ok: true });
    expect(l.take("a")).toEqual({ ok: true });
    t = 15_000;
    expect(l.take("a")).toEqual({ ok: false, retryAfterSec: 45 });
    expect(l.take("b")).toEqual({ ok: true });
    expect(l.take("c")).toEqual({ ok: false, retryAfterSec: 45 });
    t = 60_000;
    expect(l.take("a")).toEqual({ ok: true });
  });
});
