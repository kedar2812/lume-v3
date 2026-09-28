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
    case "imported":
    case "imported_again":
    case "sheet_row_updated": {
      // Where it came from, and any other numbers typed into the same cell (masked for masked roles).
      const origin = p.file ?? p.sheet ?? p.webhook;
      const from = origin ? `from ${String(origin)}${p.row ? `, row ${String(p.row)}` : ""}` : undefined;
      const extra = Array.isArray(p.extraPhones) && p.extraPhones.length ? p.extraPhones.map(String) : null;
      return {
        title:
          a.type === "imported"
            ? "Imported"
            : a.type === "sheet_row_updated"
              ? "Filled in from the sheet"
              : "Enquired again",
        detail: join(from, by(a)),
        tone: "accent",
        ...(extra ? { quote: `Also gave ${extra.join(", ")}` } : {}),
      };
    }
    case "note":
      return { title: "Note", detail: by(a), tone: "neutral", quote: String(p.body ?? "") };
    // Follow-ups (Phase 3): what, and for when, in this browser's time.
    case "follow_up_set":
    case "follow_up_changed": {
      const due = typeof p.dueAt === "string" ? dueWords(p.dueAt) : undefined;
      return {
        title: a.type === "follow_up_set" ? "Follow-up set" : "Follow-up moved",
        detail: join([p.title ? `“${String(p.title)}”` : "", due ?? ""].filter(Boolean).join(", "), by(a)),
        tone: "accent",
      };
    }
    case "follow_up_done":
      return {
        title: "Follow-up done",
        detail: join(p.title ? `“${String(p.title)}”` : undefined, by(a)),
        tone: "ok",
      };
    case "follow_up_cancelled":
      return {
        title: "Follow-up cancelled",
        detail: join(p.title ? `“${String(p.title)}”` : undefined, by(a)),
        tone: "neutral",
      };
    // LUME's own work (3C): a stage's automations, and leads gone quiet.
    case "automation":
      return automationLine(p, cat);
    default:
      return { title: "Updated", detail: by(a), tone: "neutral" };
  }
}

const WHY: Record<string, string> = {
  no_owner: "this lead has no owner",
  owner_unavailable: "its owner can't take it",
  already_open: "one from this stage is still open",
  nobody: "there was no one to tell",
};
function automationLine(p: Record<string, unknown>, cat: Catalog): HistoryLine {
  const done = p.result === "done";
  const quoted = p.title ? `“${String(p.title)}”` : undefined;
  const due = typeof p.dueAt === "string" ? dueWords(p.dueAt) : undefined;
  switch (p.rule) {
    case "no_touch":
      return { title: `LUME set a follow-up: no contact for ${Number(p.days ?? 0)} days`, tone: "accent" };
    case "create_task":
      return done
        ? {
            title: "LUME set a follow-up",
            detail: join(
              p.assigneeId ? `for ${personName(cat, p.assigneeId as string)}` : undefined,
              quoted,
              due,
            ),
            tone: "accent",
          }
        : { title: "LUME couldn't set a follow-up", detail: WHY[String(p.reason)], tone: "neutral" };
    case "cancel_open_tasks": {
      const n = Number(p.cancelled ?? 0);
      return {
        title: n ? `LUME cleared ${n} open follow-up${n === 1 ? "" : "s"}` : "No open follow-ups to clear",
        tone: "neutral",
      };
    }
    case "notify": {
      const told = Array.isArray(p.told) ? p.told.map((id) => personName(cat, String(id))) : [];
      return told.length
        ? {
            title: `LUME told ${told.length > 1 ? `${told.slice(0, -1).join(", ")} and ${told.at(-1)}` : told[0]}`,
            tone: "meet",
          }
        : { title: "LUME had no one to tell", tone: "neutral" };
    }
    default:
      return { title: "LUME did something automatically", tone: "neutral" };
  }
}

const dueWords = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
