import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { anomalySchema, watermarkSchema } from "@lume/core";
import * as svc from "./service";

const cfg = { permission: "security.manage" as const };
const params = z.object({ id: z.uuid() });
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const loginHours = z
  .object({
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    from: hhmm,
    to: hhmm,
    business: z.literal(true).optional(),
  })
  .refine((h) => h.from < h.to, { message: "The hours must end after they start" });
const network = z.ipv4().or(z.ipv6()).or(z.cidrv4()).or(z.cidrv6());

/** Settings → Security (6A): the rules and the watermark, alerts and their review, access limits per role. */
export async function securityRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get("/api/v1/security/settings", { config: cfg }, (req) => svc.readSecurity(req));
  r.put(
    "/api/v1/security/settings",
    { config: cfg, schema: { body: z.object({ anomaly: anomalySchema, watermark: watermarkSchema }) } },
    (req) => svc.saveSecurity(req, req.body),
  );

  r.get(
    "/api/v1/security/alerts",
    {
      config: cfg,
      schema: { querystring: z.object({ status: z.enum(["open", "recent"]).default("recent") }) },
    },
    (req) => svc.listAlerts(req, req.query.status),
  );
  r.get("/api/v1/security/alerts/:id", { config: cfg, schema: { params } }, (req) =>
    svc.alertDetail(req, req.params.id),
  );
  r.post(
    "/api/v1/security/alerts/:id/resolve",
    {
      config: cfg,
      schema: { params, body: z.object({ resolution: z.enum(["restored", "kept_suspended", "dismissed"]) }) },
    },
    (req) => svc.resolveAlert(req, req.params.id, req.body.resolution),
  );
  r.post("/api/v1/security/people/:id/restore", { config: cfg, schema: { params } }, async (req, reply) => {
    await svc.restorePerson(req, req.params.id);
    return reply.code(204).send();
  });

  r.get("/api/v1/security/access", { config: cfg }, (req) => svc.readAccess(req));
  r.put(
    "/api/v1/security/access/:id",
    {
      config: cfg,
      schema: {
        params,
        body: z.object({
          loginHours: loginHours.nullable(),
          ipAllowlist: z.array(network).max(50).nullable(),
        }),
      },
    },
    (req) => svc.saveAccess(req, req.params.id, req.body),
  );
}
