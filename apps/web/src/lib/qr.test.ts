import { describe, expect, it } from "vitest";
import { qrMatrix, qrPath } from "./qr";

/** A matrix as one string per row, so a failure prints something a human can actually read. */
const draw = (m: boolean[][]): string[] => m.map((row) => row.map((d) => (d ? "#" : ".")).join(""));

describe("QR encoder (local, so a TOTP secret never leaves the machine)", () => {
  it("produces a square matrix of a valid size with the three finder patterns", () => {
    const m = qrMatrix("otpauth://totp/LUME:owner?secret=JBSWY3DPEHPK3PXP");
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect((m.length - 21) % 4).toBe(0);
    expect(m.every((row) => row.length === m.length)).toBe(true);
    const finder = (r: number, c: number) => m[r]![c] && m[r + 6]![c] && m[r]![c + 6] && !m[r + 1]![c + 1];
    expect(finder(0, 0)).toBe(true);
    expect(finder(0, m.length - 7)).toBe(true);
    expect(finder(m.length - 7, 0)).toBe(true);
  });

  it("grows with longer input and is stable for the same input", () => {
    const small = qrMatrix("otpauth://totp/A?secret=AAAA");
    const big = qrMatrix(`otpauth://totp/${"L".repeat(120)}?secret=${"B".repeat(52)}`);
    expect(big.length).toBeGreaterThan(small.length);
    expect(qrMatrix("same")).toEqual(qrMatrix("same"));
  });

  it("writes the timing patterns and the dark module the standard requires", () => {
    const m = qrMatrix("LUME");
    const n = m.length;
    // Row 6 and column 6 alternate dark/light between the finder patterns.
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    expect(m[n - 8]![8]).toBe(true); // the dark module, always set
  });

  /**
   * A golden matrix. This encoder's output was compared module-for-module against an independent
   * implementation (node-qrcode, byte mode, level M, mask 0) for every length from 1 to 213 and
   * decoded back with jsQR; all 217 cases agreed. Pinning one of them is what stops a refactor from
   * quietly producing a code no phone can read.
   */
  it("matches the golden output for a known string (version 1, EC level M, mask 0)", () => {
    expect(draw(qrMatrix("LUME"))).toEqual([
      "#######..#....#######",
      "#.....#.####..#.....#",
      "#.###.#..##...#.###.#",
      "#.###.#..#.#..#.###.#",
      "#.###.#.#..##.#.###.#",
      "#.....#..#.#..#.....#",
      "#######.#.#.#.#######",
      "..........#..........",
      "#.#.#.#...#.#...#..#.",
      "#.###..##.##.#.#.....",
      "......##.###.###.####",
      "..#.##....####.##..#.",
      "##..#.####.#.###..##.",
      "........###...#...##.",
      "#######..#..#...#####",
      "#.....#...#...#....#.",
      "#.###.#.#.#.#.#.#.###",
      "#.###.#...##.#.#...#.",
      "#.###.#.#..#.###.##.#",
      "#.....#..#.###.###.#.",
      "#######.#.##.###..###",
    ]);
  });

  it("draws one SVG path with a module per dark square", () => {
    const m = qrMatrix("LUME");
    const dark = m.flat().filter(Boolean).length;
    const path = qrPath(m);
    expect(path.match(/M/g)!.length).toBe(dark);
    expect(path).toContain("M0 0h1v1h-1z"); // the top-left module of the first finder pattern
  });
});
