import { canOnRecord, instagramWindow, repliesLocked } from "@lume/core";
import type { RunGoal } from "@lume/db";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { pgCodeOf } from "../../errors";
import { readAiProfile } from "../ai/profile";
import { aiLeadsRoom, available } from "../ai/service";
import { availability, usable } from "../autopilot/setup";
import { loadActor } from "../../rbac/actor";

/**
 * LUME AI taking an Instagram conversation (plan 2026-11-27-instagram-lume-ai, Task 3): a new DM no flow claims, on an
 * account whose "Who answers new DMs" is LUME AI, or a flow's Hand to LUME AI step. Each account has one standing run,
 * "New DMs on @account", made on first need and pausable like any run; the lead joins it with its own goal (the flow
 * step's), else the run's.
 */

/** The standing run's goal until the business sets its own (Settings → LUME AI). */
export const INSTAGRAM_DEFAULT_GOAL: RunGoal = {
  kind: "brief",
  text: "Answer their questions and help them take the next step.",
};

/** The account's standing run, made now if it has none: its id and whether it's running. */
export async function standingRun(
  req: FastifyRequest,
  accountId: string,
): Promise<{ id: string; status: string } | null> {
  const find = async () =>
    (
      await req.db.execute<{ id: string; status: string }>(sql`
        SELECT id, status FROM autopilot_runs
         WHERE instagram_account_id = ${accountId} AND standing AND status <> 'ended'`)
    ).rows[0] ?? null;
  const found = await find();
  if (found) return found;
  const a = (
    await req.db.execute<{ username: string; owner_user_id: string | null; run_as: string | null }>(
      sql`SELECT username, owner_user_id, run_as FROM instagram_accounts WHERE id = ${accountId}`,
    )
  ).rows[0];
  // LUME AI writes as the account's person (else whoever connected it), with the business's standing choices.
  const speaker = a?.owner_user_id ?? a?.run_as;
  if (!a || !speaker) return null;
  const s = (
    await req.db.execute<{ goal: RunGoal | null }>(
      sql`SELECT integrations -> 'instagram' -> 'aiGoal' AS goal FROM settings WHERE id = 1`,
    )
  ).rows[0];
  const profile = await readAiProfile(req);
  const permissions = usable(profile.standing.permissions, await availability(req));
  await req.db.execute(sql`
    INSERT INTO autopilot_runs (id, name, started_by, speaker_id, channel, instagram_account_id, standing, goal,
                                permissions, follow_up_days, daily_cap, outside_hours)
    VALUES (gen_random_uuid(), ${`New DMs on @${a.username}`}, ${speaker}, ${speaker}, 'instagram', ${accountId}, true,
            ${JSON.stringify(s?.goal ?? INSTAGRAM_DEFAULT_GOAL)}::jsonb, ${JSON.stringify(permissions)}::jsonb, '{}', NULL,
            'reply_any_time')
    ON CONFLICT (instagram_account_id) WHERE standing AND status <> 'ended' DO NOTHING`);
  return find();
}

/**
 * Give the lead to LUME AI on this account's standing run, to answer what they just wrote. Only while LUME AI can
 * answer: switched on, a plan with replies, room in the month's AI leads, the standing run running. Answers the run
 * (already LUME AI's on it counts: a replayed hand-off starts nothing twice), "held" when another run holds the lead
 * (one run per lead), or null when it's the team's.
 */
export async function giveToAi(
  req: FastifyRequest,
  d: AppDeps,
  /** `answered`: what gave it to LUME AI answered them already (a flow's own message this turn). */
  o: { accountId: string; leadId: string; goal: RunGoal | null; answered?: boolean },
): Promise<{ runId: string } | "held" | null> {
  const lead = (
    await req.db.execute<{ dnc: boolean; owner_id: string | null }>(
      sql`SELECT dnc_at IS NOT NULL AS dnc, owner_id FROM leads WHERE id = ${o.leadId} AND deleted_at IS NULL`,
    )
  ).rows[0];
  if (!lead || lead.dnc) return null;
  // The conversation as it is: a person who took it over keeps it; LUME AI answers only what's unanswered.
  const t = (
    await req.db.execute<{
      last_in_at: Date | string | null;
      last_out_at: Date | string | null;
      ad_window_until: Date | string | null;
      taken: boolean;
      queued_at: Date | string | null;
    }>(sql`
      SELECT t.last_in_at, t.last_out_at, t.ad_window_until, t.taken_over_by IS NOT NULL AS taken,
             (SELECT max(x.created_at) FROM instagram_outbox x
               WHERE x.thread_id = t.id AND x.status IN ('queued', 'sending', 'sent')) AS queued_at
        FROM instagram_threads t WHERE t.account_id = ${o.accountId} AND t.lead_id = ${o.leadId}
       ORDER BY t.last_message_at DESC NULLS LAST LIMIT 1`)
  ).rows[0];
  if (!t || t.taken) return null;
  const holds = (
    await req.db.execute<{ run_id: string; standing_here: boolean }>(sql`
      SELECT l.run_id, (r.standing AND r.instagram_account_id = ${o.accountId}) AS standing_here
        FROM autopilot_leads l JOIN autopilot_runs r ON r.id = l.run_id
       WHERE l.lead_id = ${o.leadId} AND l.active AND r.status <> 'ended'`)
  ).rows[0];
  if (holds) return holds.standing_here ? { runId: holds.run_id } : "held";
  if (!(await available(req, d)).ok) return null;
  if (repliesLocked(req.server.licence.view().plan)) return null;
  // The month's AI leads used up: new conversations are the team's (leads LUME AI holds already go on).
  if (!(await aiLeadsRoom(req, d))) return null;
  const run = await standingRun(req, o.accountId);
  if (run?.status !== "running") return null;
  // LUME AI writes as the run's speaker, within their reach: a lead they may not message is the team's (review I5).
  const speaker = (
    await req.db.execute<{ speaker_id: string }>(
      sql`SELECT speaker_id FROM autopilot_runs WHERE id = ${run.id}`,
    )
  ).rows[0];
  const actor = speaker ? await loadActor(d.jobPool ?? d.pool, speaker.speaker_id) : null;
  if (!actor || !canOnRecord(actor, "messages.send", lead.owner_id)) return null;
  const at = (v: Date | string | null) => (v === null ? null : new Date(v));
  const now = d.clock();
  const inAt = at(t.last_in_at);
  const outAt = [at(t.last_out_at), at(t.queued_at)].reduce<Date | null>(
    (m, x) => (x && (!m || x > m) ? x : m),
    null,
  );
  const w = instagramWindow({ lastInAt: inAt, adWindowUntil: at(t.ad_window_until) }, now);
  // Unanswered inside the window: LUME AI answers now. Answered (a flow's own last message), or nothing from them
  // yet (a comment flow): it waits for them to write, looked at again when the window (or a week) ends.
  const unanswered = !o.answered && w.state === "open" && !!inAt && (!outAt || inAt > outAt);
  const state = unanswered ? "replied" : "talking";
  const nextAt = unanswered ? now : w.state === "open" ? w.until : new Date(now.getTime() + 7 * 86_400_000);
  await req.db.execute(sql`SAVEPOINT lume_ai_intake`);
  try {
    const r = await req.db.execute<{ run_id: string }>(sql`
      INSERT INTO autopilot_leads (run_id, lead_id, state, last_inbound_at, last_sent_at, next_at, goal)
      VALUES (${run.id}, ${o.leadId}, ${state}, ${inAt}, ${unanswered ? null : (outAt ?? now)}, ${nextAt},
              ${o.goal ? JSON.stringify(o.goal) : null}::jsonb)
      ON CONFLICT (run_id, lead_id) DO UPDATE
        SET state = EXCLUDED.state, active = true, reason = NULL, card = NULL, draft = NULL, draft_payload = NULL,
            thought = NULL, fails = 0, carried_on_at = NULL, last_inbound_at = EXCLUDED.last_inbound_at,
            last_sent_at = EXCLUDED.last_sent_at, next_at = EXCLUDED.next_at, goal = EXCLUDED.goal, updated_at = now()
        WHERE NOT autopilot_leads.active
      RETURNING run_id`);
    await req.db.execute(sql`RELEASE SAVEPOINT lume_ai_intake`);
    if (!r.rows[0]) return "held";
    await req.db.execute(
      sql`INSERT INTO autopilot_events (run_id, lead_id, kind) VALUES (${run.id}, ${o.leadId}, 'replied')`,
    );
    return { runId: run.id };
  } catch (e) {
    await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_ai_intake`);
    // Another run took the lead a moment ago (one run per lead).
    if (pgCodeOf(e) === "23505") return "held";
    throw e;
  }
}
