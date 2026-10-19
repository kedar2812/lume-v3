/**
 * LUME's templates as WhatsApp's (W3b-2; spec 2026-10-18 §4.3). A business writes a template once in LUME with
 * named variables ("{{lead.first_name}}"); WhatsApp takes numbered ones ("{{1}}") with a sample for each, and turns
 * down a template for rules it states. LUME checks those rules first, so a person hears what's wrong now, in LUME's
 * words, instead of a rejection a day later.
 */
import type { FieldType } from "../leads/custom-fields";
import { exampleOf, valueOf, type RenderContext, type TemplateCategory } from "../messaging/render";

export type MetaCategory = "MARKETING" | "UTILITY";
export type HeaderKind = "image" | "video" | "document";

const VAR = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MB = 1024 * 1024;
/** WhatsApp's own limits for a template: its body, and a file at the top. */
const BODY_MAX = 1024;
const HEADER: Record<HeaderKind, { mimes: string[]; max: number; type: string; word: string; size: string }> =
  {
    image: {
      mimes: ["image/jpeg", "image/png"],
      max: 5 * MB,
      type: "A photo at the top must be a JPEG or PNG.",
      word: "photo",
      size: "5 MB",
    },
    video: {
      mimes: ["video/mp4"],
      max: 16 * MB,
      type: "A video at the top must be an MP4.",
      word: "video",
      size: "16 MB",
    },
    document: {
      mimes: ["application/pdf"],
      max: 100 * MB,
      type: "A document at the top must be a PDF.",
      word: "document",
      size: "100 MB",
    },
  };
const NAME_MAX = 512;

/** A reminder is about something the lead already has (a visit, a call): WhatsApp's utility. The rest sell. */
export const metaCategoryOf = (c: TemplateCategory): MetaCategory =>
  c === "reminder" ? "UTILITY" : "MARKETING";

/** WhatsApp's name for one version of a template: lowercase letters and digits joined by "_", the version last. */
export function metaNameOf(name: string, version: number): string {
  const words = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const tail = `_v${version}`;
  const head = (words.join("_") || "template").slice(0, NAME_MAX - tail.length).replace(/_+$/, "");
  return `${head}${tail}`;
}

/** The variables a body uses, each once, in the order they first appear. */
function tokensOf(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(VAR)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** What WhatsApp would turn down in this template, each in LUME's words; [] when it's ready to submit. */
export function templateProblems(
  body: string,
  header?: { kind: HeaderKind; size: number; mime: string },
): string[] {
  const problems: string[] = [];
  const text = body.trim();
  if (!text) return ["Write the message first."];
  if (text.length > BODY_MAX) problems.push("WhatsApp templates can be up to 1,024 characters.");
  const around = "Add words before and after it.";
  if (/^\{\{[^{}]+\}\}/.test(text))
    problems.push(`WhatsApp doesn't take a template that starts with a variable. ${around}`);
  if (/\{\{[^{}]+\}\}$/.test(text))
    problems.push(`WhatsApp doesn't take a template that ends with a variable. ${around}`);
  if (/\}\}\s*\{\{/.test(text)) problems.push("Put words between two variables.");
  const vars = [...text.matchAll(VAR)].length;
  const words = text.replace(VAR, " ").split(/\s+/).filter(Boolean).length;
  if (vars > 0 && vars > words / 2)
    problems.push("Too many variables for so few words. Add words around them.");
  if (header) {
    const rule = HEADER[header.kind];
    if (!rule.mimes.includes(header.mime.split(";")[0]!.trim().toLowerCase())) problems.push(rule.type);
    else if (header.size > rule.max) problems.push(`A ${rule.word} at the top can be up to ${rule.size}.`);
  }
  return problems;
}

/**
 * The template as WhatsApp's create call takes it, and LUME's variables in the order of its numbers ({{1}} is
 * `tokens[0]`), kept beside the submission so a send fills each number from the right one.
 */
export function toMetaTemplate(t: {
  name: string;
  version: number;
  language: string;
  category: MetaCategory;
  body: string;
  header?: { kind: HeaderKind; handle: string };
  fields?: { key: string; type: FieldType }[];
}): { payload: Record<string, unknown>; tokens: string[] } {
  const tokens = tokensOf(t.body);
  const text = t.body.trim().replace(VAR, (_whole, token: string) => `{{${tokens.indexOf(token) + 1}}}`);
  const components: Record<string, unknown>[] = [];
  if (t.header)
    components.push({
      type: "HEADER",
      format: t.header.kind.toUpperCase(),
      example: { header_handle: [t.header.handle] },
    });
  components.push({
    type: "BODY",
    text,
    ...(tokens.length ? { example: { body_text: [tokens.map((x) => exampleOf(x, t.fields))] } } : {}),
  });
  return {
    payload: { name: metaNameOf(t.name, t.version), language: t.language, category: t.category, components },
    tokens,
  };
}

/** This lead's values for the numbered variables, in order; what has nothing to say is named, and left blank. */
export function paramsFor(tokens: string[], ctx: RenderContext): { values: string[]; missing: string[] } {
  const missing: string[] = [];
  const values = tokens.map((token) => {
    const v = valueOf(token, ctx);
    if (v === null) missing.push(token);
    return v ?? "";
  });
  return { values, missing };
}

/** WhatsApp's reasons for turning a template down, in LUME's words. */
const REASONS: Record<string, string> = {
  INVALID_FORMAT:
    "WhatsApp found its format wrong: often a variable at the very start or end, or a sample that doesn't fit.",
  INCORRECT_CATEGORY: "WhatsApp thinks it belongs in another category.",
  TAG_CONTENT_MISMATCH: "WhatsApp thinks its category doesn't match what it says.",
  PROMOTIONAL: "WhatsApp read it as selling something, which a reminder can't do.",
  ABUSIVE_CONTENT: "WhatsApp found something in it that it doesn't allow.",
  SCAM: "WhatsApp thought it could mislead people.",
};
export const templateReasonWords = (reason: string | null): string | null =>
  reason === null ? null : (REASONS[reason] ?? `WhatsApp said: ${reason.toLowerCase().replace(/_/g, " ")}.`);
