import { describe, expect, it } from "vitest";
import { blockSize, encodeSteps, fitWithin, normRect, notSent, screenOf, themeOf, toImageRect } from "./shots";

describe("fitWithin", () => {
  it("keeps a picture within 2400 px on its long edge, in proportion, and never enlarges it", () => {
    expect(fitWithin(3840, 2160, 2400)).toEqual({ w: 2400, h: 1350 });
    expect(fitWithin(1170, 2532, 2400)).toEqual({ w: 1109, h: 2400 });
    expect(fitWithin(800, 600, 2400)).toEqual({ w: 800, h: 600 });
  });
});

describe("encodeSteps", () => {
  it("tries the best first, then lower quality, then smaller, and ends small enough for any screen", () => {
    const s = encodeSteps();
    expect(s[0]).toEqual({ scale: 1, quality: 0.85 });
    expect(s[1]).toEqual({ scale: 1, quality: 0.7 });
    expect(s.slice(2).every((x, i) => x.quality === 0.7 && x.scale < s[i + 1]!.scale)).toBe(true);
    // At the last step a 2400 × 2400 picture is under 600 × 600: under 1.5 MB at any quality.
    expect(s.at(-1)!.scale * 2400).toBeLessThan(600);
  });
});

describe("rectangles", () => {
  it("is the same box whichever way it was dragged", () => {
    expect(normRect({ x: 50, y: 40 }, { x: 10, y: 10 })).toEqual({ x: 10, y: 10, w: 40, h: 30 });
  });
  it("maps a box drawn on the preview onto the picture's own pixels", () => {
    expect(toImageRect({ x: 10, y: 20, w: 100, h: 50 }, { w: 400, h: 225 }, { w: 1600, h: 900 })).toEqual({
      x: 40,
      y: 80,
      w: 400,
      h: 200,
    });
  });
  it("blurs in blocks big enough that nothing under them reads", () => {
    expect(blockSize({ x: 0, y: 0, w: 40, h: 20 })).toBe(12);
    expect(blockSize({ x: 0, y: 0, w: 400, h: 200 })).toBe(25);
  });
});

describe("what travels with it", () => {
  it("says the screen and the theme", () => {
    expect(screenOf({ innerWidth: 1536, innerHeight: 864, devicePixelRatio: 1.25 })).toBe("1536 × 864 · 1.25×");
    expect(screenOf({ innerWidth: 390, innerHeight: 844, devicePixelRatio: 3 })).toBe("390 × 844 · 3×");
    const doc = (t?: string) => ({ documentElement: { dataset: t ? { theme: t } : {} } }) as unknown as Document;
    expect(themeOf(doc("obsidian"), false)).toBe("obsidian");
    expect(themeOf(doc("porcelain"), true)).toBe("porcelain");
    expect(themeOf(doc("system"), true)).toBe("obsidian");
    expect(themeOf(doc(), false)).toBe("porcelain");
  });
});

describe("notSent", () => {
  const no = (status: number, code: string, details?: unknown) => ({
    ok: false as const,
    status,
    code,
    message: "",
    details,
  });
  it("has words for every way a report doesn't go", () => {
    expect(notSent(no(503, "FEEDBACK_UNREACHABLE")).text).toBe(
      "LUME couldn't reach its team just now. Your report is still here — try again in a minute.",
    );
    expect(notSent(no(0, "OFFLINE")).text).toMatch(/couldn't reach its team/);
    expect(notSent(no(429, "FEEDBACK_LIMITED", { retryAfterSec: 1440 })).text).toBe(
      "That's a lot of reports in an hour — thank you. Try again in 24 minutes.",
    );
    expect(notSent(no(429, "FEEDBACK_LIMITED", { retryAfterSec: 30 })).text).toBe(
      "That's a lot of reports in an hour — thank you. Try again in a minute.",
    );
    expect(notSent(no(422, "FEEDBACK_IMAGE_REFUSED", { index: 2 }))).toEqual({
      text: "One screenshot can't be sent. Remove it or choose it again; the rest of your report is still here.",
      imageIndex: 2,
    });
    for (const code of ["FEEDBACK_LICENCE", "NO_LICENCE_KEY"])
      expect(notSent(no(409, code)).text).toBe(
        "This LUME's licence can't send feedback right now. Your report is still here.",
      );
  });
});
