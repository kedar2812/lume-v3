import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { liveSheetConnectComplete, liveSheetConnectStart, myGrants } from "./connect";
import {
  countBody,
  countSheet,
  createBody,
  createSheet,
  deleteSheet,
  editBody,
  editSheet,
  listSheets,
  oneSheet,
  pauseSheet,
  remakeSheet,
  resumeSheet,
  runSheet,
  takeOverSheet,
} from "./service";

/** Live sheets (spec 2026-11-14): every route needs Make live sheets; Export leads and the rest are said in words. */
const live = { permission: "leads.live_sheets" as const };
const params = z.object({ id: z.uuid() });

export async function liveSheetRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post("/api/v1/live-sheets/connect", { config: live }, (req) => liveSheetConnectStart(req, d));
  r.post(
    "/api/v1/live-sheets/connect/complete",
    {
      config: live,
      schema: { body: z.object({ p: z.string().min(1).max(8000), s: z.string().min(1).max(200) }) },
    },
    (req) => liveSheetConnectComplete(req, d, req.body),
  );
  r.get("/api/v1/live-sheets/grants", { config: live }, (req) => myGrants(req));

  r.get("/api/v1/live-sheets", { config: live }, (req) => listSheets(req, d));
  r.post("/api/v1/live-sheets/count", { config: live, schema: { body: countBody } }, (req) =>
    countSheet(req, d, req.body),
  );
  r.post("/api/v1/live-sheets", { config: live, schema: { body: createBody } }, async (req, reply) =>
    reply.code(201).send(await createSheet(req, d, req.body)),
  );
  r.get("/api/v1/live-sheets/:id", { config: live, schema: { params } }, (req) =>
    oneSheet(req, req.params.id),
  );
  r.patch("/api/v1/live-sheets/:id", { config: live, schema: { params, body: editBody } }, (req) =>
    editSheet(req, d, req.params.id, req.body),
  );
  r.post("/api/v1/live-sheets/:id/run", { config: live, schema: { params } }, (req) =>
    runSheet(req, d, req.params.id),
  );
  r.post("/api/v1/live-sheets/:id/pause", { config: live, schema: { params } }, (req) =>
    pauseSheet(req, d, req.params.id),
  );
  r.post("/api/v1/live-sheets/:id/resume", { config: live, schema: { params } }, (req) =>
    resumeSheet(req, d, req.params.id),
  );
  r.post("/api/v1/live-sheets/:id/take-over", { config: live, schema: { params } }, (req) =>
    takeOverSheet(req, d, req.params.id),
  );
  r.post("/api/v1/live-sheets/:id/remake", { config: live, schema: { params } }, (req) =>
    remakeSheet(req, d, req.params.id),
  );
  r.delete(
    "/api/v1/live-sheets/:id",
    { config: live, schema: { params, querystring: z.object({ trash: z.enum(["1"]).optional() }) } },
    (req) => deleteSheet(req, d, req.params.id, req.query.trash === "1"),
  );
}
