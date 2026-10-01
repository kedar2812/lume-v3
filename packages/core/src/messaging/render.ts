/**
 * WhatsApp templates in the lead's own words (Phase 4A; report §11.1). One pure renderer for the server
 * and the screen: the server always renders again from the lead the caller may see, and the editor
 * previews with the same function on every keystroke. A template never carries a contact: phone, email,
 * web and Instagram fields don't render, and there are no variables for them.
 */
import type { FieldType } from "../leads/custom-fields";

export type TemplateCategory = "first_touch" | "follow_up" | "reminder" | "re_engagement" | "custom";
export const TEMPLATE_CATEGORIES: { key: TemplateCategory; label: string }[] = [
  { key: "first_touch", label: "First touch" },
  { key: "follow_up", label: "Follow-up" },
  { key: "reminder", label: "Reminder" },
  { key: "re_engagement", label: "Re-engagement" },
  { key: "custom", label: "Custom" },
];

export type RenderContext = {
  lead: { name: string; custom: Record<string, unknown> };
  owner: { name: string } | null;
  business: { name: string; currency: string; timezone: string };
  /** The business's live custom fields: select values are stored as option ids. */
  fields: { key: string; type: FieldType; options?: { id: string; label: string }[] }[];
  people: { id: string; name: string }[];
  /** The lead's next scheduled meeting (5C), if any: its details render on the business's clock. */
  meeting?: { startsAt: string; link: string | null } | null;
};

/** Field types that hold a way to reach someone: never in a message a masked rep can see. */
const CONTACT_TYPES: ReadonlySet<FieldType> = new Set(["phone", "email", "url", "instagram"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const first = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const listed = (xs: string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? "");

function when(iso: string, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      day: "numeric",
      month: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]}, ${p.hour}:${p.minute}`;
}

/** The lead's next meeting (5C): "Thursday 1 October", "10:30 am" (a whole hour: "12 pm"), its link. */
function meetingValue(part: string, ctx: RenderContext): string | null {
  const m = ctx.meeting;
  if (!m) return null;
  if (part === "link") return m.link || null;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: ctx.business.timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(m.startsAt))
      .map((x) => [x.type, x.value]),
  );
  if (part === "date") return `${p.weekday} ${Number(p.day)} ${p.month}`;
  if (part === "time") {
    const h = Number(p.hour);
    const mins = p.minute === "00" ? "" : `:${p.minute}`;
    return `${h % 12 || 12}${mins} ${h < 12 ? "am" : "pm"}`;
  }
  return null;
}

/** One custom value as people read it, or null when there's nothing to say (or it's a contact). */
function customValue(key: string, ctx: RenderContext): string | null {
  const field = ctx.fields.find((f) => f.key === key);
  const v = ctx.lead.custom[key];
  if (!field || CONTACT_TYPES.has(field.type) || v === null || v === undefined || v === "") return null;
  const label = (id: unknown) => field.options?.find((o) => o.id === id)?.label;
  switch (field.type) {
    case "select":
      return label(v) ?? null;
    case "multi_select": {
      const labels = (Array.isArray(v) ? v : []).map(label).filter((x): x is string => !!x);
      return labels.length ? listed(labels) : null;
    }
    case "date": {
      const [, m, d] = String(v).split("-").map(Number);
      return m && d ? `${d} ${MONTHS[m - 1]}` : null;
    }
    case "datetime":
      return when(String(v), ctx.business.timezone);
    case "currency": {
      const n = Number(v);
      const whole = Number.isInteger(n);
      // In the currency's own local form (₹5,000, $1,250.50); one with no sign in English keeps its code.
      try {
        return new Intl.NumberFormat("en", {
          style: "currency",
          currency: ctx.business.currency,
          minimumFractionDigits: whole ? 0 : 2,
          maximumFractionDigits: 2,
        })
          .format(n)
          .replace(/\u00a0/g, " "); // a plain space: a message is plain text
      } catch {
        return `${ctx.business.currency} ${n.toLocaleString("en", { maximumFractionDigits: 2 })}`;
      }
    }
    case "number":
      return String(v);
    case "boolean":
      return v ? "Yes" : "No";
    case "user": {
      const who = ctx.people.find((p) => p.id === v);
      return who ? first(who.name) : null;
    }
    default:
      return String(v);
  }
}

function valueOf(token: string, ctx: RenderContext): string | null {
  switch (token) {
    case "lead.first_name":
      return first(ctx.lead.name) || null;
    case "lead.name":
      return ctx.lead.name.trim() || null;
    case "owner.first_name":
      return ctx.owner ? first(ctx.owner.name) || null : null;
    case "business.name":
      return ctx.business.name || null;
  }
  if (token.startsWith("lead.custom.")) return customValue(token.slice("lead.custom.".length), ctx);
  if (token.startsWith("meeting.")) return meetingValue(token.slice("meeting.".length), ctx);
  return null; // anything unknown
}

/** The template in this lead's words, and the variables that had nothing to say (each once, in order). */
export function render(body: string, ctx: RenderContext): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, token: string) => {
    const v = valueOf(token, ctx);
    if (v !== null) return v;
    if (!missing.includes(token)) missing.push(token);
    return whole;
  });
  return { text, missing };
}

export type Variable = { token: string; label: string; needs?: "calendar" };

/** What the variable picker offers: the lead, the owner, the business, each non-contact field, and meetings. */
export function VARIABLES(fields: { key: string; type: FieldType; label?: string }[]): Variable[] {
  return [
    { token: "lead.first_name", label: "First name" },
    { token: "lead.name", label: "Full name" },
    { token: "owner.first_name", label: "Owner's first name" },
    { token: "business.name", label: "Business name" },
    ...fields
      .filter((f) => !CONTACT_TYPES.has(f.type))
      .map((f) => ({ token: `lead.custom.${f.key}`, label: f.label ?? f.key })),
    { token: "meeting.date", label: "Meeting date", needs: "calendar" as const },
    { token: "meeting.time", label: "Meeting time", needs: "calendar" as const },
    { token: "meeting.link", label: "Meeting link", needs: "calendar" as const },
  ];
}

export type Run = { t: string; b?: true; i?: true };

/** WhatsApp's *bold* and _italic_ as runs, for a preview; a mark with no partner is plain text. */
export function waFormat(text: string): Run[] {
  const runs: Run[] = [];
  const re = /(\*)(?=\S)([^*\n]*?\S)\*|(_)(?=\S)([^_\n]*?\S)_/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // A mark only counts at a word boundary, as WhatsApp does ("a_b" stays plain).
    const before = text[m.index - 1];
    const after = text[m.index + m[0].length];
    if ((before && /\w/.test(before)) || (after && /\w/.test(after))) continue;
    if (m.index > at) runs.push({ t: text.slice(at, m.index) });
    runs.push(m[1] ? { t: m[2]!, b: true } : { t: m[4]!, i: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) runs.push({ t: text.slice(at) });
  return runs;
}
