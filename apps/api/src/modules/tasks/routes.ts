import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { cancelTask, createTask, doneTask, leadTasks, nudgeTask, snoozeTask, updateTask } from "./service";
import { today } from "./today";
import { tiles } from "../today/tiles";
import { readFollowUps } from "../settings/follow-ups";

const view = { permission: "leads.view" as const };
const params = z.object({ id: z.uuid() });
const due = z.union([
  z.object({ at: z.iso.datetime({ offset: true }) }).strict(),
  // One of Settings → Follow-ups' time choices, by id (3C); the service knows which exist right now.
  z.object({ preset: z.string().regex(/^[a-z0-9_]{1,40}$/) }).strict(),
]);
const recurrence = z
  .object({
    every: z.number().int().min(1).max(365),
    unit: z.enum(["day", "week"]),
    until: z.iso.date().nullable(),
    stopOn: z.array(z.enum(["won", "lost", "reply_logged"])).max(3),
  })
  .strict();
const fields = {
  title: z.string().trim().max(200).optional(),
  note: z.string().max(2000).nullable().optional(),
  remindMinutes: z.array(z.number().int().min(0).max(43_200)).max(5).optional(),
  recurrence: recurrence.nullable().optional(),
  assigneeId: z.uuid().optional(),
};

/** Phase 3 spec §7: follow-ups on leads. A follow-up is seen exactly when its lead is. */
export async function taskRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/today", { config: { permission: "auth.self" } }, (req) => today(req, d));
  // Today's tiles (the control centre): each one checks its own permission and is left out without it.
  r.get("/api/v1/today/tiles", { config: { permission: "auth.self" } }, (req) => tiles(req, d.clock()));
  // The time choices for the follow-up sheet (3C): names only, in the admin's order.
  r.get("/api/v1/follow-ups/presets", { config: { permission: "auth.self" } }, async (req) => ({
    presets: (await readFollowUps(req)).duePresets.map(({ id, label }) => ({ id, label })),
  }));
  r.get("/api/v1/leads/:id/tasks", { config: view, schema: { params } }, (req) =>
    leadTasks(req, req.params.id),
  );
  r.post(
    "/api/v1/leads/:id/tasks",
    { config: view, schema: { params, body: z.object({ ...fields, due: due.optional() }).strict() } },
    async (req, reply) => reply.code(201).send(await createTask(req, d, req.params.id, req.body)),
  );
  r.patch(
    "/api/v1/tasks/:id",
    { config: view, schema: { params, body: z.object({ ...fields, due: due.optional() }).strict() } },
    (req) => updateTask(req, d, req.params.id, req.body),
  );
  r.post("/api/v1/tasks/:id/done", { config: view, schema: { params } }, (req) =>
    doneTask(req, d, req.params.id),
  );
  r.post(
    "/api/v1/tasks/:id/snooze",
    {
      config: view,
      schema: {
        params,
        body: z.union([
          z.object({ until: z.iso.datetime({ offset: true }) }).strict(),
          z.object({ preset: z.enum(["15m", "1h", "evening", "tomorrow_morning"]) }).strict(),
        ]),
      },
    },
    (req) => snoozeTask(req, d, req.params.id, req.body),
  );
  r.post("/api/v1/tasks/:id/nudge", { config: view, schema: { params } }, async (req, reply) => {
    await nudgeTask(req, req.params.id);
    return reply.code(202).send({ reminded: true });
  });
  r.post("/api/v1/tasks/:id/cancel", { config: view, schema: { params } }, (req) =>
    cancelTask(req, req.params.id),
  );
}
