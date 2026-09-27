import { describe, expect, it } from "vitest";
import { ago, inFuture } from "./format";

const now = Date.parse("2026-09-27T10:00:00Z");
describe("relative times", () => {
  it("says how long ago, in words people use", () => {
    expect(ago("2026-09-27T09:59:40Z", now)).toBe("just now");
    expect(ago("2026-09-27T09:58:00Z", now)).toBe("2 min ago");
    expect(ago("2026-09-27T07:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-09-25T10:00:00Z", now)).toBe("2 days ago");
  });
  it("says how soon", () => {
    expect(inFuture("2026-09-27T10:00:20Z", now)).toBe("in a moment");
    expect(inFuture("2026-09-27T10:02:00Z", now)).toBe("in 2 min");
    expect(inFuture("2026-09-27T09:00:00Z", now)).toBe("in a moment"); // overdue: it's about to happen
  });
});
