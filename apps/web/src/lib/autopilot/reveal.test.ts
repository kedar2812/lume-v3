import { describe, expect, it } from "vitest";
import { revealed } from "./reveal";

/** How much of a message LUME AI is writing shows now (Autopilot A3; spec 2026-10-19 §2: typed at reading speed). */
const T = "Hi Meera, thanks for your enquiry. Can we help?";
const start = new Date("2026-10-26T09:00:00.000Z");
const end = new Date("2026-10-26T09:00:04.000Z");
const at = (ms: number) => new Date(start.getTime() + ms);

describe("revealed", () => {
  it("nothing before it starts, all of it by the end", () => {
    expect(revealed(T, start, end, at(-500))).toBe("");
    expect(revealed(T, start, end, at(0))).toBe("");
    expect(revealed(T, start, end, end)).toBe(T);
    expect(revealed(T, start, end, at(9_000))).toBe(T);
  });

  it("part way: whole words only, never half of one", () => {
    const half = revealed(T, start, end, at(2_000));
    expect(T.startsWith(half)).toBe(true);
    expect(half.length).toBeGreaterThan(0);
    expect(half.length).toBeLessThan(T.length);
    expect(T[half.length] === " " || half.length === T.length).toBe(true);
    expect(half.endsWith(" ")).toBe(false);
  });

  it("grows as time passes", () => {
    const steps = [500, 1_000, 2_000, 3_000, 3_900].map((ms) => revealed(T, start, end, at(ms)).length);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeGreaterThanOrEqual(steps[i - 1]!);
  });

  it("a window already over, or none at all, shows it all", () => {
    expect(revealed(T, start, start, at(0))).toBe(T);
    expect(revealed(T, end, start, at(0))).toBe(T);
  });

  it("emoji and other scripts are never split", () => {
    const t = "नमस्ते मीरा 🙏 कैसे मदद करें?";
    for (let ms = 0; ms <= 4_000; ms += 250) {
      const shown = revealed(t, start, end, at(ms));
      expect(t.startsWith(shown)).toBe(true);
      expect(shown === "" || shown === t || t[shown.length] === " ").toBe(true);
    }
  });
});
