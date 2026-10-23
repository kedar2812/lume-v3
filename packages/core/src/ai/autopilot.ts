import { shiftToWorkingHours, type WorkingHours } from "../tasks/time";

/**
 * Autopilot's rules (spec 2026-10-19 §1–§3, §6): what a run does next with a lead, how fast it may send on the business's
 * clock, when a lead has said stop, and which amounts a message names. Pure: the engine (apps/api) acts on them.
 */

export type RunStatus = "running" | "paused" | "ended";
/** Why a run is paused: the person, the month's LUME AI, the number's quality, the speaker gone, the number gone, the
 * month's paid WhatsApp messages. */
export type PauseReason = "person" | "month" | "quality" | "speaker" | "number" | "paid";
export type LeadState =
  | "up_next"
  | "writing"
  | "sent"
  | "replied"
  | "talking"
  | "ready"
  | "needs_you"
  | "stopped"
  | "with_you"
  | "skipped";
/** The states a run still works; the rest wait on a person, or are over. */
export const ACTIVE_STATES: readonly LeadState[] = ["up_next", "writing", "sent", "replied", "talking"];

export type Move =
  | { kind: "first" }
  | { kind: "follow_up"; n: number }
  | { kind: "reply" }
  | { kind: "wait"; until: Date | null }
  | { kind: "done" };

const DAY_MS = 86_400_000;
/** WhatsApp's window for free text after the lead's last message (§3, §6). */
export const WINDOW_MS = DAY_MS;
/** Never closer than this between two sends on a run (§6: paced, never a burst). */
export const MIN_GAP_MS = 20_000;
/** A number whose tier LUME hasn't read yet is treated as a new one (§6: new numbers start slow). */
const NEW_NUMBER_TIER = 250;

/** Whether a free reply may still go: within 24 hours of the lead's last message. */
export function windowOpen(lastInboundAt: Date | null, now: Date): boolean {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}

/**
 * What a run does next with a lead (§1.3, §3): its first message; a reply while the lead's message is unanswered and the
 * 24 hours are open; otherwise the next follow-up on its day, counted from the first message or, once the lead has
 * written, from their last message; after the last follow-up, done. A lead that's writing, waiting on a person, with a
 * person, stopped or skipped is left alone.
 */
export function nextMove(
  l: {
    state: LeadState;
    firstSentAt: Date | null;
    lastSentAt: Date | null;
    lastInboundAt: Date | null;
    followUpsSent: number;
  },
  o: { now: Date; followUpDays: number[] },
): Move {
  if (l.state === "writing" || !ACTIVE_STATES.includes(l.state)) return { kind: "wait", until: null };
  if (!l.firstSentAt) return { kind: "first" };
  const unanswered = !!l.lastInboundAt && (!l.lastSentAt || l.lastInboundAt > l.lastSentAt);
  if (unanswered && windowOpen(l.lastInboundAt, o.now)) return { kind: "reply" };
  if (l.followUpsSent >= o.followUpDays.length) return { kind: "done" };
  const anchor = l.lastInboundAt && l.lastInboundAt > l.firstSentAt ? l.lastInboundAt : l.firstSentAt;
  const due = new Date(anchor.getTime() + o.followUpDays[l.followUpsSent]! * DAY_MS);
  return o.now >= due ? { kind: "follow_up", n: l.followUpsSent + 1 } : { kind: "wait", until: due };
}

/**
 * How many more a run may send today (§1.2, §6): the lower of the number's Meta tier and the business's cap, less what
 * already went today. A tier not read yet counts as a new number's 250; an unlimited tier with no cap has no limit.
 */
export function dailyBudget(o: {
  tierLimit: number | "unlimited" | null;
  cap: number | null;
  sentToday: number;
}): number {
  const tier = o.tierLimit === null ? NEW_NUMBER_TIER : o.tierLimit === "unlimited" ? Infinity : o.tierLimit;
  return Math.max(0, Math.min(tier, o.cap ?? Infinity) - o.sentToday);
}

/** Minutes and seconds into the day on the business's clock. */
function clockOf(d: Date, tz: string): { min: number; sec: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return { min: Number(p.hour) * 60 + Number(p.minute), sec: Number(p.second) };
}

/**
 * When a run's next send may go (§1.2, §6): inside the business's working hours, the budget left spread over the hours
 * left today and never closer than `MIN_GAP_MS` to the last send; outside the hours, or with nothing left for today,
 * the next working day's start.
 */
export function nextSendAt(o: {
  now: Date;
  wh: WorkingHours;
  tz: string;
  budgetLeft: number;
  lastSentAt: Date | null;
}): Date {
  const start = shiftToWorkingHours(o.now, o.wh, o.tz);
  if (start.getTime() !== o.now.getTime()) return start;
  const [eh, em] = o.wh.end.split(":").map(Number) as [number, number];
  const c = clockOf(o.now, o.tz);
  const endToday = new Date(
    o.now.getTime() + ((eh * 60 + em - c.min) * 60 - c.sec) * 1000 - o.now.getMilliseconds(),
  );
  const nextDay = shiftToWorkingHours(endToday, o.wh, o.tz);
  if (o.budgetLeft <= 0) return nextDay;
  const gap = Math.max(MIN_GAP_MS, (endToday.getTime() - o.now.getTime()) / o.budgetLeft);
  const at = o.lastSentAt ? Math.max(o.now.getTime(), o.lastSentAt.getTime() + gap) : o.now.getTime();
  return at >= endToday.getTime() ? nextDay : new Date(at);
}

/** How long the screen takes to reveal a message as it's written: reading speed, within 1.5 and 9 seconds (§2). */
export function revealMs(text: string): number {
  return Math.min(9_000, Math.max(1_500, text.length * 28));
}

/** A whole message that's only this is a stop ("Stop!", "STOP"). */
const STOP_ALONE = new Set(["stop", "unsubscribe", "stop please", "please stop", "stop it", "توقف", "بس"]);
/** Phrases that say stop wherever they are in a message, in the languages LUME's businesses meet most. */
const STOP_PHRASES = [
  "please stop",
  "stop messaging",
  "stop sending",
  "stop texting",
  "stop contacting",
  "unsubscribe",
  "not interested",
  "no longer interested",
  "dont message",
  "don't message",
  "do not message",
  "dont text",
  "don't text",
  "do not text",
  "dont contact",
  "don't contact",
  "do not contact",
  "no more messages",
  "remove me",
  "take me off",
  "leave me alone",
  "band karo",
  "mat bhejo",
  "message mat",
  "nahi chahiye",
  "توقف",
  "لا تراسلني",
  "no me escribas",
  "deja de escribir",
  "no me interesa",
  "ne m'écrivez plus",
  "pas intéressé",
];

/**
 * Whether a lead's message says stop (§3: stop means stop, in any words). Conservative on purpose: "stop" alone is a
 * stop, "can you stop by?" isn't. The model judges too; this check wins whatever it says.
 */
export function isStop(text: string): boolean {
  const norm = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (STOP_ALONE.has(norm)) return true;
  const padded = ` ${norm} `;
  return STOP_PHRASES.some((p) => padded.includes(` ${p} `));
}

const NUM = String.raw`(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const MUL: Record<string, number> = {
  k: 1e3,
  l: 1e5,
  lac: 1e5,
  lacs: 1e5,
  lakh: 1e5,
  lakhs: 1e5,
  cr: 1e7,
  crore: 1e7,
  crores: 1e7,
};
const MUL_WORDS = String.raw`(k|lakhs?|lacs?|crores?|cr|l)`;
/** In order: a currency then a number (and a multiplier); a number and a multiplier; a number then a currency word; a
 * grouped number ("3,80,000"). Bare numbers (a year, a count, a phone number) are never amounts. */
const AMOUNT_RES = [
  new RegExp(
    String.raw`(?:₹|\$|€|£|(?<![\p{L}])(?:rs\.?|inr|aed|usd|eur|gbp))\s*${NUM}\s*(?:${MUL_WORDS}\b)?`,
    "giu",
  ),
  new RegExp(String.raw`${NUM}\s*${MUL_WORDS}\b`, "giu"),
  new RegExp(String.raw`${NUM}\s*(?:aed|inr|usd|rupees|dirhams)\b`, "giu"),
  new RegExp(String.raw`(?<![\d+])(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?)`, "gu"),
];

/** The amounts a message names, as people write them (₹3,80,000, Rs 1.2 lakh, AED 1,150.50, 15k), in order. */
export function amountsIn(text: string): number[] {
  let rest = text.toLowerCase();
  const found: { at: number; value: number }[] = [];
  for (const re of AMOUNT_RES) {
    rest = rest.replace(re, (...args: unknown[]) => {
      // replace() passes the match, each group, then the offset: patterns here have one group or two.
      const m = args[0] as string;
      const offset = args.findIndex((x, i) => i > 0 && typeof x === "number");
      const [num, mul] = args.slice(1, offset) as [string, string | undefined];
      const at = args[offset] as number;
      const v = Number(num.replace(/,/g, "")) * (mul ? (MUL[mul.toLowerCase()] ?? 1) : 1);
      found.push({ at, value: Math.round(v * 100) / 100 });
      return " ".repeat(m.length);
    });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.value);
}

/** The amounts a message names that aren't in the business's price list (§11): such a message never goes. */
export function unbackedAmounts(text: string, prices: number[]): number[] {
  return amountsIn(text).filter((a) => !prices.some((p) => Math.abs(p - a) < 0.005));
}
