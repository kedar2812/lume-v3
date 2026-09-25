"use client";
import { leadsClient } from "./client";
import type { BulkAction, BulkResult } from "./types";

/** The API's limit on ids per bulk request. */
export const BULK_CHUNK = 100;

const VERB: Record<BulkAction["type"], string> = {
  stage: "moved",
  assign: "reassigned",
  tags: "updated",
  delete: "deleted",
};
const WHY: Record<string, string> = {
  LOST_REASON_REQUIRED: "needs a lost reason",
  UNKNOWN_LOST_REASON: "that lost reason is gone",
  REQUIRED_FIELDS: "missing required fields",
  FORBIDDEN: "not yours to change",
  LEAD_NOT_FOUND: "no longer visible to you",
  NOT_FOUND: "no longer visible to you",
  ASSIGN_OUT_OF_SCOPE: "outside who you can assign to",
  UNKNOWN_STAGE: "that stage is gone",
  UNKNOWN_USER: "that person can’t take leads",
  OFFLINE: "the connection dropped",
};
const why = (code: string) => WHY[code] ?? "couldn’t be changed";

/** "3 moved, 1 skipped: needs a lost reason" — the result of a bulk action, reasons grouped (spec §6). */
export function bulkSummary(action: BulkAction, r: BulkResult): string {
  const done = r.updated.length ? `${r.updated.length} ${VERB[action.type]}` : `None ${VERB[action.type]}`;
  if (!r.skipped.length) return done;
  const groups = new Map<string, number>();
  for (const s of r.skipped) groups.set(why(s.code), (groups.get(why(s.code)) ?? 0) + 1);
  const reasons =
    groups.size === 1
      ? [...groups.keys()][0]!
      : [...groups].map(([reason, n]) => `${n} ${reason}`).join(", ");
  return `${done}, ${r.skipped.length} skipped: ${reasons}`;
}

/** The API takes at most 100 ids per request; bigger selections go in turns and the answers are merged. */
export async function runBulkInChunks(ids: string[], action: BulkAction): Promise<BulkResult> {
  const out: BulkResult = { updated: [], skipped: [] };
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    const chunk = ids.slice(i, i + BULK_CHUNK);
    const r = await leadsClient.bulk(chunk, action);
    if (!r.ok) {
      out.skipped.push(...chunk.map((id) => ({ id, code: r.code })));
      continue;
    }
    out.updated.push(...r.data.updated);
    out.skipped.push(...r.data.skipped);
  }
  return out;
}
