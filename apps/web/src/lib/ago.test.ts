import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { agoWords, useAgo } from "./ago";

describe("how long ago", () => {
  it("in words", () => {
    const now = new Date("2026-10-05T10:00:00Z");
    expect(agoWords(null, now)).toBeNull();
    expect(agoWords("2026-10-05T09:59:30Z", now)).toBe("just now");
    expect(agoWords("2026-10-05T09:58:00Z", now)).toBe("2 min ago");
    expect(agoWords("2026-10-05T07:00:00Z", now)).toBe("3 h ago");
    expect(agoWords("2026-10-03T09:00:00Z", now)).toBe("2 d ago");
  });

  it("a newer time (a Refresh that just read the calendar) says just now at once", () => {
    const twoMinAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    const { result, rerender } = renderHook(({ iso }) => useAgo(iso), { initialProps: { iso: twoMinAgo } });
    expect(result.current).toBe("2 min ago");
    rerender({ iso: new Date().toISOString() });
    expect(result.current).toBe("just now");
  });
});
