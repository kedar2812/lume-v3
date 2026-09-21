import { describe, expect, it } from "vitest";
import { THEME_COOKIE, parseThemePref, themeCookie } from "./theme";

describe("theme preference", () => {
  it("defaults to system and rejects unknown values", () => {
    expect(parseThemePref(undefined)).toBe("system");
    expect(parseThemePref("neon")).toBe("system");
    expect(parseThemePref("obsidian")).toBe("obsidian");
  });
  it("writes a long-lived, lax, path-wide cookie", () => {
    const c = themeCookie("porcelain");
    expect(c.startsWith(`${THEME_COOKIE}=porcelain;`)).toBe(true);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Max-Age=31536000/);
  });
});
