import { eq, inArray } from "drizzle-orm";
import { sha256Hex } from "@lume/core";
import { schema } from "@lume/db";
import type { Db } from "../db/context";

export const THROTTLE = {
  windowMs: 15 * 60_000,
  accountLockAfter: 10,
  ipLockAfter: 50,
  lockMs: 15 * 60_000,
  freeFailures: 2,
  maxDelayS: 30,
} as const;
export type ThrottleState = {
  failures: number;
  windowStartedAt: Date;
  nextAllowedAt: Date | null;
  lockedUntil: Date | null;
  lockouts: number;
};

export const accountKey = (email: string) => `acct:${sha256Hex(email.trim().toLowerCase())}`;
export const ipKey = (ip: string) => `ip:${ip}`;

export function nextOnFailure(s: ThrottleState, now: Date, lockAfter: number): ThrottleState {
  const expired = now.getTime() - s.windowStartedAt.getTime() > THROTTLE.windowMs;
  const failures = (expired ? 0 : s.failures) + 1;
  const windowStartedAt = expired ? now : s.windowStartedAt;
  if (failures >= lockAfter) {
    return {
      failures: 0,
      windowStartedAt: now,
      nextAllowedAt: null,
      lockedUntil: new Date(now.getTime() + THROTTLE.lockMs),
      lockouts: s.lockouts + 1,
    };
  }
  const over = failures - THROTTLE.freeFailures;
  const delayS = over > 0 ? Math.min(THROTTLE.maxDelayS, 2 ** (over - 1)) : 0;
  return {
    failures,
    windowStartedAt,
    nextAllowedAt: delayS ? new Date(now.getTime() + delayS * 1000) : null,
    lockedUntil: s.lockedUntil,
    lockouts: s.lockouts,
  };
}

export function verdict(
  s: ThrottleState,
  now: Date,
): { allowed: true } | { allowed: false; retryAfterSec: number; locked: boolean } {
  if (s.lockedUntil && s.lockedUntil > now)
    return {
      allowed: false,
      retryAfterSec: Math.ceil((s.lockedUntil.getTime() - now.getTime()) / 1000),
      locked: true,
    };
  if (s.nextAllowedAt && s.nextAllowedAt > now)
    return {
      allowed: false,
      retryAfterSec: Math.ceil((s.nextAllowedAt.getTime() - now.getTime()) / 1000),
      locked: false,
    };
  return { allowed: true };
}

export async function checkThrottle(db: Db, keys: string[], now: Date) {
  const rows = await db.select().from(schema.authThrottle).where(inArray(schema.authThrottle.key, keys));
  for (const r of rows) {
    const v = verdict(r, now);
    if (!v.allowed) return v;
  }
  return { allowed: true } as const;
}

export async function recordFailure(
  db: Db,
  key: string,
  lockAfter: number,
  now: Date,
): Promise<{ lockedNow: boolean; lockouts: number }> {
  // Row lock so concurrent failures can't both read the same count.
  await db.insert(schema.authThrottle).values({ key, windowStartedAt: now }).onConflictDoNothing();
  const [cur] = await db
    .select()
    .from(schema.authThrottle)
    .where(eq(schema.authThrottle.key, key))
    .for("update");
  const next = nextOnFailure(cur!, now, lockAfter);
  await db.update(schema.authThrottle).set(next).where(eq(schema.authThrottle.key, key));
  return { lockedNow: next.lockouts > cur!.lockouts, lockouts: next.lockouts };
}

export async function clearThrottle(db: Db, key: string, now: Date): Promise<void> {
  await db
    .update(schema.authThrottle)
    .set({ failures: 0, nextAllowedAt: null, windowStartedAt: now })
    .where(eq(schema.authThrottle.key, key));
}
