import { describe, expect, it } from "vitest";
import { contrastRatio, parseHex } from "./contrast";

describe("contrast", () => {
  it("parses 3- and 6-digit hex", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("#2A5BFF")).toEqual([42, 91, 255]);
  });
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 1);
  });
});
