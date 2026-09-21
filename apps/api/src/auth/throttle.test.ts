import { describe, expect, it } from "vitest";
import { THROTTLE, accountKey, nextOnFailure, verdict, type ThrottleState } from "./throttle";

const t0 = new Date("2026-09-21T09:00:00Z");
const plus = (ms: number) => new Date(t0.getTime() + ms);
const fresh = (): ThrottleState => ({
  failures: 0,
  windowStartedAt: t0,
  nextAllowedAt: null,
  lockedUntil: null,
  lockouts: 0,
});

describe("login throttle (report §12.1: progressive delay, 15-min lockout after 10)", () => {
  it("lets the first two failures through freely, then delays 1, 2, 4 … s (capped at 30)", () => {
    let s = fresh();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      s = nextOnFailure(s, t0, THROTTLE.accountLockAfter);
      delays.push(s.nextAllowedAt ? (s.nextAllowedAt.getTime() - t0.getTime()) / 1000 : 0);
    }
    expect(delays).toEqual([0, 0, 1, 2, 4, 8, 16, 30, 30]);
  });

  it("locks for 15 minutes at the 10th failure, then allows again", () => {
    let s = fresh();
    for (let i = 0; i < 10; i++) s = nextOnFailure(s, t0, THROTTLE.accountLockAfter);
    expect(s.lockedUntil?.getTime()).toBe(plus(THROTTLE.lockMs).getTime());
    expect(s.lockouts).toBe(1);
    expect(verdict(s, plus(60_000))).toEqual({ allowed: false, retryAfterSec: 840, locked: true });
    expect(verdict(s, plus(THROTTLE.lockMs + 1))).toEqual({ allowed: true });
  });

  it("forgets failures once the window has passed", () => {
    let s = fresh();
    for (let i = 0; i < 5; i++) s = nextOnFailure(s, t0, THROTTLE.accountLockAfter);
    s = nextOnFailure(s, plus(THROTTLE.windowMs + 1), THROTTLE.accountLockAfter);
    expect(s.failures).toBe(1);
  });

  it("keys accounts by a hash of the normalised email (unknown emails throttle identically)", () => {
    expect(accountKey(" Tasneem@Nupuur.com ")).toBe(accountKey("tasneem@nupuur.com"));
    expect(accountKey("x@y.z")).toMatch(/^acct:[0-9a-f]{64}$/);
  });
});
