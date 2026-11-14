import { z } from "zod";

/**
 * Live sheets (spec 2026-11-14): which leads a sheet holds. "reached" keeps every lead that ever got to a stage (a
 * record of who qualified); "in" is a live list of who's there now. The rest narrows it.
 */
export type LiveSheetPreset = "meta" | "own";
export type LiveStageRule = { mode: "reached" | "in"; stageIds: string[] };
export type LiveSheetRule = {
  stages: LiveStageRule;
  sourceIds?: string[];
  tagIds?: string[];
  ownerIds?: string[];
  teamIds?: string[];
  /** YYYY-MM-DD on the business's clock. */
  addedOnOrAfter?: string;
  /** Meta: leads with no phone and no email go in too, their empty cells shaded. */
  includeMissing: boolean;
  /** Leads marked do not contact. */
  includeDnc: boolean;
  /** Leads that matched before the sheet was made. */
  backfill: boolean;
};

const ids = (max: number) => z.array(z.uuid()).max(max);
export const liveSheetRuleSchema = z.object({
  stages: z.object({ mode: z.enum(["reached", "in"]), stageIds: ids(20).min(1) }),
  sourceIds: ids(50).optional(),
  tagIds: ids(50).optional(),
  ownerIds: ids(50).optional(),
  teamIds: ids(50).optional(),
  addedOnOrAfter: z.iso.date().optional(),
  includeMissing: z.boolean(),
  includeDnc: z.boolean(),
  backfill: z.boolean(),
}) satisfies z.ZodType<LiveSheetRule>;

/** Most live sheets a business keeps. */
export const LIVE_SHEETS_MAX = 20;
