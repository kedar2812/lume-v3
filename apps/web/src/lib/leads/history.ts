import { personName, stageOf } from "./format";
import type { Activity, Catalog } from "./types";

export type HistoryLine = { title: string; detail?: string; tone: string; quote?: string };

/** API property names in field_changed payloads → field keys. */
const PROP_TO_FIELD: Record<string, string> = {
  leadCreatedAt: "lead_created_at",
  productId: "product",
  ownerId: "owner",
  stageId: "stage",
  sourceId: "source",
};
const by = (a: Activity) => (a.user ? `by ${a.user.name}` : undefined);
const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" · ") || undefined;

/** One event in plain words. Unknown types still render ("Updated"), so a newer API never breaks the drawer. */
export function describeActivity(a: Activity, cat: Catalog): HistoryLine {
  const p = a.payload ?? {};
  switch (a.type) {
    case "stage_changed": {
      const to = stageOf(cat, p.to as string | undefined);
      if (to?.kind === "lost") {
        const reason = cat.lostReasons.find((r) => r.id === p.lostReasonId)?.label;
        return { title: "Marked as lost", detail: join(reason, by(a)), tone: "danger" };
      }
      if (to?.kind === "won") return { title: "Won", detail: by(a), tone: "ok" };
      return { title: `Moved to ${to?.name ?? "another stage"}`, detail: by(a), tone: to?.color ?? "accent" };
    }
    case "assigned":
      return {
        title: p.to ? `Handed to ${personName(cat, p.to as string)}` : "Unassigned",
        detail: by(a),
        tone: "meet",
      };
    case "contact_revealed":
      return { title: "Contact revealed", detail: by(a), tone: "neutral" };
    case "whatsapp_opened":
      return {
        title: "WhatsApp opened",
        detail: by(a),
        tone: "ok",
        ...(p.text ? { quote: String(p.text) } : {}),
      };
    case "whatsapp_confirmed_sent":
      return { title: "WhatsApp sent", detail: by(a), tone: "ok" };
    case "whatsapp_not_sent":
      return { title: "WhatsApp not sent", detail: by(a), tone: "neutral" };
    case "field_changed": {
      const labels = ((p.fields as string[] | undefined) ?? []).map((k) => {
        const key = PROP_TO_FIELD[k] ?? k.replace(/^custom\./, "");
        if (key === "tags") return "Tags";
        return cat.fields.find((f) => f.key === key)?.label ?? key;
      });
      return { title: `Edited ${labels.join(", ") || "details"}`, detail: by(a), tone: "neutral" };
    }
    case "lead_created":
      return {
        title: "Lead added",
        detail: join(p.source === "sheet" ? "from the Google Sheet" : undefined, by(a)),
        tone: "accent",
      };
    case "note":
      return { title: "Note", detail: by(a), tone: "neutral", quote: String(p.body ?? "") };
    default:
      return { title: "Updated", detail: by(a), tone: "neutral" };
  }
}
