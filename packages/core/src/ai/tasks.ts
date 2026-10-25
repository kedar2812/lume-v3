import { z } from "zod";
import { wallTime } from "../tasks/time";

/**
 * LUME AI's tasks (spec 2026-10-18 §2.1, §5.2–5.4): what each one is given, what it must answer, and the rules
 * that hold whichever provider reads it. Pure: no provider, no database.
 */
/** The read-a-note tasks (2026-10-18), and Autopilot's (2026-10-19): each counts against the month. */
export type AiTask = "next_step" | "catch_up" | "autopilot_first" | "autopilot_reply" | "reply_meaning";
type NoteTask = "next_step" | "catch_up";

/**
 * What LUME AI may know about a lead: only facts from its record and the business's own settings. There is no
 * place here for a phone, an email, a web address or an Instagram handle (§5.4).
 */
export type LeadFacts = {
  firstName: string;
  stage: { id: string; name: string };
  stages: { id: string; name: string; kind: "open" | "won" | "lost" }[];
  lostReasons: { id: string; label: string }[];
  tags: { id: string; label: string }[];
  fields: { label: string; value: string }[];
  /** Oldest first. Trimmed by `trimHistory` before it's sent. */
  history: { at: string; kind: "note" | "call" | "stage" | "follow_up"; text: string }[];
  timezone: string;
  /** The moment of the read (ISO), so "Thursday" means the next Thursday from here. */
  now: string;
};

const HISTORY_ITEMS = 20;
const HISTORY_CHARS = 4000;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export const nextStepOutput = z
  .object({
    /** One plain line on what the note means, shown above the suggestion. */
    summary: z.string().min(1).max(140),
    stageId: z.string().nullable(),
    /** On the business's clock, "YYYY-MM-DDTHH:mm". */
    followUp: z
      .object({ at: z.string(), title: z.string().min(1).max(80) })
      .strict()
      .nullable(),
    lostReasonId: z.string().nullable(),
    /** The business's own tags stand for objections and segments (§5.2): at most three. */
    tagIds: z.array(z.string()).max(3),
    decisionMaker: z.string().min(1).max(60).nullable(),
  })
  .strict();
export type NextStep = z.infer<typeof nextStepOutput>;

export const catchUpOutput = z
  .object({
    lines: z.tuple([z.string().min(1).max(160), z.string().min(1).max(160), z.string().min(1).max(160)]),
  })
  .strict();
export type CatchUp = z.infer<typeof catchUpOutput>;

const RULES = `Use only the facts given below about this lead and this business. Never invent prices, dates, offers, \
names, numbers or urgency that the facts don't contain. If you are unsure of something, leave it out (null) rather \
than guess. Write plain, short English, whatever language the notes are in.`;

const INSTRUCTIONS: Record<NoteTask, string> = {
  next_step: `You help a salesperson decide the next step on a lead after a call or a note. ${RULES}
Answer with:
- summary: one line on what the note means for the sale.
- stageId: the stage the lead should move to now, or null to leave it where it is. Use ids only from the lists given.
- followUp: when to contact the lead next, as local time "YYYY-MM-DDTHH:mm" on the business's clock after "now", \
with a short title; null when the note names no time and none is clearly needed.
- lostReasonId: only when the stage you chose is a lost one; an id from lostReasons, or null.
- tagIds: up to three ids from tags that the note clearly supports (an objection, a segment); usually none.
- decisionMaker: who else decides, when the note names them ("her husband"); otherwise null.`,
  catch_up: `You catch a salesperson up on a lead they are picking up. ${RULES}
Answer with exactly three lines: who the lead is and what they want; where the sale stands now; what was promised \
or is due next. Each line at most 160 characters.`,
};

export function instructionsFor(task: NoteTask): string {
  return INSTRUCTIONS[task];
}

/** The newest `HISTORY_ITEMS` items whose texts fit in `HISTORY_CHARS`, oldest first; older ones go first. */
export function trimHistory(history: LeadFacts["history"]): LeadFacts["history"] {
  const kept: LeadFacts["history"] = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0 && kept.length < HISTORY_ITEMS; i--) {
    const item = history[i]!;
    if (chars + item.text.length > HISTORY_CHARS) break;
    chars += item.text.length;
    kept.unshift(item);
  }
  return kept;
}

/** What the provider reads: the facts as compact JSON, then the note this read is about (if any). */
export function inputFor(task: AiTask, facts: LeadFacts, note?: string): string {
  const body = JSON.stringify({ task, lead: { ...facts, history: trimHistory(facts.history) } });
  return note === undefined ? body : `${body}\n\nThe note:\n${note}`;
}

/** "YYYY-MM-DDTHH:mm" on `tz` as a moment, or null when it isn't a real date and time. */
function localMoment(local: string, tz: string): Date | null {
  const m = LOCAL.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const at = wallTime(y, mo, d, h, mi, tz);
  // A day past the month's end (Feb 30) rolls over: not the date that was written.
  const back = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return back === `${m[1]}-${m[2]}-${m[3]}` ? at : null;
}

/**
 * What the business can actually apply (§5.4, plan Review Focus 1–2): ids only from its own lists, a lost reason
 * only with a lost stage, each tag once, and a follow-up only when it's a real time after now.
 */
export function cleanNextStep(out: NextStep, facts: LeadFacts): NextStep {
  const stage = facts.stages.find((s) => s.id === out.stageId) ?? null;
  const lostReasonId =
    stage?.kind === "lost" && facts.lostReasons.some((r) => r.id === out.lostReasonId)
      ? out.lostReasonId
      : null;
  const known = new Set(facts.tags.map((t) => t.id));
  const tagIds = [...new Set(out.tagIds)].filter((id) => known.has(id)).slice(0, 3);
  const at = out.followUp ? localMoment(out.followUp.at, facts.timezone) : null;
  const followUp = out.followUp && at && at.getTime() > new Date(facts.now).getTime() ? out.followUp : null;
  return { ...out, stageId: stage?.id ?? null, lostReasonId, tagIds, followUp };
}

/** The moment a cleaned follow-up is due (it parsed in `cleanNextStep`, so it parses here). */
export function followUpMoment(followUp: NonNullable<NextStep["followUp"]>, tz: string): Date {
  const at = localMoment(followUp.at, tz);
  if (!at) throw new Error("followUpMoment: not a cleaned follow-up");
  return at;
}
