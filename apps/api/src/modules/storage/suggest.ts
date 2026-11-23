import type pg from "pg";
import { DEFAULT_CLOSED_MONTHS, DEFAULT_WARN_AT, storageSize, WARN_AT } from "@lume/core";
import { usedShare, type FilesDeps } from "../whatsapp/files";
import { adminIds, notify } from "../notifications/notify";
import { survey } from "./survey";

/** The kinds Clean up ticks unless asked: what a suggestion counts as room to give back. */
const SUGGESTED = ["closed", "trash", "previews"] as const;
const DAY_MS = 86_400_000;

/**
 * Hourly (plan 2026-11-23-storage-clean-up, Task 3): past the admins' mark (80% unless they chose 70 or 90), with room
 * to give back, each admin hears once a day how full the disk is and how much LUME can clear. Answers whether it told.
 */
export async function suggestStorage(
  pool: pg.Pool,
  files: FilesDeps | undefined,
  now: Date,
): Promise<boolean> {
  if (!files) return false;
  const disk = await files.disk().catch(() => null);
  if (!disk) return false;
  const set = await pool.query<{ warn: unknown; told: string | null }>(
    `SELECT integrations -> 'storage' -> 'warnAtPct' AS warn, integrations -> 'storage' ->> 'toldAt' AS told
       FROM settings WHERE id = 1`,
  );
  const warn = Number(set.rows[0]?.warn);
  const mark = (WARN_AT as readonly number[]).includes(warn) ? warn : DEFAULT_WARN_AT;
  const used = Math.round(usedShare(disk) * 100);
  if (used < mark) return false;
  const told = set.rows[0]?.told ? Date.parse(set.rows[0].told) : 0;
  if (now.getTime() - told < DAY_MS) return false;
  const s = await survey(pool, files, { closedMonths: DEFAULT_CLOSED_MONTHS, now });
  const back = s.candidates
    .filter((c) => (SUGGESTED as readonly string[]).includes(c.kind))
    .reduce((a, c) => a + c.bytes, 0);
  if (back <= 0) return false;
  // Claimed first, so two API processes looking in the same hour tell once.
  const claim = await pool.query(
    `UPDATE settings SET integrations = jsonb_set(coalesce(integrations, '{}'::jsonb), '{storage}',
            coalesce(integrations -> 'storage', '{}'::jsonb) || jsonb_build_object('toldAt', $1::text))
      WHERE id = 1 AND coalesce((integrations -> 'storage' ->> 'toldAt')::timestamptz, 'epoch') < $2::timestamptz`,
    [now.toISOString(), new Date(now.getTime() - DAY_MS).toISOString()],
  );
  if (!claim.rowCount) return false;
  for (const uid of await adminIds(pool))
    await notify(pool, uid, {
      kind: "system_alert",
      title: `The server is ${used}% full`,
      body: `LUME can give back ${storageSize(back)}. Nothing on an open lead.`,
      data: { href: "/settings/storage" },
    });
  return true;
}
