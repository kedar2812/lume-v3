import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn((to: string) => {
  throw new Error(`redirect ${to}`);
});
vi.mock("next/navigation", () => ({ redirect }));

describe("Settings → Files (2026-10-20)", () => {
  it("moved to Media, in the sidebar: an old link or bookmark lands there", async () => {
    const { default: Page } = await import("./page");
    expect(() => Page()).toThrow("redirect /media");
    expect(redirect).toHaveBeenCalledWith("/media");
  });
});
