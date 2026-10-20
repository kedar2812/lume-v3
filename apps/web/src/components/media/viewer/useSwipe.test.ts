import { describe, expect, it } from "vitest";
import { swipeOutcome } from "./useSwipe";

/** Where a swipe between files ends (apple-design §6): where it's headed, not where the finger let go. */
describe("a swipe between files", () => {
  const width = 400;
  const both = () => true;

  it("a quick short flick counts: it's thrown past half the width", () => {
    expect(swipeOutcome({ dx: -30, velocity: -900, width, canGo: both })).toBe("next");
    expect(swipeOutcome({ dx: 30, velocity: 900, width, canGo: both })).toBe("previous");
  });

  it("a slow drag under half the width springs back", () => {
    expect(swipeOutcome({ dx: -120, velocity: -60, width, canGo: both })).toBe("stay");
  });

  it("a slow drag past half the width goes", () => {
    expect(swipeOutcome({ dx: -230, velocity: -40, width, canGo: both })).toBe("next");
  });

  it("a flick back the other way cancels a long drag", () => {
    expect(swipeOutcome({ dx: -230, velocity: 900, width, canGo: both })).toBe("stay");
  });

  it("at the last file there's nowhere to go: it springs back", () => {
    expect(swipeOutcome({ dx: -300, velocity: -1500, width, canGo: (d) => d === "previous" })).toBe("stay");
  });
});
