import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { FIELD_TYPES } from "@lume/core";
import * as svc from "./service";

const manage = { permission: "fields.manage" as const };
const params = z.object({ id: z.uuid() });
const COLORS = ["accent", "ok", "warn", "danger", "meet", "cyan", "neutral"] as const;
const option = z.object({
  id: z.string().min(1).max(64).optional(),
  label: z.string().trim().min(1).max(60),
  color: z.enum(COLORS).optional(),
});
const label = z.string().trim().min(1).max(60);

export async function fieldRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/fields", { config: { permission: "leads.view" } }, (req) => svc.listFields(req));
  r.post(
    "/api/v1/fields",
    {
      config: manage,
      schema: {
        body: z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
          label,
          type: z.enum(FIELD_TYPES),
          options: z
            .array(option.omit({ id: true }))
            .max(100)
            .optional(),
          isRequired: z.boolean().optional(),
          isSearchable: z.boolean().optional(),
        }),
      },
    },
    async (req, reply) => reply.code(201).send(await svc.createField(req, req.body)),
  );
  r.patch(
    "/api/v1/fields/:id",
    {
      config: manage,
      schema: {
        params,
        body: z
          .object({
            label: label.optional(),
            options: z.array(option).max(100).optional(),
            isRequired: z.boolean().optional(),
            isSearchable: z.boolean().optional(),
            position: z.number().int().min(0).max(1000).optional(),
            type: z.string().optional(),
          })
          .strict(),
      },
    },
    (req) => svc.updateField(req, req.params.id, req.body),
  );
  r.post("/api/v1/fields/:id/archive", { config: manage, schema: { params } }, async (req, reply) => {
    await svc.archiveField(req, req.params.id);
    return reply.code(204).send();
  });
}
