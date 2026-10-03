import type { schema } from "@lume/db";
import type { FilterQuery } from "./query";

/** Phase 7B: what a bulk action is, and the limits runs work within (tests lower them). */
export type BulkAction =
  | { type: "stage"; stageId: string; lostReasonId?: string; lostNote?: string }
  | { type: "assign"; ownerId: string | null }
  | { type: "tags"; add?: string[]; remove?: string[] }
  | { type: "delete" }
  | { type: "set_phone_country"; country: string };

/** The action an undo run carries: which kind of run it puts back (the before-values are on the items). */
export type UndoAction = { type: "undo"; of: BulkAction["type"] };

export type Selection = { ids: string[] } | { filters: FilterQuery; except?: string[]; expected?: number };
export type RunRow = typeof schema.bulkRuns.$inferSelect;
export type Item = { leadId: string; position: number };
/** Tests steer a run with these: a throw here is a crash at that point. */
export type RunHooks = {
  afterChunk?: (n: number) => unknown;
  midChunk?: (n: number, i: number) => unknown;
};

const DEFAULTS = { cap: 50_000, inline: 500, chunk: 500, attempts: 5 };
export const limits = { ...DEFAULTS };
export const UNDO_HOURS = 24;
export const setBulkCapForTests = (n: number | null) => void (limits.cap = n ?? DEFAULTS.cap);
export const setInlineMaxForTests = (n: number | null) => void (limits.inline = n ?? DEFAULTS.inline);
export const setChunkForTests = (n: number | null) => void (limits.chunk = n ?? DEFAULTS.chunk);
