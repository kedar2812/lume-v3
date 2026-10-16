import { describe, expect, it } from "vitest";
import { SentLog } from "./sent-log";

describe("SentLog", () => {
  it("lets ten through an hour, then says how long until the oldest leaves the window", () => {
    const log = new SentLog(10, 3_600_000);
    for (let i = 0; i < 10; i++) {
      expect(log.wait("p", i * 60_000)).toBe(0);
      log.record("p", i * 60_000);
    }
    expect(log.wait("p", 10 * 60_000)).toBe(50 * 60);
    expect(log.wait("someone-else", 10 * 60_000)).toBe(0);
    expect(log.wait("p", 3_600_000)).toBe(0); // the first has left the window
  });
  it("forgets people whose sends are all over an hour old", () => {
    const log = new SentLog(10, 3_600_000);
    log.record("a", 0);
    log.record("b", 0);
    log.wait("c", 2 * 3_600_000);
    expect(log.size).toBe(0);
  });
});
