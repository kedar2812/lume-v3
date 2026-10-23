import type { WaNumberEvent } from "@lume/core";
import type pg from "pg";
import type { AppDeps } from "../../app";
import { adminIds, notify } from "../notifications/notify";
import { pauseRunsOnNumber } from "../autopilot/engine";
import { metaClient } from "./meta";
import { tokenContext } from "./service";

type Quality = "green" | "yellow" | "red";
/** A number is read again after a day (Task 6 reads one an LUME AI run uses every hour). */
export const HEALTH_STALE_MS = 24 * 3_600_000;
const RANK: Record<Quality, number> = { green: 0, yellow: 1, red: 2 };
const rank = (q: Quality | null) => (q ? RANK[q] : 0);
const TIER_NAME = /^TIER_[A-Z0-9]+$/;

/**
 * Keep a number's quality and tier (Autopilot spec 2026-10-19 §6). `undefined` leaves a value as it is. A drop to yellow
 * or red (or from yellow to red) tells the admins once, in words; from Task 6 it also pauses every LUME AI run on it.
 */
export async function onNumberHealth(
  pool: pg.Pool,
  numberId: string,
  h: { quality?: Quality | null; tier?: string | null },
  at: Date,
): Promise<void> {
  const before = (
    await pool.query<{ quality: Quality | null; display_phone: string }>(
      "SELECT quality, display_phone FROM whatsapp_numbers WHERE id = $1",
      [numberId],
    )
  ).rows[0];
  if (!before) return;
  await pool.query(
    `UPDATE whatsapp_numbers
        SET quality = CASE WHEN $2 THEN $3 ELSE quality END,
            messaging_tier = CASE WHEN $4 THEN $5 ELSE messaging_tier END,
            health_at = $6
      WHERE id = $1`,
    [numberId, h.quality !== undefined, h.quality ?? null, h.tier !== undefined, h.tier ?? null, at],
  );
  const now = h.quality === undefined ? before.quality : h.quality;
  if (now && now !== "green" && rank(now) > rank(before.quality)) {
    await pauseRunsOnNumber(pool, numberId, "quality");
    for (const id of await adminIds(pool))
      await notify(pool, id, {
        kind: "system_alert",
        title: `WhatsApp rated ${before.display_phone} ${now}`,
        body: "LUME paused LUME AI's runs on it to protect the number. Its quality recovers as people reply and fewer block it.",
      });
  }
}

/** Every connected number not read for `staleMs`, read from Meta now; one that can't be read is left for next time. */
export async function sweepNumberHealth(
  pool: pg.Pool,
  d: Pick<AppDeps, "meta" | "keyring" | "clock">,
  staleMs = HEALTH_STALE_MS,
  /** Only these numbers (the ones LUME AI's running runs use, read hourly); all connected ones when unset. */
  numberIds?: string[],
): Promise<void> {
  if (!d.meta) return;
  const now = d.clock();
  const { rows } = await pool.query<{ id: string; phone_number_id: string; token_enc: Buffer }>(
    `SELECT id, phone_number_id, token_enc FROM whatsapp_numbers
      WHERE status = 'active' AND token_enc IS NOT NULL AND (health_at IS NULL OR health_at < $1)
        AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
    [new Date(now.getTime() - staleMs), numberIds ?? null],
  );
  for (const n of rows) {
    const client = metaClient(d.meta, d.keyring.decrypt(n.token_enc, tokenContext(n.id)));
    const health = await client.numberHealth(n.phone_number_id).catch(() => null);
    if (health) await onNumberHealth(pool, n.id, health, now);
  }
}

/**
 * Meta's webhook for a number's quality and tier: the tier at once; a flag counts as a drop to at least yellow (the exact
 * colour is read on the next sweep, which a flag or unflag brings forward by marking the number unread).
 */
export async function applyNumberEvents(pool: pg.Pool, events: WaNumberEvent[], at: Date): Promise<void> {
  for (const ev of events) {
    const { rows } = await pool.query<{ id: string; quality: Quality | null }>(
      `SELECT id, quality FROM whatsapp_numbers
        WHERE waba_id = $1 AND regexp_replace(display_phone, '\\D', '', 'g') = $2 AND status <> 'disconnected'`,
      [ev.wabaId, ev.digits],
    );
    for (const n of rows) {
      const flagged = ev.event === "FLAGGED" && rank(n.quality) < RANK.yellow;
      await onNumberHealth(
        pool,
        n.id,
        // A tier name LUME doesn't know the shape of is left out (the next read from Meta sets it).
        {
          ...(flagged ? { quality: "yellow" as const } : {}),
          ...(ev.tier && TIER_NAME.test(ev.tier) ? { tier: ev.tier } : {}),
        },
        at,
      );
      if (ev.event === "FLAGGED" || ev.event === "UNFLAGGED")
        await pool.query("UPDATE whatsapp_numbers SET health_at = NULL WHERE id = $1", [n.id]);
    }
  }
}
