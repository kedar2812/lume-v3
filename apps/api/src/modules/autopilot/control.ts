import { canOnRecord, windowOpen } from "@lume/core";
import { schema } from "@lume/db";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { forbidden, notFound } from "../../http/errors";
import { visibleLead } from "../leads/service";
import { endRun, pauseRun, resumeRun } from "./engine";
import { mayControl, runView } from "./read";

const R = schema.autopilotRuns;
const L = schema.autopilotLeads;
/** Meta stamps a message to the whole second: one written in the second of a send can read as just before it. */
const SAME_SECOND = 1000;

async function runOf(req: FastifyRequest, id: string) {
  const [run] = await req.db.select().from(R).where(eq(R.id, id));
  if (!run) throw notFound("NOT_FOUND", "That run isn't here.");
  return run;
}
/** Pausing, resuming, ending a run (spec §2.2): the person who started it, or an admin. From any device. */

export async function controlRun(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  what: "pause" | "resume" | "end",
) {
  const run = await runOf(req, id);
  if (!mayControl(req, run)) throw forbidden();
  const pool = d.jobPool ?? d.pool;
  if (what === "pause") await pauseRun(pool, id, "person");
  else if (what === "resume") {
    if (await resumeRun(pool, id)) req.afterCommit(() => void d.autopilot?.kick(id));
  } else await endRun(pool, id);
  return { run: runView(await runOf(req, id)) };
}

/** A lead of a run, as this person sees it; who may take it: the run's controllers, or anyone who may message it. */
async function leadOf(req: FastifyRequest, runId: string, leadId: string) {
  const run = await runOf(req, runId);
  const lead = await visibleLead(req, leadId);
  if (!mayControl(req, run) && !canOnRecord(req.actor!, "messages.send", lead.ownerId)) throw forbidden();
  const [row] = await req.db
    .select()
    .from(L)
    .where(and(eq(L.runId, runId), eq(L.leadId, leadId)))
    .for("update");
  if (!row) throw notFound("NOT_FOUND", "That lead isn't in this run.");
  return row;
}

/**
 * Take a lead over (spec §2.1): it's the person's at once, even mid-sentence; what LUME AI was writing is left for them to
 * edit or clear. The run carries on with the others.
 */
export async function takeOver(req: FastifyRequest, runId: string, leadId: string) {
  const row = await leadOf(req, runId, leadId);
  if (row.active && row.state !== "stopped")
    await req.db
      .update(L)
      .set({ state: "with_you", nextAt: null, updatedAt: new Date() })
      .where(and(eq(L.runId, runId), eq(L.leadId, leadId)));
  await req.db.insert(schema.autopilotEvents).values({ runId, leadId, kind: "with_you" });
  return { leadId, state: row.active && row.state !== "stopped" ? "with_you" : row.state, draft: row.draft };
}

/** Hand a lead back to LUME AI: it carries on from where the conversation is (a reply if the lead's waiting on one). */
export async function handBack(req: FastifyRequest, d: AppDeps, runId: string, leadId: string) {
  const row = await leadOf(req, runId, leadId);
  if (row.state !== "with_you" || !row.active) return { leadId, state: row.state };
  const now = d.clock();
  const waiting =
    !!row.lastInboundAt &&
    (!row.lastSentAt || row.lastInboundAt.getTime() + SAME_SECOND > row.lastSentAt.getTime()) &&
    windowOpen(row.lastInboundAt, now);
  const state = waiting ? "replied" : row.firstSentAt ? "sent" : "up_next";
  await req.db
    .update(L)
    .set({ state, draft: null, draftPayload: null, nextAt: now, updatedAt: now })
    .where(and(eq(L.runId, runId), eq(L.leadId, leadId)));
  await req.db.insert(schema.autopilotEvents).values({ runId, leadId, kind: "handed_back" });
  req.afterCommit(() => void d.autopilot?.kick(runId));
  return { leadId, state };
}
