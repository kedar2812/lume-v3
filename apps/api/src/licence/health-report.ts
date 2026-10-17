import { statfs } from "node:fs/promises";
import { capHealth, HEALTH_PROBLEMS, type FleetHealth, type HealthProblem, type PlanModule } from "@lume/core";
import type pg from "pg";
import { readHealth, type Health } from "../modules/health/service";
import { modulesOn } from "./plan";

const H = 3_600_000;
const KNOWN = new Set<string>(HEALTH_PROBLEMS);

/**
 * What this LUME tells its licence server about itself with each check-in (spec 2026-10-16 fleet §1.1): System
 * health's own reading as counts and fixed keys. A source's problem travels as "source", never its name.
 */
export function toFleetHealth(
  h: Health,
  o: {
    uptimeS: number;
    dbBytes: number;
    diskFreePct: number | null;
    errors24h: number;
    modulesOn?: PlanModule[];
  },
): FleetHealth {
  const keys = h.problems
    .map((p) => (p.key.startsWith("source:") ? "source" : p.key))
    .filter((k) => KNOWN.has(k));
  return capHealth({
    uptimeS: o.uptimeS,
    dbBytes: o.dbBytes,
    diskFreePct: o.diskFreePct,
    errors24h: o.errors24h,
    queue: { waiting: h.queue.waiting, retrying: h.queue.retrying, failed24h: h.queue.failed24h },
    remindersLate: h.followUps.late,
    restoreTest:
      h.restoreTest.at && h.restoreTest.ok !== null ? { at: h.restoreTest.at, ok: h.restoreTest.ok } : null,
    problems: keys as HealthProblem[],
    sourcesNeedingAttention: h.problems.filter((p) => p.key.startsWith("source:")).length,
    ...(o.modulesOn ? { modulesOn: o.modulesOn } : {}),
  });
}

/** Free space on the disk LUME runs on, 0–100, or null when the system won't say. */
async function diskFree(): Promise<number | null> {
  try {
    const s = await statfs("/");
    return s.blocks > 0 ? Math.round((Number(s.bavail) / Number(s.blocks)) * 100) : null;
  } catch {
    return null;
  }
}

/** This LUME's health now, or null when it can't be read: the check-in then goes without it. Never throws. */
export async function healthReport(
  db: Pick<pg.Pool, "query">,
  o: {
    now: Date;
    startedAt: Date;
    errors24h: number;
    lastSweepAt?: () => Date | null;
    queueStartedAt?: Date;
    disk?: () => Promise<number | null>;
  },
): Promise<FleetHealth | null> {
  try {
    const h = await readHealth(db, {
      now: o.now,
      ...(o.lastSweepAt ? { lastSweepAt: o.lastSweepAt } : {}),
      ...(o.queueStartedAt ? { startedAt: o.queueStartedAt } : {}),
    });
    const size = (await db.query<{ n: string }>("SELECT pg_database_size(current_database())::text AS n"))
      .rows[0];
    return toFleetHealth(h, {
      uptimeS: (o.now.getTime() - o.startedAt.getTime()) / 1000,
      dbBytes: Number(size?.n ?? 0),
      diskFreePct: await (o.disk ?? diskFree)(),
      errors24h: o.errors24h,
      // Control each client (spec 2026-10-17 control §1): which plan modules are on, keys only.
      modulesOn: await modulesOn(db),
    });
  } catch {
    return null;
  }
}

/** Server errors (5xx) LUME's API answered in the last 24 hours, in hour buckets, in memory. */
export class ErrorWindow {
  private readonly hours = new Map<number, number>();
  add(at: Date): void {
    const k = Math.floor(at.getTime() / H);
    this.hours.set(k, (this.hours.get(k) ?? 0) + 1);
    for (const old of this.hours.keys()) if (old < k - 48) this.hours.delete(old);
  }
  count(now: Date): number {
    const from = now.getTime() - 24 * H;
    let n = 0;
    for (const [k, c] of this.hours) if ((k + 1) * H > from && k * H <= now.getTime()) n += c;
    return n;
  }
}
