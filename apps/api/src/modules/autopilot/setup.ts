import { AUTOPILOT_ACTIONS, can, hoursLine, tierLimitOf, type Allow, type AutopilotAction } from "@lume/core";
import { schema } from "@lume/db";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { aiStatus } from "../ai/service";
import { filesOf, openStages, readAiProfile, speakers } from "../ai/profile";
import { workingHoursFrom } from "../settings/follow-ups";
import { replyOn } from "../whatsapp/send";

const N = schema.whatsappNumbers;

export type ReadyCode = "AI_OFF" | "AI_MONTH" | "REPLY_OFF" | "NO_NUMBER" | "NUMBER_QUALITY" | "NO_TEMPLATES";
type Number = { id: string; display: string; quality: string | null; tier: string | null; waba: string };
export type Readiness =
  { ok: true; number: Number } | { ok: false; code: ReadyCode; message: string; fixHref: string | null };
type Available = { ok: true } | { ok: false; why: string; fixHref: string | null };

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
export async function readiness(req: FastifyRequest, d: AppDeps, speakerId: string): Promise<Readiness> {
  const ai = await aiStatus(req, d);
  if (!ai.on)
    return not(
      "AI_OFF",
      "LUME AI is off. An admin can switch it on in Settings → Integrations.",
      "/settings/integrations",
    );
  if (ai.month.limit !== null && ai.month.used >= ai.month.limit)
    return not(
      "AI_MONTH",
      "LUME AI has used this month's allowance. Ask for a top-up from LUME AI's ring.",
      null,
    );
  if (!(await replyOn(req, d)))
    return not(
      "REPLY_OFF",
      "Replying from LUME is off. An admin can switch it on in Settings → Integrations → WhatsApp.",
      "/settings/integrations/whatsapp",
    );
  const numbers = await req.db
    .select({
      id: N.id,
      display: N.displayPhone,
      owner: N.ownerUserId,
      quality: N.quality,
      tier: N.messagingTier,
      waba: N.wabaId,
    })
    .from(N)
    .where(eq(N.status, "active"))
    .orderBy(asc(N.id));
  const n = numbers.find((x) => x.owner === speakerId) ?? numbers.find((x) => x.owner === null) ?? numbers[0];
  if (!n)
    return not(
      "NO_NUMBER",
      "LUME AI works on WhatsApp. Connect a number in Settings → Integrations → WhatsApp.",
      "/settings/integrations/whatsapp",
    );
  if (n.quality === "yellow" || n.quality === "red")
    return not(
      "NUMBER_QUALITY",
      `WhatsApp rated ${n.display} ${n.quality}. LUME AI waits until it recovers, to protect the number.`,
      null,
    );
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
    return not(
      "NO_TEMPLATES",
      "LUME AI starts conversations with your approved WhatsApp templates. Submit one in Templates.",
      "/templates",
    );
  return {
    ok: true,
    number: { id: n.id, display: n.display, quality: n.quality, tier: n.tier, waba: n.waba },
  };
}

/**
 * What the business has set up for each action (§1.3: "an action the business can't do shows off with the reason and a
 * link to set it up"). An action that isn't available runs as Never whatever was chosen.
 */
export async function availability(req: FastifyRequest): Promise<Record<AutopilotAction, Available>> {
  const profile = await readAiProfile(req);
  // Files chosen in Settings → LUME AI that are still in Media (an archived one can't be sent).
  const files = (await filesOf(req, profile.knows.files)).filter((f) => !f.archived).length;
  const [lost] = await req.db
    .select({ n: count() })
    .from(schema.lostReasons)
    .where(isNull(schema.lostReasons.archivedAt));
  const ok: Available = { ok: true };
  const all = Object.fromEntries(AUTOPILOT_ACTIONS.map((a) => [a, ok])) as Record<AutopilotAction, Available>;
  return {
    ...all,
    send_files: files
      ? ok
      : {
          ok: false,
          why: "Choose the files LUME AI may send in Settings → LUME AI.",
          fixHref: "/settings/ai",
        },
    answer_prices: profile.knows.prices.length
      ? ok
      : { ok: false, why: "Add your price list in Settings → LUME AI.", fixHref: "/settings/ai" },
    mark_lost: lost?.n
      ? ok
      : { ok: false, why: "Add your lost reasons in Settings → Lists.", fixHref: "/settings/lists" },
    // LUME's calendar connection only reads, with no free/busy: booking could clash (A2's plan ruling).
    book_meetings: { ok: false, why: "Needs a calendar LUME can book into.", fixHref: null },
  };
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
  number: { display: string; tierLimit: number | "unlimited" | null } | null;
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
  return {
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
