import { describe, expect, it } from "vitest";
import {
  parseTarget,
  periodLast,
  periodOf,
  periodWords,
  shiftPeriod,
  suggestions,
  targetText,
} from "./goal-periods";

describe("goal periods", () => {
  it("finds the month or quarter a day is in, and steps across years", () => {
    expect(periodOf("2026-10-05", "month")).toBe("2026-10-01");
    expect(periodOf("2026-11-30", "quarter")).toBe("2026-10-01");
    expect(shiftPeriod("2026-01-01", "month", -1)).toBe("2025-12-01");
    expect(shiftPeriod("2026-10-01", "quarter", 1)).toBe("2027-01-01");
    expect(shiftPeriod("2026-01-01", "quarter", -1)).toBe("2025-10-01");
    expect(periodLast("2026-02-01", "month")).toBe("2026-02-28");
    expect(periodLast("2026-10-01", "quarter")).toBe("2026-12-31");
  });

  it("names them", () => {
    expect(periodWords("2026-10-01", "month")).toEqual({ label: "October 2026", short: "Oct" });
    expect(periodWords("2026-07-01", "quarter")).toEqual({ label: "Q3 2026", short: "Q3" });
  });
});

describe("typing a target", () => {
  it("reads grouping and percents; empty or nonsense is no goal", () => {
    expect(parseTarget("62,00,000", "revenue")).toBe(6_200_000);
    expect(parseTarget("120", "won")).toBe(120);
    expect(parseTarget("90 %", "ontime")).toBe(0.9);
    expect(parseTarget("", "won")).toBeNull();
    expect(parseTarget("abc", "won")).toBeNull();
    expect(parseTarget("0", "won")).toBeNull();
    expect(parseTarget("-5", "won")).toBeNull();
    expect(parseTarget("120", "ontime")).toBeNull();
  });

  it("shows a saved target the way the currency reads", () => {
    expect(targetText(6_200_000, "revenue", "INR")).toBe("62,00,000");
    expect(targetText(6_200_000, "revenue", "AED")).toBe("6,200,000");
    expect(targetText(0.9, "ontime", "INR")).toBe("90");
    expect(targetText(null, "won", "INR")).toBe("");
  });

  it("suggests the period before as it was, and a tenth up", () => {
    expect(suggestions(112, "won")).toEqual({ same: 112, up: 123 });
    expect(suggestions(0.95, "ontime")).toEqual({ same: 0.95, up: 1 });
    expect(suggestions(0, "won")).toBeNull();
    expect(suggestions(null, "won")).toBeNull();
  });
});
