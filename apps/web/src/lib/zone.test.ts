import { describe, expect, it } from "vitest";
import { zoneOf } from "./zone";

describe("the zone a person's day runs on", () => {
  it("the session's zone (own, else the business's) wins over the raw setting and the browser", () => {
    expect(zoneOf({ zone: "Asia/Kolkata", timezone: null })).toBe("Asia/Kolkata");
    expect(zoneOf({ zone: "Europe/London", timezone: "Europe/London" })).toBe("Europe/London");
  });
  it("an older API without it: their own, then the browser's", () => {
    expect(zoneOf({ timezone: "Asia/Dubai" })).toBe("Asia/Dubai");
    expect(zoneOf({ timezone: null })).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
