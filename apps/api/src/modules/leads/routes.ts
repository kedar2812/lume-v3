import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { INSTAGRAM_RE, dialCountries, normalizePhone } from "@lume/core";
import { loadFieldRegistry } from "../../leads/fields";
import { findDuplicates } from "./duplicates";
import { arrivalsWhere, countLeads, listLeads } from "./query";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { schema } from "@lume/db";
import { prepareMessage } from "./messages";
import { confirmSend, logReply, messageContext, renderFor } from "./sending";
import type { AppDeps } from "../../app";
import { runBulk } from "./bulk";
import { revealContact } from "./reveal";
import * as svc from "./service";
import { addNote, assignLead, listActivities, moveStage } from "./write";
import { currencySchema } from "../../http/schemas";

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
  currency: currencySchema.nullable().optional(),
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
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){0,19}$/i,
    )
    .optional(),
  ownerId: z.union([z.uuid(), z.enum(["me", "none"])]).optional(),
  tagId: z.uuid().optional(),
  source: z.uuid().optional(),
  phoneStatus: z.enum(["valid", "needs_country", "invalid", "missing"]).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  createdFrom: z.iso.date().optional(),
  createdTo: z.iso.date().optional(),
  arrivedAfter: z.iso.datetime({ offset: true }).optional(),
  custom: z.string().max(2000).optional(),
  // 4B: what's gone quiet (saved views are made of these).
  noReplyDays: z.coerce.number().int().min(1).max(365).optional(),
  lostDaysAgo: z.coerce.number().int().min(0).max(3650).optional(),
  lostReasonId: z.uuid().optional(),
  followUpOverdue: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  createdDays: z.coerce.number().int().min(1).max(365).optional(),
});
/** The list's filters and sort, without paging: what a saved view stores (4B). */
export const filterQuerySchema = listQuery.omit({ cursor: true, limit: true });

export async function leadRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
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
    "/api/v1/leads/counts",
    {
      config: { permission: "leads.view" },
      schema: {
        querystring: listQuery
          .omit({ cursor: true, limit: true, sort: true })
          .extend({ pipelineId: z.uuid() }),
      },
    },
    (req) => countLeads(req, req.query),
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
  r.get("/api/v1/leads/arrivals", { config: { permission: "leads.view" } }, async (req) => {
    const [u] = await req.db
      .select({ at: schema.users.leadsSeenAt })
      .from(schema.users)
      .where(eq(schema.users.id, req.actor!.userId));
    if (!u?.at) return { since: null, count: 0, ids: [] };
    const where = and(isNull(schema.leads.deletedAt), arrivalsWhere(u.at, req.actor!.userId));
    const [c] = await req.db.select({ n: count() }).from(schema.leads).where(where);
    const ids = await req.db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(where)
      .orderBy(desc(schema.leads.createdAt))
      .limit(20);
    return { since: u.at.toISOString(), count: Number(c?.n ?? 0), ids: ids.map((x) => x.id) };
  });
  // The marker moves with the server's clock (amendment A8): leaving Leads, or hiding its tab.
  r.post("/api/v1/leads/arrivals/seen", { config: { permission: "leads.view" } }, async (req, reply) => {
    await req.db
      .update(schema.users)
      .set({ leadsSeenAt: new Date() })
      .where(eq(schema.users.id, req.actor!.userId));
    return reply.code(204).send();
  });
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
  r.post(
    "/api/v1/leads/:id/stage",
    {
      config: { permission: "leads.change_stage" },
      schema: {
        params,
        body: z.object({
          stageId: z.uuid(),
          lostReasonId: z.uuid().optional(),
          lostNote: z.string().trim().max(1000).optional(),
        }),
      },
    },
    async (req) => {
      const lead = await moveStage(req, await svc.visibleLead(req, req.params.id), req.body);
      return { lead: await svc.leadViewFor(req, lead) };
    },
  );
  r.post(
    "/api/v1/leads/:id/assign",
    {
      config: { permission: "leads.assign" },
      schema: {
        params,
        body: z.object({ ownerId: z.uuid().nullable(), reason: z.string().trim().max(200).optional() }),
      },
    },
    async (req) => {
      const { visible } = await assignLead(req, await svc.visibleLead(req, req.params.id), req.body);
      return { id: req.params.id, ownerId: req.body.ownerId, visible };
    },
  );
  r.post(
    "/api/v1/leads/:id/notes",
    {
      config: { permission: "leads.edit" },
      schema: { params, body: z.object({ body: z.string().trim().min(1).max(5000) }) },
    },
    async (req, reply) =>
      reply.code(201).send(await addNote(req, await svc.visibleLead(req, req.params.id), req.body.body)),
  );
  r.get(
    "/api/v1/leads/:id/activities",
    {
      config: { permission: "leads.view" },
      schema: {
        params,
        querystring: z.object({
          cursor: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      },
    },
    async (req) => listActivities(req, await svc.visibleLead(req, req.params.id), req.query),
  );
  r.post(
    "/api/v1/leads/:id/contact/reveal",
    { config: { permission: "leads.contact.reveal", idempotent: false }, schema: { params } },
    async (req, reply) => {
      void reply.header("cache-control", "no-store");
      return revealContact(req, req.params.id);
    },
  );
  r.post(
    "/api/v1/leads/:id/messages/prepare",
    {
      // Never kept for replay: the answer carries the wa.me link, with the number (4C final review #8).
      config: { permission: "messages.send", idempotent: false },
      schema: {
        params,
        body: z.object({
          text: z.string().max(4096).default(""),
          templateVersionId: z.uuid().optional(),
          taskId: z.uuid().optional(),
        }),
      },
    },
    async (req, reply) => {
      void reply.header("cache-control", "no-store");
      const { text, ...from } = req.body;
      return prepareMessage(req, req.params.id, text, from);
    },
  );
  r.post(
    "/api/v1/leads/:id/messages/confirm",
    {
      config: { permission: "messages.send" },
      schema: { params, body: z.object({ sent: z.boolean(), taskId: z.uuid().optional() }) },
    },
    (req) => confirmSend(req, d, req.params.id, req.body),
  );
  // Templates in this lead's words (4A): the preview's context, and the server's own render.
  r.get(
    "/api/v1/leads/:id/messages/context",
    { config: { permission: "messages.send" }, schema: { params } },
    (req) => messageContext(req, req.params.id),
  );
  r.post(
    "/api/v1/leads/:id/messages/render",
    {
      config: { permission: "messages.send" },
      schema: {
        params,
        body: z
          .object({ templateId: z.uuid().optional(), text: z.string().max(4096).optional() })
          .refine((b) => !!b.templateId !== (b.text !== undefined), "A template or your own text"),
      },
    },
    (req) => renderFor(req, req.params.id, req.body),
  );
  r.post("/api/v1/leads/:id/replied", { config: { permission: "leads.edit" }, schema: { params } }, (req) =>
    logReply(req, req.params.id),
  );
  r.post(
    "/api/v1/leads/bulk",
    {
      config: { permission: "leads.bulk_edit" },
      schema: {
        body: z.object({
          ids: z.array(z.uuid()).min(1).max(100),
          action: z.discriminatedUnion("type", [
            z.object({
              type: z.literal("stage"),
              stageId: z.uuid(),
              lostReasonId: z.uuid().optional(),
              lostNote: z.string().trim().max(1000).optional(),
            }),
            z.object({ type: z.literal("assign"), ownerId: z.uuid().nullable() }),
            z.object({
              type: z.literal("tags"),
              add: z.array(z.uuid()).max(20).optional(),
              remove: z.array(z.uuid()).max(20).optional(),
            }),
            z.object({ type: z.literal("delete") }),
            z.object({
              type: z.literal("set_phone_country"),
              country: z
                .string()
                .regex(/^[A-Z]{2}$/)
                .refine((c) => dialCountries().some((d) => d.iso === c), "Unknown country"),
            }),
          ]),
        }),
      },
    },
    (req) => runBulk(req, req.body.ids, req.body.action),
  );
}
