import { describe, expect, it } from "vitest";
import { firstNameOf } from "./first-name";

describe("a person's first name, as a message greets them", () => {
  it("the first word, usually", () => {
    expect(firstNameOf("Ananya Rao")).toBe("Ananya");
    expect(firstNameOf("  ravi  ")).toBe("ravi");
  });
  it("a title in front isn't a first name", () => {
    expect(firstNameOf("Dr. Ananya Rao")).toBe("Ananya");
    expect(firstNameOf("Smt Lakshmi Iyer")).toBe("Lakshmi");
    expect(firstNameOf("Mrs. Kapoor Maya")).toBe("Kapoor");
  });
  it("a title with only a surname stays together: Hi Mr Rao, not Hi Mr", () => {
    expect(firstNameOf("Mr Rao")).toBe("Mr Rao");
    expect(firstNameOf("Dr. Mehta")).toBe("Dr. Mehta");
  });
  it("no word with a letter (a phone number, an emoji) is no first name", () => {
    expect(firstNameOf("+971 50 111 2233")).toBe("");
    expect(firstNameOf("😀 Ananya")).toBe("Ananya");
    expect(firstNameOf("")).toBe("");
  });
});
