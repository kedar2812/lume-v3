import { describe, expect, it } from "vitest";
import { checkRow, isCheckEmail, newExportCode, normaliseCode } from "./export-code";

/** A random source that walks through the given bytes, for repeatable codes. */
const bytes = (...xs: number[]) => {
  let i = 0;
  return (n: number) => Uint8Array.from({ length: n }, () => xs[i++ % xs.length]!);
};

describe("an export's code (6B)", () => {
  it("is XXXX-XXXX, from an alphabet without look-alikes", () => {
    for (let i = 0; i < 200; i++) {
      const c = newExportCode();
      expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(c).not.toMatch(/[01OIL]/);
    }
  });

  it("is made from the random bytes it's given", () => {
    expect(newExportCode(bytes(0, 1, 2, 3, 4, 5, 6, 7))).toBe(newExportCode(bytes(0, 1, 2, 3, 4, 5, 6, 7)));
  });

  it("is read back however it's typed: lower case, without the dash, with spaces", () => {
    expect(normaliseCode("px7q4mra")).toBe("PX7Q-4MRA");
    expect(normaliseCode(" PX7Q-4MRA ")).toBe("PX7Q-4MRA");
    expect(normaliseCode("px7q 4mra")).toBe("PX7Q-4MRA");
    expect(normaliseCode("PX7Q-4MR")).toBeNull();
    expect(normaliseCode("LX7Q-4MRA")).toBeNull(); // L is never in a code (a look-alike)
    expect(normaliseCode("")).toBeNull();
  });
});

describe("the check row (6B)", () => {
  it("is a made-up person who can never be reached", () => {
    for (let i = 0; i < 50; i++) {
      const r = checkRow();
      expect(r.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(r.email).toMatch(/^[a-z]+\.[a-z]+\.[0-9a-f]{6}@example\.invalid$/);
      expect(r.phone).toMatch(/^\+447700900\d{3}$/);
      expect(r.email.startsWith(`${r.name.split(" ")[0]!.toLowerCase()}.`)).toBe(true);
    }
  });

  it("is recognised by its email, and nothing else is", () => {
    expect(isCheckEmail(checkRow().email)).toBe(true);
    expect(isCheckEmail("DANA.REID.0a1b2c@EXAMPLE.INVALID")).toBe(true);
    expect(isCheckEmail("dana@example.com")).toBe(false);
    expect(isCheckEmail("x@invalid")).toBe(false);
    expect(isCheckEmail(null)).toBe(false);
  });
});
