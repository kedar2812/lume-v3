import type { CalendlyLink } from "./client";
import type { CalendlySettings } from "./config";

/**
 * Whether LUME can book a link through Calendly's Scheduling API (owner 2026-11-27: "allow lume to schedule calls in
 * calendly"), and what a booking must send: Calendly refuses a link that takes payment, a required question left
 * blank, and a location kind the link doesn't have. LUME answers only what it knows: the lead's phone (for a call
 * Calendly makes, or the phone question set in Settings).
 */
export type BookingPlan =
  | {
      ok: true;
      /** The location to send: none (one person's link with none, or a team's), or one of the link's own. */
      location: { kind: string; fixed: string | null } | null;
      /** The booking needs the lead's phone: Calendly calls them (outbound_call), or the phone question is required. */
      needsPhone: boolean;
      /** The required phone question's exact words, to answer with the phone. */
      phoneQuestion: string | null;
    }
  | { ok: false; why: string };

/** Kinds Calendly fills in itself (a video link it makes, or the host's own number). */
const ITSELF = new Set([
  "google_conference",
  "zoom_conference",
  "microsoft_teams_conference",
  "webex_conference",
  "gotomeeting_conference",
  "inbound_call",
]);
/** Kinds whose place the link already says. */
const FIXED = new Set(["physical", "custom"]);

export function bookingPlan(l: CalendlyLink, s: CalendlySettings): BookingPlan {
  if (l.paid) return { ok: false, why: "It takes a payment, and Calendly doesn't let apps book those." };
  const asked = l.questions.filter((q) => q.enabled && q.required);
  const phoneQ = s.phoneQuestion ? (asked.find((q) => q.name === s.phoneQuestion) ?? null) : null;
  const other = asked.find((q) => q !== phoneQ);
  if (other) return { ok: false, why: `It asks "${other.name}", which LUME can't answer for a lead.` };
  let location: { kind: string; fixed: string | null } | null = null;
  let calls = false;
  if (!l.pooling && l.locations.length) {
    const pick =
      l.locations.find((x) => ITSELF.has(x.kind)) ??
      l.locations.find((x) => FIXED.has(x.kind) && x.location) ??
      l.locations.find((x) => x.kind === "outbound_call");
    if (!pick)
      return { ok: false, why: "It asks the invitee where to meet, which LUME can't answer for a lead." };
    calls = pick.kind === "outbound_call";
    location = { kind: pick.kind, fixed: FIXED.has(pick.kind) ? pick.location : null };
  }
  return { ok: true, location, needsPhone: calls || !!phoneQ, phoneQuestion: phoneQ?.name ?? null };
}
