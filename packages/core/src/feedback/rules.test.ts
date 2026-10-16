import { describe, expect, it } from "vitest";
import { testJpeg, testWebp } from "../images/fixtures";
import { checkFeedbackImage, FEEDBACK_LIMITS, pagePath } from "./rules";

describe("checkFeedbackImage", () => {
  it("takes a real WebP or JPEG, and says its size", () => {
    expect(checkFeedbackImage(testWebp(1920, 1080))).toEqual({
      ok: true,
      type: "image/webp",
      width: 1920,
      height: 1080,
    });
    expect(checkFeedbackImage(testJpeg(2400, 1350))).toEqual({
      ok: true,
      type: "image/jpeg",
      width: 2400,
      height: 1350,
    });
  });
  it("refuses a picture longer than 2400 px on either edge, before reading on", () => {
    expect(checkFeedbackImage(testWebp(2401, 900))).toEqual({
      ok: false,
      reason: "over 2400 pixels on its long edge",
    });
    expect(checkFeedbackImage(testJpeg(900, 2401))).toEqual({
      ok: false,
      reason: "over 2400 pixels on its long edge",
    });
  });
  it("refuses more than 1.5 MB, nothing at all, and what isn't a WebP or JPEG", () => {
    const big = new Uint8Array(FEEDBACK_LIMITS.imageBytes + 1);
    expect(checkFeedbackImage(big)).toEqual({ ok: false, reason: "over 1.5 MB" });
    expect(checkFeedbackImage(new Uint8Array(0))).toEqual({ ok: false, reason: "empty" });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(checkFeedbackImage(png)).toEqual({ ok: false, reason: "not a WebP or JPEG image" });
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(checkFeedbackImage(svg)).toEqual({ ok: false, reason: "not a WebP or JPEG image" });
  });
  it("refuses a WebP cut short (its header says more than there is)", () => {
    const w = testWebp(800, 600);
    expect(checkFeedbackImage(w.slice(0, w.length - 4)).ok).toBe(false);
  });
});

describe("pagePath", () => {
  it("keeps the path and drops what was searched", () => {
    expect(pagePath("/leads?q=Ananya%20Rao&stage=new")).toBe("/leads");
    expect(pagePath("/leads/0190e0c0-0000-7000-8000-000000000001#contact")).toBe(
      "/leads/0190e0c0-0000-7000-8000-000000000001",
    );
  });
  it("is always a path, and never longer than 300", () => {
    expect(pagePath("https://evil.example/x")).toBe("/");
    expect(pagePath("//evil.example/x")).toBe("/");
    expect(pagePath("")).toBe("/");
    expect(pagePath("/a\u0000b\nc")).toBe("/abc");
    expect(pagePath(`/${"x".repeat(400)}`)).toHaveLength(300);
  });
});
