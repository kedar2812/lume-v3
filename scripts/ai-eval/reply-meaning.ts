import { cleanReplyMeaning, type ReplyMeaning, type ReplyMeaningGroup } from "../../packages/core/src/index";
import { factsFor, NOW, type Businesses } from "./score";

/**
 * The reply-meaning eval (W2; spec 2026-10-18 §6.4): each WhatsApp reply as LUME would ask LUME AI, cleaned by LUME's own
 * cleaner, then scored. Pure: no provider, no network.
 */
export const MEANING_MARKS = { group: 0.85 } as const;

type Key = string | null;
export type MeaningCase = {
  id: string;
  business: string;
  firstName: string;
  stage: string;
  fields?: { label: string; value: string }[];
  /** Oldest first; minutes before the eval's moment. */
  thread: { from: "lead" | "business"; minsAgo: number; text: string }[];
  reply: string;
  expect: {
    group: ReplyMeaningGroup | ReplyMeaningGroup[];
    /** The lead asks not to be messaged: must never be missed. */
    stop?: true;
    stage?: Key | Key[];
    /** "any": either way. null: no follow-up. Days on the business's clock. */
    followUp?: "any" | null | { on?: string[]; orNone?: boolean };
  };
};

const anyOf = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

export function meaningCtx(c: MeaningCase, businesses: Businesses) {
  const f = factsFor(
    { id: c.id, business: c.business, firstName: c.firstName, stage: c.stage, fields: c.fields ?? [] },
    businesses,
  );
  const now = Date.parse(NOW);
  const thread = c.thread.map((m) => ({
    from: m.from,
    at: new Date(now - m.minsAgo * 60_000).toISOString(),
    text: m.text,
  }));
  return { ...f, thread };
}

export type MeaningScore = {
  id: string;
  group: boolean;
  stopMissed: boolean;
  stage: boolean;
  followUp: boolean;
  /** Ids the business doesn't have, in the provider's own answer; and after the cleaner (must be 0). */
  invented: number;
  inventedAfter: number;
  cleaned: ReplyMeaning;
};

export function scoreMeaning(
  c: MeaningCase,
  raw: ReplyMeaning,
  x: ReturnType<typeof meaningCtx>,
): MeaningScore {
  const cleaned = cleanReplyMeaning(raw, x.facts);
  const known = (v: string | null) => v === null || x.keyOf(v) !== null;
  const ids = (m: ReplyMeaning) => [m.stageId, m.lostReasonId].filter((v) => !known(v)).length;
  const e = c.expect;
  const to = cleaned.stageId === x.facts.stage.id ? null : x.keyOf(cleaned.stageId);
  const day = cleaned.followUp?.at.slice(0, 10) ?? null;
  const f = e.followUp;
  const followUp =
    f === undefined || f === "any"
      ? true
      : f === null
        ? day === null
        : day === null
          ? f.orNone === true
          : !f.on || f.on.includes(day);
  return {
    id: c.id,
    group: anyOf(e.group).includes(cleaned.meaning),
    stopMissed: !!e.stop && !cleaned.stop,
    stage: e.stage === undefined || anyOf(e.stage).includes(to),
    followUp,
    invented: ids(raw),
    inventedAfter: ids(cleaned),
    cleaned,
  };
}

type Scored = Pick<MeaningScore, "group" | "stopMissed" | "inventedAfter">;
export function summarizeMeaning(scores: Scored[]) {
  const group = scores.length
    ? Math.round((scores.filter((s) => s.group).length / scores.length) * 1000) / 1000
    : 0;
  const stopsMissed = scores.filter((s) => s.stopMissed).length;
  const inventedAfter = scores.reduce((n, s) => n + s.inventedAfter, 0);
  return {
    cases: scores.length,
    group,
    stopsMissed,
    inventedAfter,
    pass: group >= MEANING_MARKS.group && stopsMissed === 0 && inventedAfter === 0,
  };
}
