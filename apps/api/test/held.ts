import type pg from "pg";
import type { Harness } from "./harness";

/**
 * Rows another request is still writing: written in a transaction left open, so a request racing them blocks behind
 * it (on the same unique key, or a lock its foreign keys take) and must cope once they land. `commitOnceWaited`
 * commits only after a query is blocked behind exactly this transaction, so the race is the same every run.
 */
export async function heldOpen(h: Harness, userId: string, write: (c: pg.PoolClient) => Promise<unknown>) {
  const c = await h.ownerPool.connect();
  let open = true;
  const end = async (how: "COMMIT" | "ROLLBACK") => {
    if (!open) return;
    open = false;
    try {
      await c.query(how);
      c.release();
    } catch (e) {
      c.release(e as Error); // a broken connection is destroyed, never reused
      throw e;
    }
  };
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      userId,
    ]);
    await write(c);
    // pg_locks shows a transaction's id as a 32-bit xid.
    const xid = (
      await c.query<{ xid: string }>("SELECT (pg_current_xact_id()::text::bigint % 4294967296)::text AS xid")
    ).rows[0]!.xid;
    return {
      async commitOnceWaited(timeoutMs = 10_000) {
        try {
          const until = Date.now() + timeoutMs;
          for (;;) {
            const r = await h.ownerPool.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_locks
                WHERE NOT granted AND locktype = 'transactionid' AND transactionid::text = $1`,
              [xid],
            );
            if (r.rows[0]!.n > 0) break;
            if (Date.now() > until) throw new Error("nothing waited behind the held rows");
            await new Promise((ok) => setTimeout(ok, 20));
          }
        } catch (e) {
          await end("ROLLBACK");
          throw e;
        }
        await end("COMMIT");
      },
      rollback: () => end("ROLLBACK"),
    };
  } catch (e) {
    await end("ROLLBACK");
    throw e;
  }
}
