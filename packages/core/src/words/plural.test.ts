import { describe, expect, it } from "vitest";
import { plural } from "./plural";

describe("plural: a count and its noun, in agreement", () => {
  it("one is singular; zero and many are plural; regular nouns take an s", () => {
    expect(plural(1, "lead")).toBe("1 lead");
    expect(plural(0, "lead")).toBe("0 leads");
    expect(plural(2, "day")).toBe("2 days");
  });
  it("irregular nouns are given their plural", () => {
    expect(plural(1, "person", "people")).toBe("1 person");
    expect(plural(5, "person", "people")).toBe("5 people");
  });
  it("big numbers are grouped, and the noun follows the number, not its display", () => {
    expect(plural(12345, "row")).toBe("12,345 rows");
    expect(plural(1, "row")).toBe("1 row");
  });
});
