import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { newId } from "@lume/core";
import type { SyncTrigger, schema } from "@lume/db";

/** A transaction (or database) to run in; always call requestSync inside a transaction. */
export type TxLike = { execute: NodePgDatabase<typeof schema>["execute"] };

/**
 * Spec §5.1 and amendment A9. A sync for this source: a new one (fresh: the caller enqueues it after
 * commit), the one already under way (joined), or, with reuseWithinMs, one that finished moments ago.
 * Null when the source can't sync now (paused, needs attention, archived, not a sheet). The lock is
 * the source row itself, so two requests at once can never start two syncs.
 */
export async function requestSync(
  db: TxLike,
  o: { sourceId: string; trigger: SyncTrigger; requestedBy: string | null; reuseWithinMs?: number },
): Promise<{ syncId: string; fresh: boolean } | null> {
  if (o.reuseWithinMs) {
    const { rows } = await db.execute<{ id: string }>(sql`
      SELECT s.id FROM source_syncs s JOIN lead_sources l ON l.id = s.source_id
      WHERE s.source_id = ${o.sourceId} AND s.status = 'done' AND l.current_sync_id IS NULL
        AND s.finished_at > now() - make_interval(secs => ${o.reuseWithinMs / 1000})
      ORDER BY s.finished_at DESC LIMIT 1`);
    if (rows[0]) return { syncId: rows[0].id, fresh: false };
  }
  const id = newId();
  const { rows } = await db.execute<{ stale: string | null }>(sql`
    WITH old AS (SELECT id, current_sync_id FROM lead_sources WHERE id = ${o.sourceId} FOR UPDATE)
    UPDATE lead_sources l SET current_sync_id = ${id}, sync_lock_until = now() + interval '15 minutes'
    FROM old
    WHERE l.id = old.id AND l.type = 'google_sheet' AND l.status = 'active'
      AND (l.current_sync_id IS NULL OR l.sync_lock_until < now())
    RETURNING old.current_sync_id AS stale`);
  if (rows[0]) {
    // A sync whose lock ran out (its process died) is closed, so nothing waits on it for ever.
    if (rows[0].stale)
      await db.execute(
        sql`UPDATE source_syncs SET status = 'failed', error = 'stopped', finished_at = now() WHERE id = ${rows[0].stale} AND status IN ('queued', 'running')`,
      );
    await db.execute(
      sql`INSERT INTO source_syncs (id, source_id, trigger, requested_by, status) VALUES (${id}, ${o.sourceId}, ${o.trigger}, ${o.requestedBy}, 'queued')`,
    );
    return { syncId: id, fresh: true };
  }
  const { rows: current } = await db.execute<{ id: string | null }>(
    sql`SELECT current_sync_id AS id FROM lead_sources WHERE id = ${o.sourceId} AND type = 'google_sheet' AND status = 'active'`,
  );
  return current[0]?.id ? { syncId: current[0].id, fresh: false } : null;
}
