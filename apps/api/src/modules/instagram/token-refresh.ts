import type pg from "pg";
import type { AppDeps } from "../../app";
import { igGraph, type IgGraphConfig } from "./graph";
import { igTokenContext, tellAdmins } from "./service";

/** Instagram's long-lived tokens last 60 days; LUME refreshes one at 30, so a month of daily tries is left. */
export const IG_TOKEN_REFRESH_MS = 30 * 86_400_000;
const RECONNECT = "Instagram stopped letting LUME in. Connect this account again.";

/**
 * Every connected account whose token is 30 days old, refreshed straight with Meta (an Instagram refresh needs no app
 * secret). The new token is kept only if the account still has the token that was refreshed: one connected again
 * meanwhile keeps its new connection's. Meta refusing it (190) puts the account in "needs attention" and tells the
 * admins once; Meta down leaves it for the next run.
 */
export async function sweepInstagramTokens(
  pool: pg.Pool,
  d: Pick<AppDeps, "keyring" | "clock"> & { graph: IgGraphConfig },
  ageMs = IG_TOKEN_REFRESH_MS,
): Promise<{ refreshed: number; revoked: number }> {
  const now = d.clock();
  const { rows } = await pool.query<{ id: string; token_enc: Buffer; username: string }>(
    `SELECT id, token_enc, username FROM instagram_accounts
      WHERE status = 'active' AND token_enc IS NOT NULL AND COALESCE(token_at, connected_at) <= $1`,
    [new Date(now.getTime() - ageMs)],
  );
  let refreshed = 0;
  let revoked = 0;
  for (const a of rows) {
    const r = await igGraph(d.graph, d.keyring.decrypt(a.token_enc, igTokenContext(a.id))).refresh();
    const code = (r.data.error as { code?: unknown } | undefined)?.code;
    const token = typeof r.data.access_token === "string" ? r.data.access_token : "";
    if (r.ok && token) {
      const u = await pool.query(
        `UPDATE instagram_accounts SET token_enc = $3, token_at = $4, updated_at = now()
          WHERE id = $1 AND status = 'active' AND token_enc = $2`,
        [a.id, a.token_enc, d.keyring.encrypt(token, igTokenContext(a.id)), now],
      );
      refreshed += u.rowCount ?? 0;
    } else if (code === 190) {
      const u = await pool.query(
        `UPDATE instagram_accounts SET status = 'needs_attention', problem = $3, updated_at = now()
          WHERE id = $1 AND status = 'active' AND token_enc = $2`,
        [a.id, a.token_enc, RECONNECT],
      );
      if (u.rowCount) {
        revoked++;
        await tellAdmins(pool, `Instagram @${a.username} needs connecting again`, RECONNECT);
      }
    }
  }
  return { refreshed, revoked };
}

/**
 * A token Meta refused while sending (190): the account needs connecting again, and the admins hear once. Answers
 * whether this call made the change.
 */
export async function tokenRefused(pool: pg.Pool, accountId: string): Promise<boolean> {
  const { rows } = await pool.query<{ username: string }>(
    `UPDATE instagram_accounts SET status = 'needs_attention', problem = $2, updated_at = now()
      WHERE id = $1 AND status = 'active' RETURNING username`,
    [accountId, RECONNECT],
  );
  if (!rows[0]) return false;
  await tellAdmins(pool, `Instagram @${rows[0].username} needs connecting again`, RECONNECT);
  return true;
}
