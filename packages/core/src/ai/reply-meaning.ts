import { z } from "zod";
import { cleanNextStep, trimHistory, type LeadFacts } from "./tasks";

/**
 * What a WhatsApp reply means (W2, spec 2026-10-18 §4.2, §5.1, §5.4): its group on the Who replied board, one line,
 * whether it asks LUME to stop, and a next step drawn only from what the business has. Pure: no provider, no database.
 */
export const REPLY_MEANINGS = [
  "interested",
  "price",
  "visit_or_call",
  "later",
  "not_interested",
  "stop",
  "wrong_number",
  "not_sure",
] as const;
export type ReplyMeaningGroup = (typeof REPLY_MEANINGS)[number];
export const REPLY_MEANING_WORDS: Record<ReplyMeaningGroup, string> = {
  interested: "Interested",
  price: "Asked the price",
  visit_or_call: "Wants a visit or call",
  later: "Later",
  not_interested: "Not interested",
  stop: "Stop messaging",
  wrong_number: "Wrong number",
  not_sure: "Not sure",
};

export const replyMeaningOutput = z
  .object({
    meaning: z.enum(REPLY_MEANINGS),
    /** One plain line on what the reply says, shown under it. */
    summary: z.string().min(1).max(140),
    /** The lead asks not to be messaged, in any words or language. */
    stop: z.boolean(),
    stageId: z.string().nullable(),
    /** On the business's clock, "YYYY-MM-DDTHH:mm": a time the lead named, or a sensible next contact. */
    followUp: z
      .object({ at: z.string(), title: z.string().min(1).max(80) })
      .strict()
      .nullable(),
    lostReasonId: z.string().nullable(),
  })
  .strict();
export type ReplyMeaning = z.infer<typeof replyMeaningOutput>;

export const replyMeaningInstructions = `You read a WhatsApp reply a lead sent to a business, and say what it means for \
the sale. Use only the facts given below about this lead and this business; never invent prices, dates, offers, names, \
numbers or urgency. The reply may be in any language or a mix (Hinglish, Arabic and others); write the summary in plain \
short English.
Answer with:
- meaning: one of interested (Interested: wants to go ahead or know more), price (Asked the price), visit_or_call \
(Wants a visit or call), later (Later: not now, come back another time), not_interested (Not interested), stop (Stop \
messaging: asks not to be messaged any more), wrong_number (Wrong number: not the person or not looking), not_sure \
(Not sure: anything else, or you can't tell).
- summary: one line on what the reply says.
- stop: true when the lead asks not to be messaged, in any words; then meaning is stop. Otherwise false.
- stageId: the stage the lead should move to now, or null to leave it; ids only from the lists given.
- followUp: when to contact the lead next, as local time "YYYY-MM-DDTHH:mm" on the business's clock after "now", with a \
short title: the time the lead named ("Saturday 11", "after Diwali" resolved to a real date), else null when none is \
clearly needed.
- lostReasonId: only when the stage you chose is a lost one; an id from lostReasons, or null.`;

/** The lead's facts, the newest WhatsApp messages around the reply, and the reply itself. */
export function replyMeaningInput(
  facts: LeadFacts,
  thread: { from: "lead" | "business"; at: string; text: string }[],
  reply: string,
): string {
  const body = JSON.stringify({
    task: "reply_meaning",
    lead: { ...facts, history: trimHistory(facts.history) },
    whatsapp: thread.slice(-12),
  });
  return `${body}\n\nThe reply:\n${reply}`;
}

/**
 * What the business can use (§5.4): ids only from its own lists, a lost reason only with a lost stage, a follow-up
 * only at a real time after now; a stop is the Stop messaging group with nothing else suggested.
 */
export function cleanReplyMeaning(out: ReplyMeaning, facts: LeadFacts): ReplyMeaning {
  const stop = out.stop || out.meaning === "stop";
  if (stop) return { ...out, meaning: "stop", stop: true, stageId: null, followUp: null, lostReasonId: null };
  const step = cleanNextStep(
    {
      summary: out.summary,
      stageId: out.stageId,
      followUp: out.followUp,
      lostReasonId: out.lostReasonId,
      tagIds: [],
      decisionMaker: null,
    },
    facts,
  );
  return { ...out, stageId: step.stageId, followUp: step.followUp, lostReasonId: step.lostReasonId };
}
