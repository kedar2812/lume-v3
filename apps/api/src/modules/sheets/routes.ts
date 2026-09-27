import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import {
  createSheetDraft,
  dismissRow,
  getSheet,
  connectComplete,
  connectStart,
  inspectSheet,
  integrationsView,
  listSheets,
  patchSheet,
  problemsCsv,
  removeSheet,
  saveSheet,
  setSheetsEnabled,
  syncNow,
} from "./service";
import { refreshProgress, sheetsStatus, startRefresh } from "./refresh";

const manage = { permission: "integrations.manage" as const };
const params = z.object({ id: z.uuid() });
const name = z.string().trim().min(1).max(120);
const poll = z.number().int().min(60).max(3600);

export async function sheetRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/integrations", { config: manage }, (req) => integrationsView(req, d));
  // Connect with Google (2B-2): a signed start at the relay, and the sealed hand-back coming home.
  r.post("/api/v1/integrations/google/connect", { config: manage }, (req) => connectStart(req, d));
  r.post(
    "/api/v1/integrations/google/complete",
    {
      config: manage,
      schema: { body: z.object({ p: z.string().max(8000), s: z.string().max(200) }).strict() },
    },
    (req) => connectComplete(req, d, req.body),
  );
  r.put(
    "/api/v1/integrations/google-sheets",
    { config: manage, schema: { body: z.object({ enabled: z.boolean() }).strict() } },
    (req) => setSheetsEnabled(req, d, req.body.enabled),
  );
  r.post(
    "/api/v1/sheets/inspect",
    {
      config: manage,
      schema: {
        body: z.union([
          z.object({ link: z.string().max(2000) }).strict(),
          z.object({ connectId: z.uuid() }).strict(),
        ]),
      },
    },
    (req) => inspectSheet(req, d, req.body),
  );
  r.post(
    "/api/v1/sheets/drafts",
    {
      config: { ...manage, idempotent: false },
      schema: {
        body: z.union([
          z
            .object({
              link: z.string().max(2000),
              sheetId: z.number().int().min(0),
              headerRow: z.number().int().min(1).max(10).optional(),
            })
            .strict(),
          z.object({ sourceId: z.uuid() }).strict(),
          z
            .object({
              connectId: z.uuid(),
              sheetId: z.number().int().min(0),
              headerRow: z.number().int().min(1).max(10).optional(),
            })
            .strict(),
        ]),
      },
    },
    async (req, reply) => reply.code(201).send(await createSheetDraft(req, d, req.body)),
  );
  r.post(
    "/api/v1/sheets/sources",
    {
      config: manage,
      schema: {
        body: z
          .object({ importId: z.uuid(), name, pollSeconds: poll, startFrom: z.enum(["all", "new"]) })
          .strict(),
      },
    },
    async (req, reply) => {
      const { view, created } = await saveSheet(req, d, req.body);
      return reply.code(created ? 201 : 200).send(view);
    },
  );
  r.get("/api/v1/sheets/sources", { config: manage }, (req) => listSheets(req, d));
  r.get("/api/v1/sheets/sources/:id", { config: manage, schema: { params } }, (req) =>
    getSheet(req, d, req.params.id),
  );
  r.patch(
    "/api/v1/sheets/sources/:id",
    {
      config: manage,
      schema: {
        params,
        body: z
          .object({ name: name.optional(), pollSeconds: poll.optional(), paused: z.boolean().optional() })
          .strict(),
      },
    },
    (req) => patchSheet(req, d, req.params.id, req.body),
  );
  r.delete("/api/v1/sheets/sources/:id", { config: manage, schema: { params } }, async (req, reply) => {
    await removeSheet(req, req.params.id);
    return reply.code(204).send();
  });
  r.post("/api/v1/sheets/sources/:id/sync", { config: manage, schema: { params } }, (req) =>
    syncNow(req, d, req.params.id),
  );
  r.post(
    "/api/v1/sheets/sources/:id/rows/:rowId/dismiss",
    { config: manage, schema: { params: z.object({ id: z.uuid(), rowId: z.coerce.number().int().min(1) }) } },
    async (req, reply) => {
      await dismissRow(req, req.params.id, req.params.rowId);
      return reply.code(204).send();
    },
  );
  r.get(
    "/api/v1/sheets/sources/:id/problems.csv",
    { config: manage, schema: { params } },
    async (req, reply) => {
      const { fileName, body } = await problemsCsv(req, d, req.params.id);
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
        .send(body);
    },
  );
  const view = { permission: "leads.view" as const };
  r.get("/api/v1/sheets/status", { config: view }, (req) => sheetsStatus(req, d));
  r.post("/api/v1/sheets/refresh", { config: { ...view, idempotent: false } }, (req) => startRefresh(req, d));
  r.get("/api/v1/sheets/refresh/:id", { config: view, schema: { params } }, (req) =>
    refreshProgress(req, req.params.id),
  );
}
