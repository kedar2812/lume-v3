import { describe, expect, it } from "vitest";
import { addDays, serverState, utcDay } from "./state";

const sub = (paidUntil: string) => ({ type: "subscription" as const, paidUntil, trialEnds: null });
const at = (day: string) => new Date(`${day}T12:00:00Z`);

describe("the licence's state, by type and date (spec §4.3)", () => {
  it("a subscription is active while paid until today or later", () => {
    expect(serverState(sub("2026-10-10"), at("2026-10-01"))).toEqual({ state: "active", reason: "paid" });
    expect(serverState(sub("2026-10-10"), at("2026-10-10"))).toEqual({ state: "active", reason: "paid" });
  });
  it("paid until yesterday is grace; seven days later is still grace; the eighth is read-only", () => {
    expect(serverState(sub("2026-10-10"), at("2026-10-11"))).toEqual({ state: "grace", reason: "overdue" });
    expect(serverState(sub("2026-10-10"), at("2026-10-17"))).toEqual({ state: "grace", reason: "overdue" });
    expect(serverState(sub("2026-10-10"), at("2026-10-18"))).toEqual({
      state: "read_only",
      reason: "overdue",
    });
  });
  it("the day turns at midnight UTC, as the instance counts grace", () => {
    expect(serverState(sub("2026-10-10"), new Date("2026-10-10T23:59:59Z")).state).toBe("active");
    expect(serverState(sub("2026-10-10"), new Date("2026-10-11T00:00:00Z")).state).toBe("grace");
  });
  it("a trial is active through its last day, then read-only", () => {
    const trial = { type: "trial" as const, paidUntil: null, trialEnds: "2026-10-15" };
    expect(serverState(trial, at("2026-10-15"))).toEqual({ state: "active", reason: "trial" });
    expect(serverState(trial, at("2026-10-16"))).toEqual({ state: "read_only", reason: "trial_ended" });
  });
  it("a perpetual licence is active, whatever the dates", () => {
    const p = { type: "perpetual" as const, paidUntil: "2020-01-01", trialEnds: null };
    expect(serverState(p, at("2030-01-01"))).toEqual({ state: "active", reason: "perpetual" });
  });
  it("suspended, or decommissioned, beats everything", () => {
    expect(serverState({ ...sub("2099-01-01"), suspended: true }, at("2026-10-01"))).toEqual({
      state: "suspended",
      reason: "suspended",
    });
    expect(
      serverState(
        { type: "perpetual", paidUntil: null, trialEnds: null, decommissioned: true },
        at("2026-10-01"),
      ),
    ).toEqual({ state: "suspended", reason: "suspended" });
  });
  it("a subscription never paid, or a trial with no end, is read-only rather than free", () => {
    expect(
      serverState({ type: "subscription", paidUntil: null, trialEnds: null }, at("2026-10-01")).state,
    ).toBe("read_only");
    expect(serverState({ type: "trial", paidUntil: null, trialEnds: null }, at("2026-10-01")).state).toBe(
      "read_only",
    );
  });
  it("days are UTC calendar days", () => {
    expect(utcDay(new Date("2026-10-10T23:59:59Z"))).toBe("2026-10-10");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
