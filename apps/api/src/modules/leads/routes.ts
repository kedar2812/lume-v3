import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { INSTAGRAM_RE, normalizePhone } from "@lume/core";
import { loadFieldRegistry } from "../../leads/fields";
import { findDuplicates } from "./duplicates";
import { listLeads } from "./query";
import * as svc from "./service";

const params = z.object({ id: z.uuid() });
const money = z.number().nonnegative().max(1e12);
const leadBody = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().max(40).nullable().optional(),
  email: z.email().max(254).nullable().optional(),
  instagram: z.string().regex(INSTAGRAM_RE).nullable().optional(),
  pipelineId: z.uuid().optional(),
  stageId: z.uuid().optional(),
  ownerId: z.uuid().nullable().optional(),
  value: money.nullable().optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional(),
  productId: z.uuid().nullable().optional(),
  leadCreatedAt: z.iso.date().nullable().optional(),
  tagIds: z.array(z.uuid()).max(50).optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});
const listQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z.enum(["newest", "oldest", "updated", "name"]).default("newest"),
  pipelineId: z.uuid().optional(),
  stageId: z
    .string()
    .regex(/^[0-9a-f-]{36}(,[0-9a-f-]{36}){0,19}$/)
    .optional(),
  ownerId: z.union([z.uuid(), z.enum(["me", "none"])]).optional(),
  tagId: z.uuid().optional(),
  phoneStatus: z.enum(["valid", "needs_country", "invalid", "missing"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  createdFrom: z.iso.date().optional(),
  createdTo: z.iso.date().optional(),
  custom: z.string().max(2000).optional(),
});

export async function leadRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    "/api/v1/leads",
    { config: { permission: "leads.view" }, schema: { querystring: listQuery } },
    (req) => listLeads(req, req.query),
  );
  r.post(
    "/api/v1/leads",
    { config: { permission: "leads.create" }, schema: { body: leadBody } },
    async (req, reply) => reply.code(201).send(await svc.createLead(req, req.body)),
  );
  r.get(
    "/api/v1/leads/duplicates",
    {
      config: { permission: "leads.create" },
      schema: {
        querystring: z.object({
          phone: z.string().max(40).optional(),
          email: z.email().max(254).optional(),
          instagram: z.string().regex(INSTAGRAM_RE).optional(),
        }),
      },
    },
    async (req) => {
      const fields = await loadFieldRegistry(req);
      const phone = req.query.phone ? normalizePhone(req.query.phone, fields.defaultCountry) : null;
      return {
        duplicates: await findDuplicates(req, {
          phoneE164: phone?.e164,
          email: req.query.email,
          instagram: req.query.instagram?.replace(/^@/, ""),
        }),
      };
    },
  );
  r.get("/api/v1/leads/:id", { config: { permission: "leads.view" }, schema: { params } }, (req) =>
    svc.getLead(req, req.params.id),
  );
  r.patch(
    "/api/v1/leads/:id",
    { config: { permission: "leads.edit" }, schema: { params, body: leadBody.partial().strict() } },
    (req) => svc.updateLead(req, req.params.id, svc.parseIfMatch(req.headers["if-match"]), req.body),
  );
  r.delete(
    "/api/v1/leads/:id",
    { config: { permission: "leads.delete" }, schema: { params } },
    async (req, reply) => {
      await svc.deleteLead(req, req.params.id);
      return reply.code(204).send();
    },
  );
}
