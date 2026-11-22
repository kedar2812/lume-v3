import { describe, expect, it } from "vitest";
import { foldKeyword, matchKeyword } from "./keywords";

/** Comment and DM keywords (NEW_FEATURES_PLAN §4.5): whole words, any script, case and accents ignored. */
describe("matchKeyword", () => {
  it("finds a whole word, any case", () => {
    expect(matchKeyword("What's the PRICE?", ["price"], "word")).toBe("price");
    expect(matchKeyword("guide please", ["GUIDE"], "word")).toBe("GUIDE");
  });

  it("never a word inside another word", () => {
    expect(matchKeyword("that's priceless", ["price"], "word")).toBeNull();
    expect(matchKeyword("guidelines", ["guide"], "word")).toBeNull();
  });

  it("ignores accents in Latin letters", () => {
    expect(matchKeyword("CAFE menu", ["café"], "word")).toBe("café");
    expect(matchKeyword("café menu", ["cafe"], "word")).toBe("cafe");
  });

  it("matches words in Devanagari and Arabic without merging different words", () => {
    expect(matchKeyword("मुझे प्राइस बताओ", ["प्राइस"], "word")).toBe("प्राइस");
    expect(matchKeyword("काम", ["कम"], "word")).toBeNull();
    expect(matchKeyword("أريد السعر من فضلك", ["السعر"], "word")).toBe("السعر");
  });

  it("matches several words as a phrase", () => {
    expect(matchKeyword("Can I get the free guide?", ["free guide"], "word")).toBe("free guide");
    expect(matchKeyword("free, then a guide", ["free guide"], "word")).toBeNull();
  });

  it("matches an emoji keyword anywhere", () => {
    expect(matchKeyword("love this 🔥🔥", ["🔥"], "word")).toBe("🔥");
    expect(matchKeyword("love this", ["🔥"], "word")).toBeNull();
  });

  it("exact mode needs the whole message", () => {
    expect(matchKeyword("  Guide! ", ["guide"], "exact")).toBe("guide");
    expect(matchKeyword("the guide", ["guide"], "exact")).toBeNull();
  });

  it("any mode matches every message with words", () => {
    expect(matchKeyword("hello", [], "any")).toBe("");
    expect(matchKeyword("   ", [], "any")).toBeNull();
    expect(matchKeyword(null, [], "any")).toBeNull();
  });

  it("nothing to match: no keywords, a blank keyword, blank text", () => {
    expect(matchKeyword("price", [], "word")).toBeNull();
    expect(matchKeyword("price", ["  "], "word")).toBeNull();
    expect(matchKeyword("   ", ["price"], "word")).toBeNull();
    expect(matchKeyword(null, ["price"], "word")).toBeNull();
  });

  it("returns the first keyword in the list's order that matches", () => {
    expect(matchKeyword("price and guide", ["guide", "price"], "word")).toBe("guide");
  });

  it("a hashtag keyword matches the word with or without its #", () => {
    expect(matchKeyword("#guide", ["guide"], "word")).toBe("guide");
    expect(matchKeyword("guide", ["#guide"], "word")).toBe("#guide");
  });
});

describe("foldKeyword", () => {
  it("is what two keywords are compared by (a duplicate check)", () => {
    expect(foldKeyword(" Café  Menu ")).toBe(foldKeyword("cafe menu"));
    expect(foldKeyword("कम")).not.toBe(foldKeyword("काम"));
  });
});
