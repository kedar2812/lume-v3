import { describe, expect, it } from "vitest";
import { initialsOf } from "./initials";

describe("initials, for any name a person can have", () => {
  it("first and last name; one name gives its first two letters", () => {
    expect(initialsOf("Ananya Rao")).toBe("AR");
    expect(initialsOf("Ananya Mehta Rao")).toBe("AR");
    expect(initialsOf("ravi")).toBe("RA");
  });
  it("never splits an emoji into a broken character; skips words with no letter", () => {
    expect(initialsOf("😀 Ananya Rao")).toBe("AR");
    expect(initialsOf("Ananya 😀")).toBe("AN");
    expect(initialsOf("👨‍👩‍👧")).toBe("?");
  });
  it("skips punctuation in front of a word", () => {
    expect(initialsOf("(Ravi) Kumar")).toBe("RK");
    expect(initialsOf("  ")).toBe("?");
  });
  it("keeps an Indic letter whole, vowel sign and all", () => {
    expect(initialsOf("राहुल शर्मा")).toBe("राश");
  });
  it("a lead known only by a number gets digits, not symbols", () => {
    expect(initialsOf("+971 50 123 4567")).toBe("94");
  });
});
