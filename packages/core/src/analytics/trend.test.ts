import { describe, expect, it } from "vitest";
import { signed, trend } from "./trend";

const M = "−";

describe("the trend rule (spec §4.5)", () => {
  it("the arrow follows the direction; the colour follows whether that's good for this number", () => {
    expect(trend(110, 100)).toEqual({ dir: "up", tone: "good", text: "+10.0%" });
    expect(trend(90, 100)).toEqual({ dir: "down", tone: "bad", text: `${M}10.0%` });
    // Fewer clients lost is good: a green arrow pointing down.
    expect(trend(1, 3, { kind: "abs", good: "down" })).toEqual({ dir: "down", tone: "good", text: `${M}2` });
    expect(trend(3, 1, { kind: "abs", good: "down" })).toEqual({ dir: "up", tone: "bad", text: "+2" });
  });

  it("decides on the rounded, shown number: anything that rounds to zero is No change, grey and flat", () => {
    expect(trend(100.04, 100)).toEqual({ dir: "flat", tone: "flat", text: "No change" });
    expect(trend(99.96, 100)).toEqual({ dir: "flat", tone: "flat", text: "No change" });
    expect(trend(100.06, 100).text).toBe("+0.1%");
    expect(trend(0.7361, 0.7358, { kind: "pts" })).toEqual({ dir: "flat", tone: "flat", text: "No change" });
    expect(trend(5, 5, { kind: "abs" }).text).toBe("No change");
  });

  it("every change carries its own sign, the minus a true minus (U+2212)", () => {
    expect(trend(0.74, 0.7, { kind: "pts" }).text).toBe("+4.0 pts");
    expect(trend(0.7, 0.74, { kind: "pts" }).text).toBe(`${M}4.0 pts`);
    expect(trend(80, 100).text.startsWith(M)).toBe(true);
    expect(trend(80, 100).text).not.toContain("-");
  });

  it("nothing to compare with (last month 0) is New, never an infinite percentage", () => {
    expect(trend(5000, 0)).toEqual({ dir: "up", tone: "good", text: "New" });
    expect(trend(0, 0)).toEqual({ dir: "flat", tone: "flat", text: "No change" });
    expect(trend(3, 0, { good: "down" })).toEqual({ dir: "up", tone: "bad", text: "New" });
    expect(trend(Number.NaN, 5)).toEqual({ dir: "flat", tone: "flat", text: "No change" });
  });

  it("abs changes can carry places and a format; 'vs' names what it's compared with", () => {
    expect(trend(1250, 1000, { kind: "abs", format: (n) => `₹${n.toLocaleString("en-IN")}` }).text).toBe(
      "+₹250",
    );
    expect(trend(2.25, 2, { kind: "abs", places: 1 }).text).toBe("+0.3");
    expect(trend(110, 100, { vs: "last month" }).text).toBe("+10.0% vs last month");
    expect(trend(100, 100, { vs: "last month" }).text).toBe("No change vs last month");
  });
});

describe("signed", () => {
  it("shows a value with its own sign, and no sign on zero", () => {
    expect(signed(43.94, 1)).toBe("+43.9");
    expect(signed(-12.36, 1)).toBe(`${M}12.4`);
    expect(signed(-0.04, 1)).toBe("0.0");
  });
});
