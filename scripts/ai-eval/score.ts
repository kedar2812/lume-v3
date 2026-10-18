import { createHash } from "node:crypto";
import { cleanNextStep, followUpMoment, type LeadFacts, type NextStep } from "../../packages/core/src/index";

/**
 * LUME AI's eval (plan 2026-10-18 Task 11): the cases as the facts LUME would send, and what counts as right. Pure:
 * no provider, no network. The pass marks are the plan's, before any client switches LUME AI on.
 */

/** Every case is read at the same moment: Wednesday 21 October 2026, 11:30 am in India. */
export const NOW = "2026-10-21T06:00:00.000Z";
export const MARKS = { stage: 0.9, followUp: 0.9 } as const;

export type Business = {
  timezone: string;
  stages: { key: string; name: string; kind: "open" | "won" | "lost" }[];
  lostReasons: { key: string; label: string }[];
  tags: { key: string; label: string }[];
};
export type Businesses = Record<string, Business>;
type Key = string | null;
type HistoryItem = { daysAgo: number; kind: LeadFacts["history"][number]["kind"]; text: string };
export type Expect = {
  /** The stage to move to by key, null to stay; or the ones that are all right. */
  stage: Key | Key[];
  /** Checked only when the answer moves the lead to a lost stage. */
  lostReason?: Key[];
  /** "any": the note leaves it open. null: no follow-up. Days are on the business's clock. */
  followUp: "any" | null | { on?: string[]; between?: [string, string]; at?: string; orNone?: boolean };
  /** The tags by key: one set, or the sets that are all right. */
  tags: string[] | string[][];
};
export type NextStepCase = {
  id: string;
  business: string;
  firstName: string;
  stage: string;
  fields?: { label: string; value: string }[];
  history?: HistoryItem[];
  note: string;
  expect: Expect;
};
export type CatchUpCase = Omit<NextStepCase, "note" | "expect">;

/** A real-looking UUID for a business's key (v5-shaped, the same every run): the model sees ids like LUME's. */
export function idOf(business: string, key: string): string {
  const h = createHash("sha1").update(`lume-eval:${business}:${key}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The facts LUME would send for a case, and the way back from an id to the case's key. */
export function factsFor(
  c: CatchUpCase,
  businesses: Businesses,
): { facts: LeadFacts; keyOf(id: string | null): string | null } {
  const b = businesses[c.business];
  if (!b) throw new Error(`${c.id}: no business "${c.business}"`);
  const keys = new Map<string, string>();
  const id = (key: string) => {
    const v = idOf(c.business, key);
    keys.set(v, key);
    return v;
  };
  const stages = b.stages.map((s) => ({ id: id(s.key), name: s.name, kind: s.kind }));
  const stage = stages.find((s) => keys.get(s.id) === c.stage);
  if (!stage) throw new Error(`${c.id}: no stage "${c.stage}"`);
  const now = Date.parse(NOW);
  return {
    facts: {
      firstName: c.firstName,
      stage: { id: stage.id, name: stage.name },
      stages,
      lostReasons: b.lostReasons.map((r) => ({ id: id(r.key), label: r.label })),
      tags: b.tags.map((t) => ({ id: id(t.key), label: t.label })),
      fields: c.fields ?? [],
      history: (c.history ?? []).map((h) => ({
        at: new Date(now - h.daysAgo * 86_400_000).toISOString(),
        kind: h.kind,
        text: h.text,
      })),
      timezone: b.timezone,
      now: NOW,
    },
    keyOf: (v) => (v === null ? null : (keys.get(v) ?? null)),
  };
}

export type NextStepScore = {
  id: string;
  stage: boolean;
  followUp: boolean;
  lostReason: boolean;
  tags: boolean;
  /** A follow-up before now after the cleaner: must never happen. */
  past: boolean;
  /** Ids the business doesn't have, in the provider's own answer (before the cleaner). */
  invented: number;
  /** …and after it: must be 0. */
  inventedAfter: number;
  cleaned: NextStep;
};

const anyOf = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** One answer against its case: each field on the cleaned answer (what the person would see), ids on both. */
export function scoreNextStep(
  c: NextStepCase,
  raw: NextStep,
  { facts, keyOf }: ReturnType<typeof factsFor>,
): NextStepScore {
  const cleaned = cleanNextStep(raw, facts);
  const known = (v: string | null) => v === null || keyOf(v) !== null;
  const ids = (n: NextStep) => [n.stageId, n.lostReasonId, ...n.tagIds].filter((v) => !known(v)).length;

  // Staying put may be said as null or as the stage the lead is at.
  const to = cleaned.stageId === facts.stage.id ? null : keyOf(cleaned.stageId);
  const stage = anyOf(c.expect.stage).includes(to);
  const lostStage = facts.stages.find((s) => s.id === cleaned.stageId)?.kind === "lost";
  const lostReason = lostStage
    ? (c.expect.lostReason ?? [null]).includes(keyOf(cleaned.lostReasonId))
    : cleaned.lostReasonId === null;

  const f = c.expect.followUp;
  const at = cleaned.followUp?.at ?? null;
  const day = at?.slice(0, 10) ?? null;
  const followUp =
    f === "any"
      ? true
      : f === null
        ? at === null
        : day === null
          ? f.orNone === true
          : (f.on ? f.on.includes(day) : true) &&
            (f.between ? day >= f.between[0] && day <= f.between[1] : true) &&
            (f.at ? at!.slice(11) === f.at : true);

  const want = c.expect.tags;
  const sets = want.length && Array.isArray(want[0]) ? (want as string[][]) : [want as string[]];
  const got = cleaned.tagIds.map((t) => keyOf(t)!);
  const past =
    cleaned.followUp !== null &&
    followUpMoment(cleaned.followUp, facts.timezone).getTime() <= Date.parse(NOW);

  return {
    id: c.id,
    stage,
    followUp,
    lostReason,
    tags: sets.some((s) => sameSet(s, got)),
    past,
    invented: ids(raw),
    inventedAfter: ids(cleaned),
    cleaned,
  };
}

/** Each field as a share of the cases, and whether LUME's marks are met. */
export function summarize(scores: NextStepScore[]) {
  const share = (k: "stage" | "followUp" | "lostReason" | "tags") =>
    scores.length ? Math.round((scores.filter((s) => s[k]).length / scores.length) * 1000) / 1000 : 0;
  const past = scores.filter((s) => s.past).length;
  const inventedAfter = scores.reduce((n, s) => n + s.inventedAfter, 0);
  const r = {
    cases: scores.length,
    stage: share("stage"),
    followUp: share("followUp"),
    lostReason: share("lostReason"),
    tags: share("tags"),
    past,
    invented: scores.reduce((n, s) => n + s.invented, 0),
    inventedAfter,
  };
  return {
    ...r,
    pass: r.stage >= MARKS.stage && r.followUp >= MARKS.followUp && past === 0 && inventedAfter === 0,
  };
}

/** Numbers in catch-up lines that the lead's history doesn't have: each one is checked by hand. */
export function ungrounded(lines: string[], history: string): string[] {
  const have = new Set(history.match(/\d+(?:\.\d+)?/g) ?? []);
  return lines.flatMap((l) => l.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => !have.has(n));
}
