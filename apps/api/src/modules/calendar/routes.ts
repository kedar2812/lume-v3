import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import {
  calendarConnectComplete,
  calendarConnectStart,
  chooseCalendars,
  connectionView,
  disconnectCalendar,
  setCalendarEnabled,
  syncCalendarNow,
} from "./service";

/** A person's own calendar (5A): connecting it is theirs alone, never someone else's. */
const own = { permission: "calendar.connect" as const };

export async function calendarRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/api/v1/calendar/connection", { config: own }, (req) => connectionView(req, d));
  r.post("/api/v1/calendar/connect", { config: own }, (req) => calendarConnectStart(req, d));
  r.post(
    "/api/v1/calendar/complete",
    { config: own, schema: { body: z.object({ p: z.string().max(8000), s: z.string().max(200) }).strict() } },
    (req) => calendarConnectComplete(req, d, req.body),
  );
  r.patch(
    "/api/v1/calendar/connection",
    {
      config: own,
      schema: { body: z.object({ calendars: z.array(z.string().min(1).max(300)).max(50) }).strict() },
    },
    (req) => chooseCalendars(req, d, req.body.calendars),
  );
  r.post("/api/v1/calendar/connection/sync", { config: own }, async (req, reply) =>
    reply.code(202).send(await syncCalendarNow(req, d)),
  );
  r.delete("/api/v1/calendar/connection", { config: own }, (req) => disconnectCalendar(req, d));
  // The module switch, beside Sheets' and Webhooks' in Settings → Integrations.
  r.put(
    "/api/v1/integrations/google-calendar",
    {
      config: { permission: "integrations.manage" },
      schema: { body: z.object({ enabled: z.boolean() }).strict() },
    },
    (req) => setCalendarEnabled(req, d, req.body.enabled),
  );
}
