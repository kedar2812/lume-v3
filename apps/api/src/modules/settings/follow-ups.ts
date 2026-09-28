import {
  DEFAULT_DUE_PRESETS,
  DEFAULT_WORKING_HOURS,
  duePresetsSchema,
  workingHoursSchema,
  type DuePresetDef,
  type WorkingHours,
} from "@lume/core";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { schema } from "@lume/db";

/** Settings → Follow-ups (3B, 3C): everything around follow-ups an admin decides for the business. */
export type FollowUpSettings = {
  escalation: { enabled: boolean; hours: number };
  /** The morning email, for the whole business (3B final review). */
  digest: { enabled: boolean };
  /** Leads gone quiet: a follow-up for the owner after this many days without contact (3C). */
  noTouch: { enabled: boolean; days: number };
  /** Follow-ups LUME sets itself land inside working hours (report §10.2). */
  shiftToWorkingHours: boolean;
  /** The time choices people pick from when they set a follow-up (report §10.2). */
  duePresets: DuePresetDef[];
};

export const FOLLOW_UP_DEFAULTS: FollowUpSettings = {
  escalation: { enabled: true, hours: 24 },
  digest: { enabled: true },
  noTouch: { enabled: false, days: 7 },
  shiftToWorkingHours: true,
  duePresets: DEFAULT_DUE_PRESETS,
};

/** Each section is optional in a change, and changes on its own. */
export const followUpsBody = z
  .object({
    escalation: z.object({ enabled: z.boolean(), hours: z.number().int().min(1).max(168) }).strict(),
    digest: z.object({ enabled: z.boolean() }).strict(),
    noTouch: z.object({ enabled: z.boolean(), days: z.number().int().min(1).max(90) }).strict(),
    shiftToWorkingHours: z.boolean(),
    duePresets: duePresetsSchema,
  })
  .partial()
  .strict();

/** What's stored, read over the defaults (a section never saved is its default). */
export const followUpsFrom = (stored: unknown): FollowUpSettings => ({
  ...FOLLOW_UP_DEFAULTS,
  ...(stored && typeof stored === "object" ? (stored as Partial<FollowUpSettings>) : {}),
});

/** The business's working hours; never set (`{}`) reads as Monday to Friday, 09:00 to 18:00. */
export const workingHoursFrom = (stored: unknown): WorkingHours => {
  const r = workingHoursSchema.safeParse(stored);
  return r.success ? r.data : DEFAULT_WORKING_HOURS;
};

export async function readFollowUps(req: FastifyRequest): Promise<FollowUpSettings> {
  const [s] = await req.db
    .select({ f: schema.settings.followUps })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  return followUpsFrom(s?.f);
}
