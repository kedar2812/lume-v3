import type pg from "pg";

export type MaintenanceJobs = {
  purgeIdempotencyKeys(): Promise<number>;
  purgeImportFiles(): Promise<{ files: number; rows: number; drafts: number }>;
  purgeSheetSyncs(): Promise<{ syncs: number; refreshes: number; connects: number }>;
};

/** Housekeeping as lume_worker. Idempotency keys live 24 h (report §4.4). */
export function makeMaintenanceJobs(pool: pg.Pool, now: () => Date = () => new Date()): MaintenanceJobs {
  return {
    async purgeIdempotencyKeys() {
      const cutoff = new Date(now().getTime() - 24 * 3600_000);
      const r = await pool.query("DELETE FROM idempotency_keys WHERE created_at < $1", [cutoff]);
      return r.rowCount ?? 0;
    },

    /**
     * Spec §4.6: an import's file and raw rows go 30 days after it finishes; a draft never started goes
     * after 7 days (with its source and rows). Imports still queued or running are never touched. Only
     * the columns lume_worker is granted are read (0015_intake.sql): it never sees what it clears.
     */
    async purgeImportFiles() {
      const t = now();
      const finishedBefore = new Date(t.getTime() - 30 * 86_400_000);
      const draftBefore = new Date(t.getTime() - 7 * 86_400_000);
      const files = await pool.query<{ id: string }>(
        `UPDATE imports SET file_enc = NULL, purged_at = $2
         WHERE purged_at IS NULL AND status IN ('done', 'cancelled', 'stopped_access', 'failed') AND finished_at < $1
         RETURNING id`,
        [finishedBefore, t],
      );
      const ids = files.rows.map((r) => r.id);
      const rows = ids.length
        ? await pool.query("UPDATE import_rows SET raw_enc = NULL WHERE import_id = ANY($1)", [ids])
        : { rowCount: 0 };
      const drafts = await pool.query(
        "DELETE FROM lead_sources WHERE id IN (SELECT source_id FROM imports WHERE status = 'draft' AND created_at < $1)",
        [draftBefore],
      );
      return { files: files.rowCount ?? 0, rows: rows.rowCount ?? 0, drafts: drafts.rowCount ?? 0 };
    },

    /** 2B spec §4: sync history is kept 30 days, and a Refresh's record 1 day. Nothing else is touched. */
    async purgeSheetSyncs() {
      const t = now().getTime();
      const syncs = await pool.query("DELETE FROM source_syncs WHERE requested_at < $1", [
        new Date(t - 30 * 86_400_000),
      ]);
      const refreshes = await pool.query("DELETE FROM source_refreshes WHERE created_at < $1", [
        new Date(t - 86_400_000),
      ]);
      // A "Connect with Google" never finished (or finished and made its sheet) is kept a day at most.
      const connects = await pool.query("DELETE FROM oauth_connects WHERE created_at < $1", [
        new Date(t - 86_400_000),
      ]);
      return {
        syncs: syncs.rowCount ?? 0,
        refreshes: refreshes.rowCount ?? 0,
        connects: connects.rowCount ?? 0,
      };
    },
  };
}
