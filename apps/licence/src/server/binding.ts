import { timingSafeEqual } from "node:crypto";
import type { LicenceType } from "@lume/core";
import type pg from "pg";
import { hashKey } from "@/lib/keys";

/** A live licence found by its key, locked for this transaction (spec 2026-10-15 §2). */
export type KeyedLicence = {
  kind: "live";
  client_id: string;
  instance_id: string;
  type: LicenceType;
  paid_until: string | null;
  trial_ends: string | null;
  suspended: boolean;
  decommissioned: boolean;
  install_id: string | null;
  activated_at: Date | null;
  released_at: Date | null;
};
/** A key that was rotated away or decommissioned: it never works again anywhere. */
export type RetiredKey = {
  kind: "retired";
  client_id: string;
  reason: "rotated" | "decommissioned";
  retired_at: Date;
  install_id: string | null;
};

/**
 * The licence behind a key, however it was typed: a live one (row-locked, so two activations of the same key
 * queue rather than both binding), else a retired one, else null.
 */
export async function findByKey(c: pg.PoolClient, key: string): Promise<KeyedLicence | RetiredKey | null> {
  const hash = hashKey(key);
  const live = (
    await c.query<Omit<KeyedLicence, "kind"> & { key_hash: Buffer }>(
      `SELECT l.client_id, l.instance_id, l.type, l.key_hash,
              to_char(l.paid_until, 'YYYY-MM-DD') AS paid_until, to_char(l.trial_ends, 'YYYY-MM-DD') AS trial_ends,
              l.suspended_at IS NOT NULL AS suspended, c.decommissioned_at IS NOT NULL AS decommissioned,
              l.install_id, l.activated_at, l.released_at
         FROM licences l JOIN clients c ON c.id = l.client_id
        WHERE l.key_hash = $1
          FOR UPDATE OF l`,
      [hash],
    )
  ).rows[0];
  // The index found it by hash; compare in constant time all the same.
  if (live && timingSafeEqual(live.key_hash, hash)) {
    const { key_hash: _hash, ...rest } = live;
    void _hash;
    return { kind: "live", ...rest };
  }
  const retired = (
    await c.query<Omit<RetiredKey, "kind">>(
      "SELECT client_id, reason, retired_at, install_id FROM retired_keys WHERE key_hash = $1",
      [hash],
    )
  ).rows[0];
  return retired ? { kind: "retired", ...retired } : null;
}

/** Which way an activation goes for this licence and this install (spec §2.1, §2.4). */
export function bindOutcome(l: { install_id: string | null }, installId: string): "bind" | "same" | "other" {
  if (!l.install_id) return "bind";
  return l.install_id === installId ? "same" : "other";
}
