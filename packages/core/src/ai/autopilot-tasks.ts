import { z } from "zod";
import { isStop, unbackedAmounts } from "./autopilot";
import type { FillableType } from "./fill-fields";
import type { AiProfile, AutopilotAction } from "./profile";

/**
 * What LUME AI is asked during a run (Autopilot spec 2026-10-19 §1.3, §3), and the guards every answer passes before
 * anything is sent (§0 anti-goals, §11). Pure: no provider, no database.
 */
export type AutopilotTask = "autopilot_first" | "autopilot_reply";

/** Each action as people read it (§1.3; the start sheet as approved), for words that name one. */
export const AUTOPILOT_ACTION_TITLES: Record<AutopilotAction, string> = {
  first_messages: "Send first messages",
  follow_ups: "Follow up when there's no reply",
  replies: "Reply and keep the conversation going",
  send_files: "Send files",
  book_meetings: "Book meetings",
  move_stages: "Move leads along your pipeline",
  set_follow_ups: "Set follow-up reminders",
  fill_fields: "Fill in lead details",
  answer_prices: "Answer price questions",
  mark_lost: "Mark a lead lost",
  hand_to_rep: "Hand a lead to a rep",
};

/** Everything a run's read is given: the business's own words and lists, and the lead's thread. Never a phone or an
 * email: LUME AI writes to the lead through LUME, it never needs their address. */
export type AutopilotCtx = {
  business: string;
  speaker: string;
  goal: { kind: "stage"; stage: string } | { kind: "reply" } | { kind: "brief"; text: string };
  profile: AiProfile;
  currency: string;
  lead: { firstName: string; stage: string; fields: { label: string; value: string }[] };
  /** Oldest first, the newest 30 at most. */
  thread: { from: "lead" | "business"; at: string; text: string }[];
  /** For a first message or a follow-up: the approved templates this lead's values can fill. */
  templates: { id: string; name: string; body: string }[];
  /** The files chosen in Settings → LUME AI that can still be sent. */
  files: { id: string; name: string }[];
  /** The lead's own pipeline: its open stages and its lost one (won is reached by converting, never set). */
  stages: { id: string; name: string; kind: "open" | "lost" }[];
  /** The business's live lost reasons, for a lead marked lost. */
  lostReasons: { id: string; label: string }[];
  /** The lead's empty fields LUME AI may fill, by key; a choice by its options' labels. */
  fillable: { key: string; label: string; type: FillableType; options: string[] }[];
  now: string;
  timezone: string;
};

export const autopilotFirstOutput = z.object({ templateId: z.uuid(), why: z.string().max(200) }).strict();
export type AutopilotFirst = z.infer<typeof autopilotFirstOutput>;

export const autopilotReplyOutput = z
  .object({
    kind: z.enum(["reply", "handover", "stop", "converted"]),
    message: z.string().max(1000).nullable(),
    reason: z.string().max(200),
    /** The lead's own words that show it (a converted lead, or why a person is needed). */
    evidence: z.string().max(300).nullable(),
    fileIds: z.array(z.uuid()).max(3),
    stageId: z.uuid().nullable(),
    fields: z.record(z.string(), z.string().max(200)),
    /** On the business's clock, "YYYY-MM-DDTHH:mm". */
    followUp: z
      .object({ at: z.string(), title: z.string().min(1).max(80) })
      .strict()
      .nullable(),
    lostReasonId: z.uuid().nullable(),
  })
  .strict();
export type AutopilotReply = z.infer<typeof autopilotReplyOutput>;

const TONE = {
  warm: "warm and friendly, like a helpful person at the business",
  formal: "polite and formal",
  casual: "relaxed and casual, still professional",
} as const;

function goalWords(g: AutopilotCtx["goal"]): string {
  if (g.kind === "stage") return `get the lead to "${g.stage}"`;
  if (g.kind === "reply") return "get a reply from the lead";
  return `this brief from the business: ${g.text}`;
}

/**
 * The instructions for a run's read: the business's own knowledge, voice and rules, the goal, and the rules that hold
 * whatever the business wrote (§3): stop means stop; anything risky goes to a person; never invent a price, a date, a
 * discount or a promise; never deny being AI.
 */
export function autopilotInstructions(task: AutopilotTask, c: AutopilotCtx): string {
  const p = c.profile;
  const knows = [
    p.knows.about && `About the business: ${p.knows.about}`,
    p.knows.faqs.length &&
      `Questions and answers:\n${p.knows.faqs.map((f) => `Q: ${f.q}\nA: ${f.a}`).join("\n")}`,
    `Price list (${c.currency}), the only prices you may ever give:\n${
      p.knows.prices
        .map((x) => `- ${x.item}: ${x.price} ${x.unit}${x.notes ? ` (${x.notes})` : ""}`)
        .join("\n") || "- none: never give a price"
    }`,
    p.knows.neverSay.length && `Never say:\n${p.knows.neverSay.map((x) => `- ${x}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const bot =
    p.standing.botQuestion === "say_so"
      ? `If the lead asks whether they are talking to a bot or AI, say honestly that you are LUME AI, writing for ${c.speaker} at ${c.business}.`
      : `If the lead asks whether they are talking to a bot or AI, answer with kind handover.`;
  const voice = `Write as ${c.speaker} from ${c.business}, ${TONE[p.voice.tone]}. ${
    p.voice.language === "match_lead"
      ? "Write in the language the lead writes in."
      : `Write in this language: ${p.voice.language}.`
  }${p.voice.signOff ? ` Sign off as "${p.voice.signOff}".` : ""} Keep messages short, like a WhatsApp message.`;
  const rules = `Rules that always hold:
- Use only the facts given. Never invent a price, discount, date, time, offer or promise that isn't given.
- If the lead says stop or not interested in any words, answer with kind stop and no message.
- If the lead complains, is upset, asks for a person, or asks for legal, medical or financial advice, or anything you \
aren't sure of, answer with kind handover, the reason in one line, and the lead's own words as evidence.
- When the goal is reached, answer with kind converted, the reason, and the lead's own words as evidence.
- ${bot}`;
  const what =
    task === "autopilot_first"
      ? "Choose the one approved template that best fits this lead and the goal. Answer with its templateId and why."
      : `Write the next WhatsApp message to the lead toward the goal (${goalWords(c.goal)}). Answer with kind reply and \
the message, or another kind as the rules say. You may attach up to three of the files given by id; set stageId to one \
of the stages given by id when the conversation has moved the lead there; when the lead has said no, the lost stage with \
a lostReasonId from the lost reasons given; fill only the empty fields given, by key, from what the lead said (a choice \
by one of its options, a number as digits, a date as YYYY-MM-DD); and suggest a follow-up.`;
  return `You are LUME AI, messaging a business's lead on WhatsApp. The goal: ${goalWords(c.goal)}.
${voice}

${knows}

${rules}

${what}`;
}

/** What the provider reads: the lead, the thread and the business's lists, as compact JSON. */
export function autopilotInput(task: AutopilotTask, c: AutopilotCtx): string {
  return JSON.stringify({
    task,
    now: c.now,
    timezone: c.timezone,
    lead: c.lead,
    thread: c.thread.slice(-30),
    ...(task === "autopilot_first"
      ? { templates: c.templates }
      : { files: c.files, stages: c.stages, lostReasons: c.lostReasons, fillable: c.fillable }),
  });
}

const DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow";
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec";
const TIME_RE = new RegExp(
  String.raw`\b(?:${DAYS})\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)\b|\b(?:${MONTHS})[a-z]*\b`,
  "gi",
);
const tidyTime = (s: string) => s.toLowerCase().replace(/\s+(am|pm)\b/g, "$1");

/** The days, dates and times a message names ("tomorrow", "10:30 am", "24th", "oct"), lower-cased, in order. */
export function timesIn(text: string): string[] {
  return [...text.matchAll(TIME_RE)].map((m) => {
    const t = m[0].toLowerCase();
    const month = new RegExp(String.raw`^(${MONTHS})`).exec(t);
    return /^\d/.test(t) || !month ? t : month[1]!;
  });
}

/** What the guards check an answer against: the business's own lists and the run's permissions. */
export type GuardCtx = {
  prices: number[];
  fileIds: string[];
  /** The lead's own recent messages, joined: a time may be confirmed only when they named it. */
  leadWords: string;
  lastLeadMessage: string;
  permissions: Record<AutopilotAction, "go" | "ask" | "never">;
  openStageIds: string[];
  lostStageIds: string[];
  lostReasonIds: string[];
  fieldKeys: string[];
};
export type ReplyUpdates = {
  stageId: string | null;
  fields: Record<string, string>;
  followUp: { at: string; title: string } | null;
  lostReasonId: string | null;
};
export type GuardedReply =
  | { kind: "send"; message: string; fileIds: string[]; updates: ReplyUpdates }
  | { kind: "ask"; action: AutopilotAction; message: string; fileIds: string[]; updates: ReplyUpdates }
  | { kind: "handover"; reason: string; evidence: string | null }
  | { kind: "stop" }
  | { kind: "converted"; reason: string; evidence: string | null };

const handover = (reason: string, evidence: string | null = null): GuardedReply => ({
  kind: "handover",
  reason,
  evidence,
});
const neverSays = (a: AutopilotAction) => handover(`"${AUTOPILOT_ACTION_TITLES[a]}" is set to Never.`);

/**
 * The guards on a reply (§0, §1.3, §3, §11), whatever the model said: the lead's stop wins; an amount not in the price
 * list, or a time the lead didn't name, is never sent; files only from those chosen; updates only to the business's own
 * stages, fields and lost reasons; an action set to Never hands over (or, for files and updates, is dropped), one set to
 * Ask me waits for a tap.
 */
export function guardReply(out: AutopilotReply, g: GuardCtx): GuardedReply {
  if (isStop(g.lastLeadMessage) || out.kind === "stop") return { kind: "stop" };
  if (out.kind === "handover") return handover(out.reason, out.evidence);
  if (out.kind === "converted") return { kind: "converted", reason: out.reason, evidence: out.evidence };
  const message = out.message?.trim() ?? "";
  if (!message) return handover("LUME AI had nothing to say to this one.");
  const perms = g.permissions;
  if (perms.replies === "never") return neverSays("replies");

  const amounts = unbackedAmounts(message, g.prices);
  if (amounts.length) return handover("LUME AI wanted to quote a price that isn't in your price list.");
  const priced = unbackedAmounts(message, []).length > 0;
  if (priced && perms.answer_prices === "never") return neverSays("answer_prices");
  const lead = tidyTime(g.leadWords);
  if (timesIn(message).some((t) => !lead.includes(tidyTime(t))))
    return handover("LUME AI wanted to offer a time you haven't given it.");

  const asks: AutopilotAction[] = [];
  const allowed = (a: AutopilotAction) => {
    if (perms[a] === "never") return false;
    if (perms[a] === "ask") asks.push(a);
    return true;
  };
  if (perms.replies === "ask") asks.push("replies");
  if (priced && perms.answer_prices === "ask") asks.push("answer_prices");
  const chosen = out.fileIds.filter((f, i, all) => g.fileIds.includes(f) && all.indexOf(f) === i);
  const fileIds = chosen.length && allowed("send_files") ? chosen : [];

  const lost = !!out.stageId && g.lostStageIds.includes(out.stageId);
  const stageKnown = !!out.stageId && (g.openStageIds.includes(out.stageId) || lost);
  const reasonKnown = !!out.lostReasonId && g.lostReasonIds.includes(out.lostReasonId);
  let stageId: string | null = null;
  let lostReasonId: string | null = null;
  if (stageKnown && lost) {
    // Marking lost needs one of the business's reasons.
    if (reasonKnown && allowed("mark_lost")) [stageId, lostReasonId] = [out.stageId, out.lostReasonId];
  } else if (stageKnown && allowed("move_stages")) stageId = out.stageId;
  const fieldEntries = Object.entries(out.fields).filter(([k]) => g.fieldKeys.includes(k));
  const fields = fieldEntries.length && allowed("fill_fields") ? Object.fromEntries(fieldEntries) : {};
  const followUp = out.followUp && allowed("set_follow_ups") ? out.followUp : null;

  const updates: ReplyUpdates = { stageId, fields, followUp, lostReasonId };
  // One tap for the most careful thing waiting: losing a lead, then prices, then the rest.
  const order: AutopilotAction[] = [
    "mark_lost",
    "answer_prices",
    "replies",
    "send_files",
    "move_stages",
    "fill_fields",
    "set_follow_ups",
  ];
  const action = order.find((a) => asks.includes(a));
  return action
    ? { kind: "ask", action, message, fileIds, updates }
    : { kind: "send", message, fileIds, updates };
}

/** A first message or a follow-up is one of the approved templates offered, never anything else. */
export function guardFirst(out: AutopilotFirst, offered: string[]): string | null {
  return offered.includes(out.templateId) ? out.templateId : null;
}
