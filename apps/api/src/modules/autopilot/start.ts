import {
  AUTOPILOT_ACTIONS,
  can,
  canOnRecord,
  costOf,
  newId,
  normalizePhone,
  profileProblem,
  type Allow,
  type AutopilotAction,
} from "@lume/core";
import { schema, type RunGoal } from "@lume/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, forbidden } from "../../http/errors";

import { loadActor } from "../../rbac/actor";
import { aiStatus } from "../ai/service";
import { openStages, patchAiProfile, speakers } from "../ai/profile";
import { visibleLead } from "../leads/service";
import { replyOn } from "../whatsapp/send";
import { runView, type RunView } from "./read";

const N = schema.whatsappNumbers;
const conflict = (code: string, message: string) => new HttpError(409, code, message);

/** What starting a run (or its estimate) takes (§1.1–§1.4): the sheet sends the business's standing choices, as edited. */
export const runBody = z
  .object({
    leadIds: z.array(z.uuid()).min(1).max(500),
    goal: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("stage"), stageId: z.uuid() }).strict(),
      z.object({ kind: z.literal("reply") }).strict(),
      z.object({ kind: z.literal("brief"), text: z.string().trim().min(15).max(600) }).strict(),
    ]),
    speakerId: z.uuid().nullable(),
    permissions: z.record(z.string(), z.string()),
    followUpDays: z.array(z.number()),
    dailyCap: z.number().nullable(),
    name: z.string().trim().min(1).max(120).optional(),
    remember: z.boolean().default(false),
  })
  .strict();
export type RunBody = z.infer<typeof runBody>;

type Checked = {
  speaker: { id: string; name: string };
  number: { id: string; display: string; quality: string | null };
  goal: RunGoal;
  goalName: string;
  permissions: Record<AutopilotAction, Allow>;
  eligible: { id: string; country: string | null }[];
  skipped: { leadId: string; why: string }[];
  monthLeft: number | null;
  monthLimit: number | null;
};

/**
 * Everything a run needs checked before it starts (§1, §6), each refusal in words: LUME AI on and with this month left,
 * replying from LUME on, a speaker who may send messages, a connected number WhatsApp hasn't rated yellow or red, the
 * business's own goal, valid choices; and each lead it may work, the rest skipped with why.
 */
async function check(req: FastifyRequest, d: AppDeps, b: RunBody): Promise<Checked> {
  if (!can(req.actor!, "messages.send")) throw forbidden();
  const ai = await aiStatus(req, d);
  if (!ai.on)
    throw conflict("AI_OFF", "LUME AI is off. An admin can switch it on in Settings → Integrations.");
  if (ai.month.limit !== null && ai.month.used >= ai.month.limit)
    throw conflict(
      "AI_MONTH",
      "LUME AI has used this month's allowance. Ask for a top-up from LUME AI's ring.",
    );
  if (!(await replyOn(req, d)))
    throw conflict(
      "REPLY_OFF",
      "Replying from LUME is off. An admin can switch it on in Settings → Integrations → WhatsApp.",
    );

  const problem = profileProblem({
    standing: { permissions: b.permissions, followUpDays: b.followUpDays, dailyCap: b.dailyCap },
  });
  if (problem) throw badRequest("BAD_CHOICES", problem);
  const permissions = Object.fromEntries(
    AUTOPILOT_ACTIONS.map((a) => [a, (b.permissions[a] as Allow | undefined) ?? "ask"]),
  ) as Record<AutopilotAction, Allow>;

  const speakerId = b.speakerId ?? req.actor!.userId;
  const speaker = (await speakers(req)).find((p) => p.id === speakerId);
  if (!speaker) throw badRequest("SPEAKER", "LUME AI can only speak as someone who may send messages.");

  // The speaker's own number, else the business's, else the first connected (as a template goes, W3b-2).
  const numbers = await req.db
    .select({ id: N.id, display: N.displayPhone, owner: N.ownerUserId, quality: N.quality })
    .from(N)
    .where(eq(N.status, "active"))
    .orderBy(asc(N.id));
  const number =
    numbers.find((n) => n.owner === speakerId) ?? numbers.find((n) => n.owner === null) ?? numbers[0];
  if (!number) throw conflict("NO_NUMBER", "Connect a WhatsApp number first.");
  if (number.quality === "yellow" || number.quality === "red")
    throw conflict(
      "NUMBER_QUALITY",
      `WhatsApp rated ${number.display} ${number.quality}. LUME AI waits until it recovers, to protect the number.`,
    );

  let goal: RunGoal = b.goal;
  let goalName = b.goal.kind === "reply" ? "Get a reply" : "Your goal";
  if (b.goal.kind === "stage") {
    const stageId = b.goal.stageId;
    const stage = (await openStages(req)).find((s) => s.id === stageId);
    if (!stage) throw badRequest("BAD_GOAL", "A goal is one of your open stages.");
    goalName = stage.name;
    goal = { kind: "stage", stageId };
  }

  const speakerActor = speakerId === req.actor!.userId ? req.actor! : await loadActor(d.pool, speakerId);
  const eligible: Checked["eligible"] = [];
  const skipped: Checked["skipped"] = [];
  for (const id of [...new Set(b.leadIds)]) {
    const lead = await visibleLead(req, id).catch((e: unknown) => {
      if (e instanceof HttpError) return null;
      throw e;
    });
    const why = !lead
      ? "Not one of the leads you can see"
      : !speakerActor || !canOnRecord(speakerActor, "messages.send", lead.ownerId)
        ? `${speaker.name} can't message this lead`
        : !lead.phoneE164 || lead.phoneStatus !== "valid"
          ? "No WhatsApp number"
          : lead.dncAt
            ? "Asked not to be messaged"
            : null;
    if (why || !lead) skipped.push({ leadId: id, why: why ?? "Not one of the leads you can see" });
    // The country from the number itself, as a template send reads it (W3b-2).
    else
      eligible.push({
        id: lead.id,
        country: normalizePhone(lead.phoneE164!).countryIso ?? lead.phoneCountryIso,
      });
  }
  return {
    speaker,
    number,
    goal,
    goalName,
    permissions,
    eligible,
    skipped,
    monthLeft: ai.month.limit === null ? null : ai.month.limit - ai.month.used,
    monthLimit: ai.month.limit,
  };
}

/** The leads already in a run (§3): skipped by a new one. The caller sees each of these leads, so row-level security
 * shows its rows whoever started the other run. */
async function inRuns(req: FastifyRequest, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const L = schema.autopilotLeads;
  const rows = await req.db
    .select({ leadId: L.leadId })
    .from(L)
    .where(and(inArray(L.leadId, ids), eq(L.active, true)));
  return new Set(rows.map((r) => r.leadId));
}

/**
 * `POST /api/v1/autopilot/estimate` (§1.4): how many first messages would go, which leads would be skipped and why, about
 * what Meta charges for them, and the share of this month's LUME AI (one read each to choose a template).
 */
export async function estimateRun(req: FastifyRequest, d: AppDeps, b: RunBody) {
  const c = await check(req, d, b);
  const busy = await inRuns(
    req,
    c.eligible.map((l) => l.id),
  );
  const eligible = c.eligible.filter((l) => !busy.has(l.id));
  const skipped = [
    ...c.skipped,
    ...c.eligible
      .filter((l) => busy.has(l.id))
      .map((l) => ({ leadId: l.id, why: "Already in another LUME AI run" })),
  ];
  const costs = eligible.map((l) => costOf(l.country, "MARKETING"));
  const currency = costs[0]?.currency ?? null;
  const metaCost =
    costs.length && costs.every((x) => x && x.currency === currency)
      ? { amount: Math.round(costs.reduce((s, x) => s + x!.amount, 0) * 100) / 100, currency: currency! }
      : null;
  return {
    eligible: eligible.length,
    skipped,
    firstMessages: eligible.length,
    metaCost,
    monthShare: c.monthLimit ? eligible.length / c.monthLimit : null,
  };
}

/**
 * `POST /api/v1/autopilot/runs` (§1): the run, with each lead it may work (one run per lead, held by the database even
 * when two start at once) and the rest skipped with why. "Use these every time" saves the choices for an admin.
 */
export async function startRun(
  req: FastifyRequest,
  d: AppDeps,
  b: RunBody,
): Promise<{ run: RunView; skipped: { leadId: string; why: string }[]; remembered: boolean }> {
  const c = await check(req, d, b);
  const now = d.clock();
  const profile = (await req.db.select({ p: schema.aiProfile.profile }).from(schema.aiProfile))[0]?.p as
    { standing?: { outsideHours?: "reply_any_time" | "wait" } } | undefined;
  const runId = newId();
  const [row] = await req.db
    .insert(schema.autopilotRuns)
    .values({
      id: runId,
      name: b.name ?? `${c.goalName} · ${b.leadIds.length} ${b.leadIds.length === 1 ? "lead" : "leads"}`,
      startedBy: req.actor!.userId,
      speakerId: c.speaker.id,
      numberId: c.number.id,
      goal: c.goal,
      permissions: c.permissions,
      followUpDays: b.followUpDays,
      dailyCap: b.dailyCap,
      outsideHours: profile?.standing?.outsideHours ?? "wait",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const L = schema.autopilotLeads;
  const taken = c.eligible.length
    ? await req.db.execute<{ lead_id: string }>(sql`
        INSERT INTO autopilot_leads (run_id, lead_id, state, next_at, updated_at)
        SELECT ${runId}::uuid, x, 'up_next', ${now}, ${now}
          FROM unnest(ARRAY[${sql.join(
            c.eligible.map((l) => sql`${l.id}::uuid`),
            sql`, `,
          )}]) AS x
        ON CONFLICT (lead_id) WHERE active DO NOTHING
        RETURNING lead_id`)
    : { rows: [] };
  const got = new Set(taken.rows.map((r) => r.lead_id));
  const skipped = [
    ...c.skipped,
    ...c.eligible
      .filter((l) => !got.has(l.id))
      .map((l) => ({ leadId: l.id, why: "Already in another LUME AI run" })),
  ];
  const visibleSkips = skipped.filter((s) => s.why !== "Not one of the leads you can see");
  if (visibleSkips.length)
    await req.db.insert(L).values(
      visibleSkips.map((s) => ({
        runId,
        leadId: s.leadId,
        state: "skipped" as const,
        reason: s.why,
        active: false,
        updatedAt: now,
      })),
    );
  await req.db
    .insert(schema.autopilotEvents)
    .values({ runId, kind: "run_started", data: { leads: got.size, skipped: skipped.length }, at: now });
  await audit(req, {
    action: "autopilot.started",
    entityType: "autopilot_run",
    entityId: runId,
    diff: { leads: got.size },
  });

  let remembered = false;
  if (b.remember && can(req.actor!, "settings.manage")) {
    await patchAiProfile(req, {
      standing: {
        permissions: c.permissions,
        followUpDays: b.followUpDays,
        dailyCap: b.dailyCap,
        ...(b.speakerId ? { speaker: b.speakerId } : {}),
      },
    });
    remembered = true;
  }
  return { run: runView(row!), skipped, remembered };
}
