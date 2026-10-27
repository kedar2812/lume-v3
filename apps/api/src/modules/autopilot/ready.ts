import { AUTOPILOT_ACTION_TITLES, can, firstNameOf, windowOpen, type AutopilotAction } from "@lume/core";
import { schema } from "@lume/db";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import type { AppDeps } from "../../app";
import { conflict, forbidden, notFound } from "../../http/errors";
import { notify } from "../notifications/notify";
import { allScope } from "../whatsapp/sender";

/**
 * Who hears that a lead needs them (spec §1.3, §11): the person who started the run, once per ask or per lead ready; and,
 * when "Hand a lead to a rep" is Go ahead, the lead's own rep too for a lead ready or needing a person.
 */
export async function tellPeople(
  pool: pg.Pool,
  o: { runId: string; leadId: string } & (
    { kind: "ask"; action: AutopilotAction } | { kind: "ready" | "needs_you"; headline: string }
  ),
): Promise<void> {
  const facts = await allScope(pool, async (c) => {
    const { rows } = await c.query<{
      started_by: string;
      hand: string | null;
      name: string;
      owner_id: string | null;
    }>(
      `SELECT r.started_by, r.permissions ->> 'hand_to_rep' AS hand, l.name, l.owner_id
         FROM autopilot_runs r, leads l WHERE r.id = $1 AND l.id = $2`,
      [o.runId, o.leadId],
    );
    return rows[0];
  });
  if (!facts) return;
  const first = firstNameOf(facts.name) || "A lead";
  const title =
    o.kind === "ask"
      ? `LUME AI is waiting for you: ${AUTOPILOT_ACTION_TITLES[o.action]} for ${first}`
      : o.kind === "ready"
        ? // LUME AI's own reason may end in a full stop already: one, not two.
          `${first}: ${o.headline.replace(/[.\s]+$/, "")}. Want to take over?`
        : `${first} needs you: ${o.headline}`;
  const to = [facts.started_by];
  if (o.kind !== "ask" && facts.hand === "go" && facts.owner_id && facts.owner_id !== facts.started_by)
    to.push(facts.owner_id);
  for (const id of to)
    await notify(pool, id, {
      kind: o.kind === "ask" ? "autopilot_ask" : "autopilot_ready",
      title: title.slice(0, 200),
      leadId: o.leadId,
      data: { runId: o.runId },
    });
}

const mayDecide = (req: FastifyRequest, startedBy: string) =>
  startedBy === req.actor!.userId || can(req.actor!, "settings.manage");

async function askOf(req: FastifyRequest, id: string) {
  const A = schema.autopilotAsks;
  // Row-level secured by the lead: someone who can't see the lead never finds the ask.
  const [ask] = await req.db.select().from(A).where(eq(A.id, id)).for("update");
  if (!ask || ask.status !== "waiting") throw notFound("NOT_FOUND", "That isn't waiting for you any more.");
  const [run] = await req.db
    .select()
    .from(schema.autopilotRuns)
    .where(eq(schema.autopilotRuns.id, ask.runId));
  if (!run || !mayDecide(req, run.startedBy)) throw forbidden();
  return ask;
}

const L = schema.autopilotLeads;
/** Meta stamps a message to the whole second: one written in the second of a send can read as just before it. */
const SAME_SECOND = 1000;
const leadKey = (runId: string, leadId: string) => and(eq(L.runId, runId), eq(L.leadId, leadId))!;

/** Approve what LUME AI prepared (§2.1): it goes at once, as it was written, as the speaker. */
export async function approveAsk(req: FastifyRequest, d: AppDeps, id: string) {
  const ask = await askOf(req, id);
  // Still waiting on this? Taken over, written to again or stopped since, what LUME AI prepared is stale (A3).
  const [row] = await req.db.select().from(L).where(leadKey(ask.runId, ask.leadId)).for("update");
  if (!row || !row.active || row.state !== "needs_you")
    throw conflict("ASK_GONE", "This lead has moved on since LUME AI asked. Nothing was sent.");
  const now = d.clock();
  const p = ask.payload as {
    message: string;
    fileIds?: string[];
    updates?: unknown;
    /** A first message or a follow-up asked about (the run's Ask me): the approved template, as it was prepared. */
    template?: { submissionId: string; n: number; marks: unknown };
  };
  await req.db
    .update(schema.autopilotAsks)
    .set({ status: "approved", decidedBy: req.actor!.userId, decidedAt: now })
    .where(eq(schema.autopilotAsks.id, id));
  await req.db
    .update(L)
    .set({
      state: "writing",
      draft: p.message,
      draftPayload: p.template
        ? { kind: "template", ...p.template }
        : { kind: "reply", fileIds: p.fileIds, updates: p.updates },
      card: null,
      reason: null,
      nextAt: now,
      updatedAt: now,
    })
    .where(leadKey(ask.runId, ask.leadId));
  req.afterCommit(() => void d.autopilot?.kick(ask.runId));
  return { approved: true as const };
}

/** Decline: nothing is sent; the lead is the person's now. */
export async function declineAsk(req: FastifyRequest, d: AppDeps, id: string) {
  const ask = await askOf(req, id);
  const now = d.clock();
  await req.db
    .update(schema.autopilotAsks)
    .set({ status: "declined", decidedBy: req.actor!.userId, decidedAt: now })
    .where(eq(schema.autopilotAsks.id, id));
  await req.db
    .update(L)
    .set({ state: "with_you", card: null, draft: null, draftPayload: null, nextAt: null, updatedAt: now })
    .where(leadKey(ask.runId, ask.leadId));
  return { declined: true as const };
}

/** "Let LUME AI confirm / answer" (§2): back to the conversation, from where it is. */
export async function carryOn(req: FastifyRequest, d: AppDeps, runId: string, leadId: string) {
  const [run] = await req.db.select().from(schema.autopilotRuns).where(eq(schema.autopilotRuns.id, runId));
  if (!run) throw notFound("NOT_FOUND", "That run isn't here.");
  if (!mayDecide(req, run.startedBy)) throw forbidden();
  const [row] = await req.db.select().from(L).where(leadKey(runId, leadId)).for("update");
  if (!row) throw notFound("NOT_FOUND", "That lead isn't in this run.");
  if (!row.active || (row.state !== "ready" && row.state !== "needs_you"))
    return { leadId, state: row.state };
  const now = d.clock();
  const waiting =
    !!row.lastInboundAt &&
    (!row.lastSentAt || row.lastInboundAt.getTime() + SAME_SECOND > row.lastSentAt.getTime()) &&
    windowOpen(row.lastInboundAt, now);
  const state = waiting ? "replied" : row.firstSentAt ? "sent" : "up_next";
  await req.db
    .update(schema.autopilotAsks)
    .set({ status: "gone", decidedBy: req.actor!.userId, decidedAt: now })
    .where(
      and(
        eq(schema.autopilotAsks.runId, runId),
        eq(schema.autopilotAsks.leadId, leadId),
        eq(schema.autopilotAsks.status, "waiting"),
      ),
    );
  await req.db
    .update(L)
    .set({ state, card: null, reason: null, nextAt: now, updatedAt: now })
    .where(leadKey(runId, leadId));
  req.afterCommit(() => void d.autopilot?.kick(runId));
  return { leadId, state };
}
