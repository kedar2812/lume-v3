import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { scheduleMeetingSchema } from "@lume/core";
import { badRequest, forbidden } from "../../http/errors";
import { maySchedule, scheduleMeeting, scheduleReady } from "./schedule";
import { leadMeetings, listMeetings, patchMeeting } from "./service";

const view = { permission: "calendar.view" as const };

export async function meetingRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    "/api/v1/meetings",
    {
      config: view,
      schema: {
        querystring: z
          .object({
            from: z.coerce.date(),
            to: z.coerce.date(),
            ownerId: z.uuid().optional(),
            pipelineId: z.uuid().optional(),
            stageId: z.uuid().optional(),
          })
          .strict(),
      },
    },
    (req) => listMeetings(req, req.query),
  );
  r.get(
    "/api/v1/leads/:id/meetings",
    { config: view, schema: { params: z.object({ id: z.uuid() }) } },
    (req) => leadMeetings(req, req.params.id),
  );
  // Schedule a meeting (owner, 2026-11-13): whether this person can now, and booking one with a Meet link.
  r.get("/api/v1/meetings/schedule/ready", { config: view }, (req) => scheduleReady(req, d));
  r.post(
    "/api/v1/meetings/schedule",
    // The body is checked by the core schema here, so a refusal says what's wrong in words.
    { config: view, schema: { body: z.record(z.string(), z.unknown()) } },
    async (req, reply) => {
      if (!maySchedule(req)) throw forbidden();
      const p = scheduleMeetingSchema.safeParse(req.body);
      if (!p.success) throw badRequest("BAD_MEETING", p.error.issues[0]?.message ?? "That meeting doesn't look right.");
      return reply.code(201).send(await scheduleMeeting(req, d, p.data));
    },
  );
  r.patch(
    "/api/v1/meetings/:id",
    {
      config: view,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z
          .object({
            leadId: z.uuid().optional(),
            status: z.enum(["completed", "no_show", "rescheduled"]).optional(),
            outcomeNote: z.string().trim().max(2000).nullable().optional(),
          })
          .strict(),
      },
    },
    (req) => patchMeeting(req, d, req.params.id, req.body),
  );
}
