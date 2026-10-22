import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
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
}
