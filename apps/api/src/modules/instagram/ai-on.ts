import { canOnRecord, instagramWindow, moduleIncluded, repliesLocked, tiersWith } from "@lume/core";
import { schema, type RunGoal } from "@lume/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { badRequest, HttpError } from "../../http/errors";
import { openStages, readAiProfile } from "../ai/profile";
import { visibleLead } from "../leads/service";
import { giveToAi, INSTAGRAM_DEFAULT_GOAL } from "./ai-intake";

/**
 * Whether LUME AI may answer Instagram conversations here, and why not, in words (plan 2026-11-27-instagram-lume-ai,
 * Task 4): switched on, in the plan, with replies. `d` adds whether the server has an AI provider at all; without it
 * (the flow builder's check) a hand-off still falls back to a person when it runs.
 */
export async function aiOnInstagram(
  req: FastifyRequest,
  d?: AppDeps,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const plan = req.server.licence.view().plan;
  if (d && !d.ai) return { ok: false, why: "LUME AI isn't set up on this server yet." };
  if (!moduleIncluded(plan, "ai")) return { ok: false, why: "LUME AI isn't in this LUME's plan." };
  const [s] = await req.db
    .select({ i: schema.settings.integrations })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  if (!s?.i.ai?.enabled)
    return {
      ok: false,
      why: "LUME AI is switched off. An admin can switch it on in Settings → Integrations.",
    };
  if (repliesLocked(plan)) return { ok: false, why: `LUME AI's replies are on ${tiersWith("ai_replies")}.` };
  return { ok: true };
}

/** What LUME AI aims for in the Instagram conversations it takes (the standing run's goal). */
export async function instagramAiGoal(req: FastifyRequest): Promise<RunGoal> {
  const r = await req.db.execute<{ goal: RunGoal | null }>(
    sql`SELECT integrations -> 'instagram' -> 'aiGoal' AS goal FROM settings WHERE id = 1`,
  );
  return r.rows[0]?.goal ?? INSTAGRAM_DEFAULT_GOAL;
}

/** The goal stages chosen in Settings → LUME AI, still open: what the card offers to aim for. */
export async function instagramGoalStages(req: FastifyRequest): Promise<{ id: string; name: string }[]> {
  const chosen = (await readAiProfile(req)).standing.goalStages;
  return (await openStages(req))
    .filter((s) => chosen.includes(s.id))
    .map((s) => ({ id: s.id, name: s.name }));
}

/**
 * Set it (an admin): a goal stage that's open, or the business's own words. The standing runs take it from now on; a
 * lead a flow handed over keeps its own.
 */
export async function setInstagramAiGoal(req: FastifyRequest, goal: RunGoal) {
  if (goal.kind === "stage" && !(await openStages(req)).some((s) => s.id === goal.stageId))
    throw badRequest("STAGE_INVALID", "Choose one of your open stages.");
  if (goal.kind === "brief" && !goal.text.trim())
    throw badRequest("GOAL_REQUIRED", "Write what LUME AI should aim for.");
  if (goal.kind === "reply")
    throw new HttpError(400, "GOAL_INVALID", "They've written already: choose a stage or write a goal.");
  const kept = goal.kind === "brief" ? { kind: "brief" as const, text: goal.text.trim() } : goal;
  await req.db.execute(sql`
    UPDATE settings SET integrations = jsonb_set(integrations, '{instagram}',
           coalesce(integrations -> 'instagram', '{}'::jsonb) || ${JSON.stringify({ aiGoal: kept })}::jsonb)
     WHERE id = 1`);
  await req.db.execute(sql`
    UPDATE autopilot_runs SET goal = ${JSON.stringify(kept)}::jsonb, updated_at = now()
     WHERE channel = 'instagram' AND standing AND status <> 'ended'`);
  await audit(req, { action: "instagram.ai_goal", entityType: "integration", diff: { goal: kept.kind } });
  return { goal: kept };
}

/**
 * "Let LUME AI handle these" on Instagram leads (Who replied; spec 2026-11-22 §4): each to its account's standing run,
 * or skipped with why (Instagram's 24 hours over, another run has them, a person answering). LUME AI answers what's
 * unanswered; the runs are woken once this commits.
 */
export async function handToAi(req: FastifyRequest, d: AppDeps, leadIds: string[]) {
  const ai = await aiOnInstagram(req, d);
  if (!ai.ok) throw new HttpError(409, "AI_UNAVAILABLE", ai.why);
  const skipped: { leadId: string; why: string }[] = [];
  const runs = new Set<string>();
  let given = 0;
  for (const leadId of [...new Set(leadIds)]) {
    const skip = (why: string) => skipped.push({ leadId, why });
    const lead = await visibleLead(req, leadId).catch(() => null);
    if (!lead) {
      skip("This lead isn't here any more.");
      continue;
    }
    if (!canOnRecord(req.actor!, "messages.send", lead.ownerId)) {
      skip("You can't message this lead.");
      continue;
    }
    const t = (
      await req.db.execute<{
        account_id: string;
        last_in_at: Date | string | null;
        ad_window_until: Date | string | null;
        taken: boolean;
      }>(sql`
        SELECT account_id, last_in_at, ad_window_until, taken_over_by IS NOT NULL AS taken FROM instagram_threads
         WHERE lead_id = ${leadId} ORDER BY last_message_at DESC NULLS LAST LIMIT 1`)
    ).rows[0];
    if (!t) {
      skip("They haven't written on Instagram.");
      continue;
    }
    const at = (v: Date | string | null) => (v === null ? null : new Date(v));
    if (
      instagramWindow({ lastInAt: at(t.last_in_at), adWindowUntil: at(t.ad_window_until) }, d.clock())
        .state !== "open"
    ) {
      skip("Instagram's 24 hours to answer are over.");
      continue;
    }
    if (t.taken) {
      skip("A person is answering this conversation.");
      continue;
    }
    const r = await giveToAi(req, d, { accountId: t.account_id, leadId, goal: null });
    if (r === "held") skip("Another LUME AI run has them.");
    else if (!r) skip("LUME AI can't take this conversation now.");
    else {
      given++;
      runs.add(r.runId);
    }
  }
  req.afterCommit(() => {
    for (const id of runs) void d.autopilot?.kick(id).catch(() => undefined);
  });
  return { given, skipped };
}
