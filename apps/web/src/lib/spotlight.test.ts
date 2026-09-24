import { describe, expect, it } from "vitest";
import { cardPosition, clipPathFor } from "./spotlight";

const viewport = { width: 1000, height: 800 };

describe("spotlight geometry", () => {
  it("cuts an even-odd hole around the target, inside the viewport", () => {
    const p = clipPathFor({ top: 100, left: 50, width: 200, height: 40 }, 8, 14, viewport);
    expect(p.startsWith('path(evenodd,"M0 0H1000V800H0Z')).toBe(true);
    expect(p).toContain("M56 92"); // left − pad + radius: the hole starts after the outer rect
    expect(p.endsWith('Z")')).toBe(true);
  });

  it("never lets the hole leave the screen", () => {
    const p = clipPathFor({ top: -20, left: -30, width: 100, height: 50 }, 8, 14, viewport);
    expect(p).not.toMatch(/-\d/);
  });

  it("keeps the corner radius sane for a tiny target", () => {
    const p = clipPathFor({ top: 10, left: 10, width: 4, height: 4 }, 0, 14, viewport);
    expect(p).toContain("A2 2"); // never larger than half the hole
  });

  it("puts the card beside a sidebar target and below a top-bar target", () => {
    const card = { width: 330, height: 180 };
    expect(cardPosition({ top: 120, left: 10, width: 200, height: 34 }, "right", card, viewport)).toEqual({
      top: 108,
      left: 228,
    });
    expect(cardPosition({ top: 20, left: 600, width: 200, height: 34 }, "bottom", card, viewport)).toEqual({
      top: 70,
      left: 535,
    });
  });

  it("flips a card that would fall off the edge back inside", () => {
    const card = { width: 330, height: 180 };
    const pos = cardPosition({ top: 700, left: 900, width: 80, height: 34 }, "bottom", card, viewport);
    expect(pos.top + card.height).toBeLessThanOrEqual(viewport.height);
    expect(pos.left + card.width).toBeLessThanOrEqual(viewport.width);
    const beside = cardPosition({ top: 300, left: 800, width: 150, height: 34 }, "right", card, viewport);
    expect(beside.left + card.width).toBeLessThanOrEqual(viewport.width);
  });

  it("stays on a phone-sized screen even when the card barely fits", () => {
    const phone = { width: 360, height: 640 };
    const card = { width: 330, height: 180 };
    const pos = cardPosition({ top: 20, left: 300, width: 40, height: 34 }, "bottom", card, phone);
    expect(pos.left).toBeGreaterThanOrEqual(12);
    expect(pos.left + card.width).toBeLessThanOrEqual(phone.width);
    expect(pos.top).toBeGreaterThanOrEqual(12);
  });
});
