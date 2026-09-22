import type pg from "pg";

export type MaintenanceJobs = { purgeIdempotencyKeys(): Promise<number> };

/** Housekeeping as lume_worker. Idempotency keys live 24 h (report §4.4). */
export function makeMaintenanceJobs(pool: pg.Pool, now: () => Date = () => new Date()): MaintenanceJobs {
  return {
    async purgeIdempotencyKeys() {
      const cutoff = new Date(now().getTime() - 24 * 3600_000);
      const r = await pool.query("DELETE FROM idempotency_keys WHERE created_at < $1", [cutoff]);
      return r.rowCount ?? 0;
    },
  };
}
