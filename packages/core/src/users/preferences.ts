import { z } from "zod";

/** What LUME remembers about how one person works (spec §4.2). Stored on users.preferences. */
export type Preferences = {
  /** 0 = Sunday … 6 = Saturday. */
  workingDays: number[];
  workStart: string;
  workEnd: string;
  digestTime: string;
  sounds: { enabled: boolean; volume: number };
  /** weeklyAnalytics (8B): the Monday email of last week's numbers, for those who see all analytics; on unless switched off. */
  alerts: { assigned: boolean; dueFollowUps: boolean; emailDigest: boolean; weeklyAnalytics?: boolean };
};

export const PREFERENCES_DEFAULTS: Preferences = {
  workingDays: [1, 2, 3, 4, 5],
  workStart: "09:00",
  workEnd: "18:00",
  digestTime: "08:00",
  sounds: { enabled: true, volume: 60 },
  alerts: { assigned: true, dueFollowUps: true, emailDigest: true, weeklyAnalytics: true },
};

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const full = z.strictObject({
  workingDays: z.array(z.number().int().min(0).max(6)).max(7),
  workStart: time,
  workEnd: time,
  digestTime: time,
  sounds: z.strictObject({ enabled: z.boolean(), volume: z.number().int().min(0).max(100) }),
  alerts: z.strictObject({
    assigned: z.boolean(),
    dueFollowUps: z.boolean(),
    emailDigest: z.boolean(),
    weeklyAnalytics: z.boolean().optional(),
  }),
});

/** A patch may set any subset, one level deep inside `sounds` and `alerts`. */
export const preferencesPatchSchema = z.strictObject({
  workingDays: full.shape.workingDays.optional(),
  workStart: time.optional(),
  workEnd: time.optional(),
  digestTime: time.optional(),
  sounds: full.shape.sounds.partial().optional(),
  alerts: full.shape.alerts.partial().optional(),
});
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

/**
 * Merge a patch onto what is stored. Anything stored that no longer parses (an older shape, a hand-edited
 * row) falls back to the default for that value rather than failing the request.
 */
export function mergePreferences(stored: unknown, patch: unknown): Preferences {
  const base = full.safeParse(stored);
  const current: Preferences = base.success
    ? base.data
    : {
        ...PREFERENCES_DEFAULTS,
        ...repair(stored),
      };
  const p = preferencesPatchSchema.parse(patch ?? {});
  return {
    workingDays: p.workingDays ?? current.workingDays,
    workStart: p.workStart ?? current.workStart,
    workEnd: p.workEnd ?? current.workEnd,
    digestTime: p.digestTime ?? current.digestTime,
    sounds: { ...current.sounds, ...(p.sounds ?? {}) },
    alerts: { ...current.alerts, ...(p.alerts ?? {}) },
  };
}

/** Keep whichever individual values still parse; drop the rest. */
function repair(stored: unknown): Partial<Preferences> {
  if (typeof stored !== "object" || stored === null) return {};
  const out: Partial<Preferences> = {};
  const src = stored as Record<string, unknown>;
  for (const key of ["workingDays", "workStart", "workEnd", "digestTime", "sounds", "alerts"] as const) {
    const field = full.shape[key];
    const r = field.safeParse(src[key]);
    if (r.success) Object.assign(out, { [key]: r.data });
    // A group with only some of its switches (an older row, or one written by hand): keep the ones it has.
    else if (key === "sounds" || key === "alerts") {
      const some = full.shape[key].partial().safeParse(src[key]);
      if (some.success) Object.assign(out, { [key]: { ...PREFERENCES_DEFAULTS[key], ...some.data } });
    }
  }
  return out;
}
