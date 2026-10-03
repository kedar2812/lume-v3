import { describe, expect, it } from "vitest";
import { searchMode } from "./search-mode";

describe("what a search will look at (7C, the API's rules from 7A)", () => {
  it("nothing typed is no search", () => {
    expect(searchMode("", true)).toBeNull();
    expect(searchMode("   ", true)).toBeNull();
  });
  it("one character, or symbols only, doesn't search yet, and says why", () => {
    expect(searchMode("m", true)).toMatchObject({ label: "One more letter", tone: "wait", searches: false });
    expect(searchMode("@@", true)).toMatchObject({
      label: "Letters or numbers",
      tone: "wait",
      searches: false,
    });
    expect(searchMode("🌹", true)).toMatchObject({ searches: false });
  });
  it("two characters match names that start with them", () => {
    expect(searchMode("ma", true)).toMatchObject({
      label: "Names starting with",
      tone: "prefix",
      searches: true,
    });
  });
  it("three or more look inside names, and the contacts this person may see", () => {
    expect(searchMode("mar", true)).toMatchObject({ label: "Names, emails, numbers", tone: "inside" });
    expect(searchMode("mar", false)).toMatchObject({ label: "Names only", tone: "names" });
  });
});
