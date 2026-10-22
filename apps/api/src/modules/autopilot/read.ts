import type { LeadState } from "@lume/core";
import { schema } from "@lume/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { notFound } from "../../http/errors";

type RunRow = typeof schema.autopilotRuns.$inferSelect;
export type RunView = Omit<RunRow, "createdAt" | "updatedAt" | "endedAt"> & {
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};
export const runView = (r: RunRow): RunView => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  endedAt: r.endedAt?.toISOString() ?? null,
});

const STATES: LeadState[] = [
  "up_next",
  "writing",
  "sent",
  "replied",
  "talking",
  "ready",
  "needs_you",
  "stopped",
  "with_you",
  "skipped",
];

/** The leads of these runs this person may see, with each lead's name (row-level security does the hiding). */
async function leadsOf(req: FastifyRequest, runIds: string[]) {
  if (!runIds.length) return [];
  const L = schema.autopilotLeads;
  return req.db
    .select({
      runId: L.runId,
      leadId: L.leadId,
      name: schema.leads.name,
      state: L.state,
      reason: L.reason,
      card: L.card,
      nextAt: L.nextAt,
      lastSentAt: L.lastSentAt,
      updatedAt: L.updatedAt,
    })
    .from(L)
    .innerJoin(schema.leads, eq(schema.leads.id, L.leadId))
    .where(inArray(L.runId, runIds))
    .orderBy(desc(L.updatedAt));
}
const countsOf = (rows: { state: LeadState }[]) =>
  Object.fromEntries(STATES.map((s) => [s, rows.filter((r) => r.state === s).length])) as Record<
    LeadState,
    number
  >;

/** `GET /api/v1/autopilot/runs`: the newest runs, each with the counts of the leads this person sees. */
export async function listRuns(req: FastifyRequest) {
  const runs = await req.db
    .select()
    .from(schema.autopilotRuns)
    .orderBy(desc(schema.autopilotRuns.createdAt))
    .limit(50);
  const leads = await leadsOf(
    req,
    runs.map((r) => r.id),
  );
  return {
    runs: runs.map((r) => ({ ...runView(r), counts: countsOf(leads.filter((l) => l.runId === r.id)) })),
  };
}

/** `GET /api/v1/autopilot/runs/:id`: the run, its counts, the leads this person sees in it, and what waits for a tap. */
export async function getRun(req: FastifyRequest, id: string) {
  const [run] = await req.db.select().from(schema.autopilotRuns).where(eq(schema.autopilotRuns.id, id));
  if (!run) throw notFound("NOT_FOUND", "That run isn't here.");
  const leads = await leadsOf(req, [id]);
  const A = schema.autopilotAsks;
  const asks = await req.db
    .select({ id: A.id, leadId: A.leadId, action: A.action, payload: A.payload, createdAt: A.createdAt })
    .from(A)
    .where(and(eq(A.runId, id), eq(A.status, "waiting")));
  return {
    run: runView(run),
    counts: countsOf(leads),
    leads: leads.map((l) => ({
      leadId: l.leadId,
      name: l.name,
      state: l.state,
      reason: l.reason,
      card: l.card,
      nextAt: l.nextAt?.toISOString() ?? null,
      lastSentAt: l.lastSentAt?.toISOString() ?? null,
      updatedAt: l.updatedAt.toISOString(),
    })),
    asks: asks.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
  };
}
