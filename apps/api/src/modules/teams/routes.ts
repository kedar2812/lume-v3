import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as teams from "./service";

const cfg = { permission: "teams.manage" as const };
const params = z.object({ id: z.uuid() });
const name = z.object({ name: z.string().trim().min(1).max(60) });

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/teams", { config: cfg }, (req) => teams.listTeams(req));
  r.post("/api/v1/teams", { config: cfg, schema: { body: name } }, async (req, reply) =>
    reply.code(201).send(await teams.createTeam(req, req.body.name)),
  );
  r.patch("/api/v1/teams/:id", { config: cfg, schema: { params, body: name } }, async (req, reply) => {
    await teams.renameTeam(req, req.params.id, req.body.name);
    return reply.code(204).send();
  });
  r.delete("/api/v1/teams/:id", { config: cfg, schema: { params } }, async (req, reply) => {
    await teams.deleteTeam(req, req.params.id);
    return reply.code(204).send();
  });
  r.put(
    "/api/v1/teams/:id/members",
    {
      config: cfg,
      schema: {
        params,
        body: z.object({ members: z.array(z.object({ userId: z.uuid(), isLead: z.boolean() })).max(200) }),
      },
    },
    (req) => teams.setMembers(req, req.params.id, req.body.members),
  );
}
