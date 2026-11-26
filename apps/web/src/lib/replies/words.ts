import { timeOf } from "../dates";
import type { ReplyBoardLead } from "./client";

/** The business's calendar day of a moment, as "2026-11-25". */
const dayKey = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

/** A day said as people say it: today, tomorrow, a weekday this week, else the date. */
export function dayWord(iso: string, now: Date, tz: string): string {
  const at = new Date(iso);
  const days = Math.round((Date.parse(dayKey(at, tz)) - Date.parse(dayKey(now, tz))) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz }).format(at);
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: tz }).format(at);
}

/** A moment ahead, as "today at 2:30 pm", "Tuesday at 2 am": the day alone can be a whole day off. */
export const whenWord = (iso: string, now: Date, tz: string) =>
  `${dayWord(iso, now, tz)} at ${timeOf(new Date(iso), tz)}`;

/**
 * Whether a reply still reaches them, in words (D6a, board Replies): time left while anyone may answer; on Instagram
 * after its 24 hours, until when a person may; when it's over, what still can.
 */
export function windowWords(
  l: Pick<ReplyBoardLead, "channel" | "window">,
  now: Date,
  tz: string,
): { text: string; tone: "ok" | "warn" | "quiet" } {
  const ig = l.channel === "instagram";
  const w = l.window;
  if (w.state === "open" && w.until) {
    const left = Date.parse(w.until) - now.getTime();
    const mins = Math.max(1, Math.ceil(left / 60_000));
    // From the same rounded minutes: 59½ minutes left is "1 hour", never "0 hours".
    const hours = Math.floor(mins / 60);
    const span =
      mins < 60
        ? `${mins} ${mins === 1 ? "minute" : "minutes"}`
        : hours > 24
          ? null
          : `${hours} ${hours === 1 ? "hour" : "hours"}`;
    const text = span
      ? ig
        ? `${span} left to answer`
        : `${span} left on WhatsApp`
      : `Open until ${whenWord(w.until, now, tz)}`;
    return { text, tone: mins < 60 ? "warn" : "ok" };
  }
  if (w.state === "human" && w.until)
    return {
      text: `Instagram’s 24 hours ended · a person can answer until ${whenWord(w.until, now, tz)}`,
      tone: "warn",
    };
  return ig
    ? { text: "Instagram’s window ended · they need to write first", tone: "quiet" }
    : { text: "WhatsApp’s 24 hours ended · an approved template can still reach them", tone: "quiet" };
}

/** Whose lead it is and where it came from; for a flow's hand-off, which flow asked for a person and why. */
export function aboutLine(l: Pick<ReplyBoardLead, "ownerName" | "source" | "flow">): string {
  const whose = l.ownerName ? `${l.ownerName}’s lead` : "Nobody’s lead yet";
  if (l.flow) return `${l.flow.name} asked for a person${l.flow.note ? `: ${l.flow.note}` : ""} · ${whose}`;
  return l.source ? `${whose} · ${l.source}` : whose;
}
