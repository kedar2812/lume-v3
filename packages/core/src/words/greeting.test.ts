import { describe, expect, it } from "vitest";
import { greetingAt } from "./greeting";

describe("Today's greeting, by the hour on the person's clock", () => {
  it("morning from 5, afternoon from noon, evening from 5 pm — and still evening in the small hours", () => {
    expect([0, 1, 4].map(greetingAt)).toEqual(["Good evening", "Good evening", "Good evening"]);
    expect([5, 11].map(greetingAt)).toEqual(["Good morning", "Good morning"]);
    expect([12, 16].map(greetingAt)).toEqual(["Good afternoon", "Good afternoon"]);
    expect([17, 23].map(greetingAt)).toEqual(["Good evening", "Good evening"]);
  });
});
