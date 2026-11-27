import {
  AUTOPILOT_ACTIONS,
  can,
  hoursLine,
  tierAllows,
  tierLimitOf,
  tierName,
  tiersWith,
  type Allow,
  type AutopilotAction,
} from "@lume/core";
import { schema } from "@lume/db";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { aiStatus } from "../ai/service";
import { availabilityOf, openStages, readAiProfile, speakers, type Available } from "../ai/profile";
import { workingHoursFrom } from "../settings/follow-ups";
import { replyOn } from "../whatsapp/send";
import { pickNumber, sendableNumbers, type SendableNumber } from "../whatsapp/send-from";

const N = schema.whatsappNumbers;

export type ReadyCode =
  "AI_OFF" | "AI_MONTH" | "AI_LEADS" | "REPLY_OFF" | "NO_NUMBER" | "NUMBER_QUALITY" | "NO_TEMPLATES";
type Number = { id: string; display: string; quality: string | null; tier: string | null; waba: string };
export type Readiness =
  /** `number` null: two or more it may send from, and the person chooses (2026-11-26). */
  | { ok: true; number: Number | null }
  | { ok: false; code: ReadyCode; message: string; fixHref: string | null };

const not = (code: ReadyCode, message: string, fixHref: string | null): Readiness => ({
  ok: false,
  code,
  message,
  fixHref,
});

/**
 * Whether a run can start now, speaking as `speakerId` (spec 2026-10-19 §1, §6, §10.5), the first thing missing said in
 * words with where to fix it: LUME AI on and with this month left, replying from LUME on, a connected number WhatsApp
 * hasn't rated yellow or red (the speaker's own, else the business's, else the first), and an approved template to
 * start conversations with. The start sheet and starting a run read the same answer.
 */
export async function readiness(
  req: FastifyRequest,
  d: AppDeps,
  speakerId: string,
  /** The number chosen at the start (2026-11-26): one of the business's, the person's own, or the speaker's. */
  numberId?: string,
): Promise<Readiness> {
  const ai = await aiStatus(req, d);
  // Base (Plans and pricing, November 2026) is LUME without AI: said as the plan, not as a switch to flip.
  const plan = req.server.licence.view().plan;
  if (!tierAllows(plan, "ai") && plan?.tier)
    return not(
      "AI_OFF",
      `LUME AI is on ${tiersWith("ai")}. Your LUME is on ${tierName(plan.tier)}.`,
      "/settings/about#plan",
    );
  if (!ai.on)
    return not(
      "AI_OFF",
      "LUME AI is off. An admin can switch it on in Settings → Integrations.",
      "/settings/integrations",
    );
  // AI leads (2026-11-12): with none left, a run would only hold every lead it has; it says so before it starts.
  if (ai.countsLeads && ai.leads.limit !== null && ai.leads.used >= ai.leads.limit)
    return not(
      "AI_LEADS",
      ai.leads.limit === 0
        ? "Your plan has no AI leads, so LUME AI can't start on leads."
        : "This month's AI leads are used up, so LUME AI can't start on new leads. Ask for a top-up from LUME AI's ring, or start again on the 1st.",
      null,
    );
  if (ai.month.limit !== null && ai.month.used >= ai.month.limit)
    return not(
      "AI_MONTH",
      ai.countsLeads
        ? "LUME AI is paused for the rest of the month. Ask for a top-up from LUME AI's ring."
        : "LUME AI has used this month's allowance. Ask for a top-up from LUME AI's ring.",
      null,
    );
  if (!(await replyOn(req, d)))
    return not(
      "REPLY_OFF",
      "Replying from LUME is off. An admin can switch it on in Settings → Integrations → WhatsApp.",
      "/settings/integrations#whatsapp",
    );
  // Which number (2026-11-26): the one chosen, or the only one; with two or more and none chosen, the person is asked.
  const list = await sendableNumbers(req, speakerId);
  if (!list.length)
    return not(
      "NO_NUMBER",
      "LUME AI works on WhatsApp. Connect a number in Settings → Integrations → WhatsApp.",
      "/settings/integrations#whatsapp",
    );
  const n = numberId ? await pickNumber(req, numberId, speakerId) : list.length === 1 ? list[0]! : null;
  if (!n) {
    // Two or more to choose from, none usable at all: why, rather than a choice with nothing to pick.
    const problems = await Promise.all(list.map((x) => numberProblem(req, x)));
    const first = problems[0];
    if (first && problems.every(Boolean)) return not(first.code, first.message, first.fixHref);
    return { ok: true, number: null };
  }
  const problem = await numberProblem(req, n);
  if (problem) return not(problem.code, problem.message, problem.fixHref);
  return {
    ok: true,
    number: { id: n.id, display: n.display, quality: n.quality, tier: n.tier, waba: n.waba },
  };
}

/** Why LUME AI can't start on this number: WhatsApp rated it yellow or red, or nothing is approved on its account. */
export async function numberProblem(
  req: FastifyRequest,
  n: Pick<SendableNumber, "display" | "quality" | "waba">,
): Promise<{ code: ReadyCode; message: string; fixHref: string | null } | null> {
  if (n.quality === "yellow" || n.quality === "red")
    return {
      code: "NUMBER_QUALITY",
      message: `WhatsApp rated ${n.display} ${n.quality}. LUME AI waits until it recovers, to protect the number.`,
      fixHref: null,
    };
  const S = schema.whatsappTemplateSubmissions;
  const V = schema.templateVersions;
  const T = schema.messageTemplates;
  const [t] = await req.db
    .select({ n: count() })
    .from(S)
    .innerJoin(V, eq(V.id, S.templateVersionId))
    .innerJoin(T, eq(T.id, V.templateId))
    .where(and(eq(S.wabaId, n.waba), eq(S.status, "approved"), isNull(T.archivedAt)));
  if (!t?.n)
    return {
      code: "NO_TEMPLATES",
      message: "LUME AI starts conversations with your approved WhatsApp templates. Submit one in Templates.",
      fixHref: "/templates",
    };
  return null;
}

/**
 * What the business has set up for each action (§1.3), from what's saved: `availabilityOf` in Settings → LUME AI's
 * module, so Settings and the start sheet say the same. An action that isn't available runs as Never whatever was chosen.
 */
export async function availability(req: FastifyRequest): Promise<Record<AutopilotAction, Available>> {
  return availabilityOf(req, await readAiProfile(req));
}

/** The permissions a run keeps: as chosen, with anything the business can't use set to Never. */
export function usable(
  chosen: Record<AutopilotAction, Allow>,
  available: Record<AutopilotAction, Available>,
): Record<AutopilotAction, Allow> {
  return Object.fromEntries(
    AUTOPILOT_ACTIONS.map((a) => [a, available[a].ok ? chosen[a] : "never"]),
  ) as Record<AutopilotAction, Allow>;
}

export type AutopilotSetup = {
  ready: { ok: true } | { ok: false; code: ReadyCode; message: string; fixHref: string | null };
  goals: { kind: "stage"; stageId: string; name: string }[];
  speakers: { id: string; name: string }[];
  standing: {
    permissions: Record<AutopilotAction, Allow>;
    followUpDays: number[];
    dailyCap: number | null;
    speaker: string | null;
  };
  available: Record<AutopilotAction, Available>;
  hours: { line: string };
  /** Its only number, when it has one; null with two or more (the person chooses) or none. */
  number: { display: string; tierLimit: number | "unlimited" | null } | null;
  /**
   * The numbers a run may send from (2026-11-26): the business's, the person's own, and each speaker's own (the sheet
   * offers a speaker's only while LUME AI speaks as them), each with why it can't be used, if it can't.
   */
  numbers: {
    id: string;
    display: string;
    whose: string;
    ownerId: string | null;
    tierLimit: number | "unlimited" | null;
    problem: string | null;
  }[];
  /** The person starting it: their own number is always theirs to send from. */
  you: string;
  canRemember: boolean;
};

/**
 * `GET /api/v1/autopilot/setup` (Autopilot A3; spec §1.1–§1.4): what the start sheet opens with, all from the
 * business's own setup: whether a run can start (and what to fix first), the ready-made goals from its pipeline, who
 * LUME AI may speak as, the standing choices, which actions it can use, its hours and its number.
 */
export async function autopilotSetup(req: FastifyRequest, d: AppDeps): Promise<AutopilotSetup> {
  const profile = await readAiProfile(req);
  const st = profile.standing;
  const people = await speakers(req);
  const speakerId = st.speaker && people.some((p) => p.id === st.speaker) ? st.speaker : req.actor!.userId;
  const ready = await readiness(req, d, speakerId);
  const stages = await openStages(req);
  const [s] = await req.db
    .select({ wh: schema.settings.workingHours })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  const number = ready.ok
    ? ready.number
    : (
        await req.db
          .select({ display: N.displayPhone, tier: N.messagingTier })
          .from(N)
          .where(eq(N.status, "active"))
          .orderBy(asc(N.id))
      )[0];
  const list = await sendableNumbers(
    req,
    people.map((p) => p.id),
  );
  const numbers = await Promise.all(
    list.map(async (x) => ({
      id: x.id,
      display: x.display,
      whose: x.whose,
      ownerId: x.ownerId,
      tierLimit: tierLimitOf(x.tier),
      problem: (await numberProblem(req, x))?.message ?? null,
    })),
  );
  return {
    numbers,
    you: req.actor!.userId,
    ready: ready.ok
      ? { ok: true }
      : { ok: false, code: ready.code, message: ready.message, fixHref: ready.fixHref },
    // In pipeline order, whichever order they were chosen in.
    goals: stages
      .filter((x) => st.goalStages.includes(x.id))
      .map((x) => ({ kind: "stage" as const, stageId: x.id, name: x.name })),
    speakers: people,
    standing: {
      permissions: st.permissions,
      followUpDays: st.followUpDays,
      dailyCap: st.dailyCap,
      speaker: st.speaker,
    },
    available: await availability(req),
    hours: { line: hoursLine(workingHoursFrom(s?.wh)) },
    number: number ? { display: number.display, tierLimit: tierLimitOf(number.tier) } : null,
    canRemember: can(req.actor!, "settings.manage"),
  };
}
