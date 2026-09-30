import { describe, expect, it } from "vitest";
import { Limiter } from "./limit";

describe("Limiter", () => {
  it("allows its number in a window, then says how long to wait", () => {
    const l = new Limiter(2, 60_000);
    expect(l.take("a", 0).ok).toBe(true);
    expect(l.take("a", 1_000).ok).toBe(true);
    const no = l.take("a", 2_000);
    expect(no).toEqual({ ok: false, retryAfterS: 58, first: true });
    expect(l.take("b", 2_000).ok).toBe(true);
    expect(l.take("a", 60_000).ok).toBe(true);
  });
  it("forgets windows that have passed, so it doesn't grow without end", () => {
    const l = new Limiter(1, 1_000);
    for (let i = 0; i < 5000; i++) l.take(`k${i}`, i);
    l.take("late", 10_000);
    expect(l.size).toBeLessThan(5000);
  });
  it("says which refusal is the first in its window (for logging it once)", () => {
    const l = new Limiter(1, 60_000);
    l.take("a", 0);
    expect(l.take("a", 1)).toMatchObject({ ok: false, first: true });
    expect(l.take("a", 2)).toMatchObject({ ok: false, first: false });
    l.take("a", 60_000);
    expect(l.take("a", 60_001)).toMatchObject({ ok: false, first: true });
  });
});
