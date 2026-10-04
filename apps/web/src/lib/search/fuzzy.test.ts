import { describe, expect, it } from "vitest";
import { fuzzyRank, fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("finds words by their start, anywhere in the text or its keywords", () => {
    expect(fuzzyScore("time", "Timezone")).not.toBeNull();
    expect(fuzzyScore("zone", "Business", ["timezone", "currency"])).not.toBeNull();
    expect(fuzzyScore("two step", "Two-step sign-in")).not.toBeNull();
  });

  it("forgives a slip of the finger: one wrong, missing or swapped letter", () => {
    expect(fuzzyScore("curency", "Currency")).not.toBeNull();
    expect(fuzzyScore("abuot", "About")).not.toBeNull();
    expect(fuzzyScore("watermrk", "On-screen watermark")).not.toBeNull();
  });

  it("reads initials and run-together letters", () => {
    expect(fuzzyScore("wh", "Working hours")).not.toBeNull();
    expect(fuzzyScore("lostreason", "Lost reasons")).not.toBeNull();
  });

  it("refuses what isn't there, and short guesses aren't stretched into typos", () => {
    expect(fuzzyScore("zebra", "Business")).toBeNull();
    expect(fuzzyScore("xy", "Pipeline & stages")).toBeNull();
  });

  it("ignores accents, case and punctuation", () => {
    expect(fuzzyScore("CAFE", "Café tags")).not.toBeNull();
    expect(fuzzyScore("sign in", "Sign-in hours")).not.toBeNull();
  });
});

describe("fuzzyRank", () => {
  const items = [
    { label: "About LUME", keywords: ["version", "licence"] },
    { label: "Audit log", keywords: ["history"] },
    { label: "Lost reasons", keywords: [] },
    { label: "Business", keywords: ["about your business"] },
  ];
  it("puts a title that starts with the words first, then a word start, then keywords", () => {
    expect(fuzzyRank("abo", items, (i) => i).map((x) => x.label)).toEqual(["About LUME", "Business"]);
    expect(fuzzyRank("licence", items, (i) => i).map((x) => x.label)).toEqual(["About LUME"]);
  });
  it("an empty search ranks nothing", () => {
    expect(fuzzyRank("  ", items, (i) => i)).toEqual([]);
  });
});
