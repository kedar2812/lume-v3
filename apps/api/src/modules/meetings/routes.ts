import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
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
