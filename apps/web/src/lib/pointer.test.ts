import { describe, expect, it } from "vitest";
import { capturePointer } from "./pointer";

describe("capturing a pointer", () => {
  it("a pointer the browser no longer counts as active is left alone, never an error that stops the page", () => {
    const el = document.createElement("div");
    el.setPointerCapture = () => {
      throw new DOMException("No active pointer with the given id is found.", "NotFoundError");
    };
    expect(() => capturePointer(el, 7)).not.toThrow();
    expect(capturePointer(el, 7)).toBe(false);
  });

  it("an active one is captured", () => {
    const el = document.createElement("div");
    let got = -1;
    el.setPointerCapture = (id: number) => void (got = id);
    expect(capturePointer(el, 3)).toBe(true);
    expect(got).toBe(3);
  });
});
