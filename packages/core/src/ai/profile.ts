import { z } from "zod";

/**
 * Settings → LUME AI (Autopilot spec 2026-10-19 §5): what LUME AI knows about the business, its voice, and the
 * business's standing choices for Autopilot (§1.1–1.3, §3). One document per business, all in its own words.
 */

/** What Autopilot may do, each set to Go ahead, Ask me or Never (§1.3). */
export const AUTOPILOT_ACTIONS = [
  "first_messages",
  "follow_ups",
  "replies",
  "send_files",
  "book_meetings",
  "move_stages",
  "set_follow_ups",
  "fill_fields",
  "answer_prices",
  "mark_lost",
  "hand_to_rep",
] as const;
export type AutopilotAction = (typeof AUTOPILOT_ACTIONS)[number];
export type Allow = "go" | "ask" | "never";
export type AutopilotPreset = "careful" | "balanced" | "hands_off";

const every = (pick: (a: AutopilotAction) => Allow) =>
  Object.fromEntries(AUTOPILOT_ACTIONS.map((a) => [a, pick(a)])) as Record<AutopilotAction, Allow>;
/** The careful group (§1.3): what's asked about even in Balanced. */
const CAREFUL_GROUP: readonly AutopilotAction[] = ["answer_prices", "mark_lost", "hand_to_rep"];

/**
 * As the owner approved them in the start sheet's mockup (2026-10-19, v4). Careful: first messages, follow-ups and
 * reminders go, the rest of what touches a lead asks, and it never quotes a price or marks a lead lost. Balanced (the
 * default): talks and books, and asks about the careful group. Hands-off: does all of it.
 */
export const AUTOPILOT_PRESETS: Record<AutopilotPreset, Record<AutopilotAction, Allow>> = {
  careful: {
    first_messages: "go",
    follow_ups: "go",
    replies: "ask",
    send_files: "ask",
    book_meetings: "ask",
    move_stages: "ask",
    set_follow_ups: "go",
    fill_fields: "ask",
    answer_prices: "never",
    mark_lost: "never",
    hand_to_rep: "ask",
  },
  balanced: every((a) => (CAREFUL_GROUP.includes(a) ? "ask" : "go")),
  hands_off: every(() => "go"),
};

/** The preset these permissions are, or null when a row was changed by hand. */
export function presetOf(perms: Record<AutopilotAction, Allow>): AutopilotPreset | null {
  for (const [name, p] of Object.entries(AUTOPILOT_PRESETS) as [
    AutopilotPreset,
    Record<AutopilotAction, Allow>,
  ][])
    if (AUTOPILOT_ACTIONS.every((a) => perms[a] === p[a])) return name;
  return null;
}

const unique = <T>(xs: T[]) => new Set(xs).size === xs.length;
const words = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max, `${what} is at most ${max.toLocaleString("en-US")} characters.`);

/** A business's real price, in its own currency: up to 999,999,999,999.99, at most two decimals (Review Focus 4). */
const amount = z.number({ error: "A price is a number." }).superRefine((x, ctx) => {
  if (!Number.isFinite(x)) ctx.addIssue({ code: "custom", message: "A price is a number." });
  else if (x < 0) ctx.addIssue({ code: "custom", message: "A price can't be below zero." });
  else if (x >= 1e12) ctx.addIssue({ code: "custom", message: "A price must be under 1,000,000,000,000." });
  else if (!/^\d+(\.\d{1,2})?$/.test(String(x)))
    ctx.addIssue({ code: "custom", message: "A price has at most two decimal places." });
});

const allow = z.enum(["go", "ask", "never"], { error: "Choose Go ahead, Ask me or Never." });
const action = z.enum(AUTOPILOT_ACTIONS, { error: "That isn't something LUME AI does." });

const FIELDS = {
  knows: {
    about: words(2000, "About your business"),
    faqs: z
      .array(
        z.strictObject({
          q: words(300, "A question").min(1, "Each question needs its words."),
          a: words(1000, "An answer").min(1, "Each answer needs its words."),
        }),
      )
      .max(50, "Up to 50 questions."),
    prices: z
      .array(
        z.strictObject({
          id: z.uuid(),
          item: words(120, "What a price is for").min(1, "Each price needs what it's for."),
          price: amount,
          unit: words(40, "A unit"),
          notes: words(300, "A price's notes"),
        }),
      )
      .max(200, "Up to 200 prices.")
      .refine((ps) => unique(ps.map((p) => p.id)), "A price is listed twice."),
    files: z.array(z.uuid()).max(50, "Up to 50 files.").refine(unique, "A file is chosen twice."),
    neverSay: z
      .array(words(200, "A thing never to say").min(1, "Each line needs its words."))
      .max(30, "Up to 30 lines."),
  },
  voice: {
    tone: z.enum(["warm", "formal", "casual"], { error: "Choose warm, formal or casual." }),
    /** "match_lead" (the lead's own language) or a language code such as hi-IN. */
    language: z
      .string()
      .refine(
        (v) => v === "match_lead" || (v.length <= 20 && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v)),
        {
          message: "Choose a language from the list.",
        },
      ),
    signOff: words(80, "A sign-off"),
  },
  standing: {
    goalStages: z
      .array(z.uuid())
      .max(5, "Up to five goal stages.")
      .refine(unique, "A goal stage is chosen twice."),
    followUpDays: z
      .array(
        z
          .number()
          .int("A follow-up day is a whole day.")
          .min(1, "A follow-up day is from 1 to 30.")
          .max(30, "A follow-up day is from 1 to 30."),
      )
      .min(1, "Choose at least one follow-up day.")
      .max(4, "Up to four follow-ups after the first message.")
      .refine(
        (ds) => ds.every((d, i) => i === 0 || d > ds[i - 1]!),
        "Follow-up days go from the soonest to the latest, each once.",
      ),
    /** Who LUME AI speaks as; null: whoever starts the run (§1.2). */
    speaker: z.uuid().nullable(),
    /** Null: from the number's Meta tier (§1.2). */
    dailyCap: z
      .number()
      .int("A daily cap is a whole number.")
      .min(1, "A daily cap is from 1 to 10,000.")
      .max(10_000, "A daily cap is from 1 to 10,000.")
      .nullable(),
    /** Denying it's AI is never a choice (§3). */
    botQuestion: z.enum(["say_so", "hand_over"], { error: "Choose say so or hand over." }),
    outsideHours: z.enum(["reply_any_time", "wait"], { error: "Choose reply any time or wait." }),
  },
};

export type AiProfile = {
  knows: {
    about: string;
    faqs: { q: string; a: string }[];
    prices: { id: string; item: string; price: number; unit: string; notes: string }[];
    files: string[];
    neverSay: string[];
  };
  voice: { tone: "warm" | "formal" | "casual"; language: string; signOff: string };
  standing: {
    goalStages: string[];
    permissions: Record<AutopilotAction, Allow>;
    followUpDays: number[];
    speaker: string | null;
    dailyCap: number | null;
    botQuestion: "say_so" | "hand_over";
    outsideHours: "reply_any_time" | "wait";
  };
};

export const DEFAULT_AI_PROFILE: AiProfile = {
  knows: { about: "", faqs: [], prices: [], files: [], neverSay: [] },
  voice: { tone: "warm", language: "match_lead", signOff: "" },
  standing: {
    goalStages: [],
    permissions: AUTOPILOT_PRESETS.balanced,
    followUpDays: [2, 5],
    speaker: null,
    dailyCap: null,
    botQuestion: "say_so",
    outsideHours: "wait",
  },
};

/** A patch names any fields of any section; permissions change row by row; lists are replaced whole. */
export const aiProfilePatchSchema = z.strictObject({
  knows: z.strictObject(FIELDS.knows).partial().optional(),
  voice: z.strictObject(FIELDS.voice).partial().optional(),
  standing: z
    .strictObject({ ...FIELDS.standing, permissions: z.partialRecord(action, allow) })
    .partial()
    .optional(),
});
export type AiProfilePatch = z.infer<typeof aiProfilePatchSchema>;

/** What's wrong with a patch, in words (the first thing), or null when it's fine. */
export function profileProblem(patch: unknown): string | null {
  const r = aiProfilePatchSchema.safeParse(patch);
  return r.success ? null : (r.error.issues[0]?.message ?? "That can't be saved.");
}

/** Keep each stored value that still parses, field by field; the default for the rest (an older shape, a new field). */
function readStored(stored: unknown): AiProfile {
  const obj = (x: unknown): Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
  const src = obj(stored);
  const section = <K extends "knows" | "voice">(k: K): AiProfile[K] => {
    const from = obj(src[k]);
    const out: Record<string, unknown> = { ...DEFAULT_AI_PROFILE[k] };
    for (const [f, schema] of Object.entries(FIELDS[k])) {
      const r = (schema as z.ZodType).safeParse(from[f]);
      if (r.success) out[f] = r.data;
    }
    return out as AiProfile[K];
  };
  const standing = obj(src.standing);
  const out: Record<string, unknown> = { ...DEFAULT_AI_PROFILE.standing };
  for (const [f, schema] of Object.entries(FIELDS.standing)) {
    const r = (schema as z.ZodType).safeParse(standing[f]);
    if (r.success) out[f] = r.data;
  }
  const perms = obj(standing.permissions);
  out.permissions = Object.fromEntries(
    AUTOPILOT_ACTIONS.map((a) => {
      const r = allow.safeParse(perms[a]);
      return [a, r.success ? r.data : DEFAULT_AI_PROFILE.standing.permissions[a]];
    }),
  );
  return { knows: section("knows"), voice: section("voice"), standing: out as AiProfile["standing"] };
}

/** Merge a patch onto what's stored (like mergePreferences): a stored value that no longer parses falls back. */
export function mergeAiProfile(stored: unknown, patch: unknown): AiProfile {
  const current = readStored(stored);
  const p = aiProfilePatchSchema.parse(patch ?? {});
  const { permissions, ...standing } = p.standing ?? {};
  return {
    knows: { ...current.knows, ...p.knows },
    voice: { ...current.voice, ...p.voice },
    standing: {
      ...current.standing,
      ...standing,
      permissions: { ...current.standing.permissions, ...permissions },
    },
  };
}

/**
 * The ready-made goal stages when the business hasn't chosen (§1.1): the open stage just after the one a reply moves a
 * lead to (or the second open stage, with no reply move), and the last open stage before Won. Never the entry stage or
 * the reply stage itself ("Get a reply" is its own goal), never one twice.
 */
export function defaultGoalStages(open: { id: string; afterReplyStageId: string | null }[]): string[] {
  const ids = open.map((s) => s.id);
  const target = open.find(
    (s) => s.afterReplyStageId && ids.includes(s.afterReplyStageId),
  )?.afterReplyStageId;
  const after = target ? ids.indexOf(target) : 0;
  const rest = ids.slice(after + 1);
  return [...new Set([rest[0], rest.at(-1)].filter((x): x is string => !!x))];
}
