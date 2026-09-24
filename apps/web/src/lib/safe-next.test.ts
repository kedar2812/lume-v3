import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps plain in-app paths", () => {
    expect(safeNext("/leads")).toBe("/leads");
    expect(safeNext("/settings/people")).toBe("/settings/people");
  });

  it("falls back to Today for anything that could leave the app", () => {
    for (const bad of [
      undefined,
      "",
      "https://evil.example",
      "//evil",
      "//evil.example/x",
      "/\\evil", // "/\evil": browsers read a backslash like a slash here
      "leads",
      "/leads?x=1",
      "/javascript:alert(1)",
    ])
      expect(safeNext(bad)).toBe("/today");
  });
});
