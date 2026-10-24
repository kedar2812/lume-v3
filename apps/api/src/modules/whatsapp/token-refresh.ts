import type pg from "pg";
import type { AppDeps } from "../../app";
import { tokenContext } from "./service";

/** Meta's Embedded Signup tokens last 60 days; LUME refreshes one at 30, so a month of hourly tries is left. */
export const TOKEN_REFRESH_MS = 30 * 86_400_000;
const RECONNECT = "WhatsApp stopped letting LUME in. Connect this number again.";

/** A fresh token for this one; "revoked" when Meta refuses it; null when it couldn't be asked (tried again later). */
export type TokenRefresh = (token: string) => Promise<{ token: string } | "revoked" | null>;

/** Through the relay, which holds the app secret Meta's refresh needs (apps/connect `/wa/refresh`). */
export const relayTokenRefresh =
  (relay: { relayUrl: string; relayToken: string }): TokenRefresh =>
  async (token) => {
    const r = await fetch(`${relay.relayUrl}/wa/refresh`, {
      method: "POST",
      headers: { authorization: `Bearer ${relay.relayToken}`, "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    const b = ((await r?.json().catch(() => ({}))) ?? {}) as { token?: unknown; error?: unknown };
    if (r?.status === 400 && b.error === "revoked") return "revoked";
    return r?.ok && typeof b.token === "string" && b.token ? { token: b.token } : null;
  };

/**
 * Every connected number whose token is 30 days old (or connected that long ago, from before LUME kept its age),
 * refreshed. The new token is kept only if the number still has the token that was refreshed: a number connected
 * again meanwhile keeps its new connection's.
 */
export async function sweepWhatsAppTokens(
  pool: pg.Pool,
  d: Pick<AppDeps, "keyring" | "clock">,
  refresh: TokenRefresh,
  ageMs = TOKEN_REFRESH_MS,
): Promise<void> {
  const now = d.clock();
  const { rows } = await pool.query<{ id: string; token_enc: Buffer }>(
    `SELECT id, token_enc FROM whatsapp_numbers
      WHERE status = 'active' AND token_enc IS NOT NULL AND COALESCE(token_at, connected_at) <= $1`,
    [new Date(now.getTime() - ageMs)],
  );
  for (const n of rows) {
    const got = await refresh(d.keyring.decrypt(n.token_enc, tokenContext(n.id))).catch(() => null);
    if (got === "revoked")
      await pool.query(
        `UPDATE whatsapp_numbers SET status = 'needs_attention', problem = $3, updated_at = now()
          WHERE id = $1 AND status = 'active' AND token_enc = $2`,
        [n.id, n.token_enc, RECONNECT],
      );
    else if (got)
      await pool.query(
        `UPDATE whatsapp_numbers SET token_enc = $3, token_at = $4, updated_at = now()
          WHERE id = $1 AND status = 'active' AND token_enc = $2`,
        [n.id, n.token_enc, d.keyring.encrypt(got.token, tokenContext(n.id)), now],
      );
  }
}
