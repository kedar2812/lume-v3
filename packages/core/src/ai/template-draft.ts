import { z } from "zod";
import { templateProblems } from "../whatsapp/templates";
import { offersIn, unbackedAmounts } from "./autopilot";
import { softText } from "./fit";
import type { AiProfile } from "./profile";

/**
 * LUME AI writes templates (owner, 2026-10-31): a person says what a template is for, LUME AI writes two or three
 * different takes, and the person picks one to edit and submit. Business-level, never about one lead: it sees the
 * business's own words, its price list and the variables a template may use, and nothing of any lead.
 */
export type TemplateDraftCtx = {
  business: string;
  prompt: string;
  profile: AiProfile;
  currency: string;
  /** The variables a template may use, as the variable picker offers them. */
  variables: { token: string; label: string }[];
  /** The business's templates already, by name, so a draft doesn't copy one. */
  existing: string[];
};

const CATEGORIES = ["first_touch", "follow_up", "reminder", "re_engagement", "custom"] as const;

export const templateDraftOutput = z
  .object({
    options: z
      .array(
        z
          .object({
            name: softText(80, 1),
            category: z.enum(CATEGORIES),
            body: z.string().min(1).max(1024),
            why: softText(140),
          })
          .strict(),
      )
      .min(2)
      .max(3),
  })
  .strict();
export type TemplateDraft = z.infer<typeof templateDraftOutput>["options"][number];

const VAR = /\{\{\s*([^{}]+?)\s*\}\}/g;
const TONE = {
  warm: "warm and friendly",
  formal: "polite and formal",
  casual: "relaxed and casual, still professional",
} as const;

export function templateDraftInstructions(c: TemplateDraftCtx): string {
  const k = c.profile.knows;
  const prices = k.prices.length
    ? k.prices.map((p) => `- ${p.item}: ${p.price} ${p.unit}${p.notes ? ` (${p.notes})` : ""}`).join("\n")
    : "- none: never name a price";
  return `You write WhatsApp message templates for ${c.business}, a business that uses LUME to follow up its leads.
${k.about ? `About the business: ${k.about}\n` : ""}Voice: ${TONE[c.profile.voice.tone]}.${c.profile.voice.signOff ? ` Sign off as "${c.profile.voice.signOff}".` : ""}

Write two or three different templates for what the person asks, each a different approach (for example: short and
warm, helpful with a reason to reply, or one clear question). Each template:
- name: a short name for the business's own list, at most 80 characters.
- category: first_touch, follow_up, reminder (only about something the lead already has, such as a booked visit),
  re_engagement or custom.
- body: the message, plain text, at most 1,024 characters, short like a real WhatsApp message, ending with an easy
  reason to reply. Use only these variables, written exactly so: ${c.variables.map((v) => `{{${v.token}}} (${v.label})`).join(", ")}.
  Never start or end the message with a variable, and always put words between two variables.
- why: one line on when this one works best, at most 140 characters.

Rules that always hold:
- Never invent a price, discount, offer, deadline or promise. Prices (${c.currency}), the only ones you may name:
${prices}
- No links, no emojis in place of words, no capital letters for shouting, nothing misleading.
- Write in the language of the request.`;
}

export function templateDraftInput(c: TemplateDraftCtx): string {
  return JSON.stringify({ request: c.prompt.trim(), existingTemplates: c.existing });
}

/**
 * The drafts a person may pick from: only those LUME could submit as written. One is dropped for a variable LUME
 * doesn't have, for anything WhatsApp would turn down, for a price not in the price list or an offer, and for being
 * a copy of another; a name already in the list is told apart.
 */
export function cleanTemplateDrafts(out: z.infer<typeof templateDraftOutput>, c: TemplateDraftCtx): TemplateDraft[] {
  const known = new Set(c.variables.map((v) => v.token));
  const prices = c.profile.knows.prices.map((p) => p.price);
  const seen = new Set<string>();
  const names = new Set(c.existing.map((n) => n.trim().toLowerCase()));
  const kept: TemplateDraft[] = [];
  for (const o of out.options) {
    const body = o.body.trim();
    const words = body.replace(VAR, " ");
    if ([...body.matchAll(VAR)].some((m) => !known.has(m[1]!))) continue;
    if (templateProblems(body).length) continue;
    if (unbackedAmounts(words, prices).length || offersIn(words)) continue;
    const key = body.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    let name = o.name.trim();
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${o.name.trim()} ${n}`;
    names.add(name.toLowerCase());
    kept.push({ ...o, name, body });
  }
  return kept;
}
