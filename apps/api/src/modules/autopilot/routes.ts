import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { controlRun, handBack, takeOver } from "./control";
import { approveAsk, carryOn, declineAsk } from "./ready";
import { getRun, listRuns } from "./read";
import { estimateRun, runBody, startRun } from "./start";

/**
 * Autopilot (spec 2026-10-19 §1–§3): starting LUME AI on leads (who may message many leads at once: the send queue's
 * permission), and reading runs (whoever may view leads; each sees only their leads' rows).
 */
export async function autopilotRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const id = z.object({ id: z.uuid() });
  r.post(
    "/api/v1/autopilot/estimate",
    { config: { permission: "messages.send_queue" }, schema: { body: runBody } },
    (req) => estimateRun(req, d, req.body),
  );
  r.post(
    "/api/v1/autopilot/runs",
    { config: { permission: "messages.send_queue" }, schema: { body: runBody } },
    async (req, reply) => reply.code(201).send(await startRun(req, d, req.body)),
  );
  r.get("/api/v1/autopilot/runs", { config: { permission: "leads.view" } }, (req) => listRuns(req));
  r.get(
    "/api/v1/autopilot/runs/:id",
    { config: { permission: "leads.view" }, schema: { params: id } },
    (req) => getRun(req, req.params.id),
  );
  // Pause, resume, end (spec §2.1–§2.2): the person who started the run, or an admin; take over and hand back: also
  // anyone who may message that lead. Every one is checked in the service.
  for (const what of ["pause", "resume", "end"] as const)
    r.post(
      `/api/v1/autopilot/runs/:id/${what}`,
      { config: { permission: "leads.view" }, schema: { params: id } },
      (req) => controlRun(req, d, req.params.id, what),
    );
  const lead = z.object({ id: z.uuid(), leadId: z.uuid() });
  r.post(
    "/api/v1/autopilot/runs/:id/leads/:leadId/take-over",
    { config: { permission: "leads.view" }, schema: { params: lead } },
    (req) => takeOver(req, req.params.id, req.params.leadId),
  );
  r.post(
    "/api/v1/autopilot/runs/:id/leads/:leadId/hand-back",
    { config: { permission: "leads.view" }, schema: { params: lead } },
    (req) => handBack(req, d, req.params.id, req.params.leadId),
  );
  // Ask me (spec §1.3, §2.1): one tap to send it, or to hand the lead over; and "Let LUME AI carry on" from Ready for
  // you. The person who started the run, or an admin (checked in the service).
  const ask = z.object({ id: z.uuid() });
  r.post(
    "/api/v1/autopilot/asks/:id/approve",
    { config: { permission: "leads.view" }, schema: { params: ask } },
    (req) => approveAsk(req, d, req.params.id),
  );
  r.post(
    "/api/v1/autopilot/asks/:id/decline",
    { config: { permission: "leads.view" }, schema: { params: ask } },
    (req) => declineAsk(req, d, req.params.id),
  );
  r.post(
    "/api/v1/autopilot/runs/:id/leads/:leadId/carry-on",
    { config: { permission: "leads.view" }, schema: { params: lead } },
    (req) => carryOn(req, d, req.params.id, req.params.leadId),
  );
}
