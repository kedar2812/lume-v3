import { createHash } from "node:crypto";
import type { SheetCell, SheetRow } from "./rows";

/** Server only (node:crypto): a row's cells as one value, to tell whether LUME needs to write it again. */
export const rowHash = (cells: SheetCell[]): string =>
  createHash("sha256").update(JSON.stringify(cells)).digest("hex");

/** What LUME last wrote for a lead's row, and what a person did to it since. */
export type Written = {
  leadId: string;
  hash: string;
  cells: SheetCell[];
  /** Columns a person changed by hand since LUME wrote them. */
  editedCols: number[];
  /** The row was deleted by hand. */
  removedByHand: boolean;
};
export type WritePlan = {
  add: SheetRow[];
  update: { leadId: string; cells: SheetCell[]; skipCols: number[] }[];
  /** Lead ids whose rows leave the sheet. */
  remove: string[];
};

/**
 * One update's writes (spec §6): new matches added; changed leads updated (with Keep them, cells edited by hand
 * skipped, and rows deleted by hand left deleted); leads that stop matching leave only with an "in" rule; and a lead
 * deleted from LUME always leaves, whatever was chosen.
 */
export function planWrites(o: {
  desired: SheetRow[];
  written: Written[];
  edits: "keep" | "replace";
  ruleMode: "reached" | "in";
  deleted: Set<string>;
}): WritePlan {
  const keep = o.edits === "keep";
  const was = new Map(o.written.map((w) => [w.leadId, w]));
  const wanted = new Set(o.desired.map((r) => r.leadId));
  const remove: string[] = [];
  for (const w of o.written) {
    if (w.removedByHand) continue;
    if (o.deleted.has(w.leadId) || (!wanted.has(w.leadId) && o.ruleMode === "in")) remove.push(w.leadId);
  }
  const update: WritePlan["update"] = [];
  const add: SheetRow[] = [];
  for (const r of o.desired) {
    if (o.deleted.has(r.leadId)) continue;
    const w = was.get(r.leadId);
    if (!w || (w.removedByHand && !keep)) {
      if (!w || !keep) add.push(r);
      continue;
    }
    if (w.removedByHand) continue;
    const changed = rowHash(r.cells) !== w.hash;
    // Put LUME's back also rewrites a row whose cells were edited by hand.
    if (changed || (!keep && w.editedCols.length > 0))
      update.push({ leadId: r.leadId, cells: r.cells, skipCols: keep ? [...w.editedCols] : [] });
  }
  return { add, update, remove };
}
