import type { FastifyInstance, FastifyRequest } from "fastify";
import { can, type LicenceView } from "@lume/core";
import { schema } from "@lume/db";
import { eq } from "drizzle-orm";

/** Owners and admins (people who manage settings) see the payment reminder and may Check now. */
const manages = (req: FastifyRequest) =>
  !!req.actor && (req.actor.isOwner || can(req.actor, "settings.manage"));

export type LicenceForPerson = LicenceView & {
  /** Show the payment reminder now: there is one, this person runs the business, and not closed this session. */
  showNotice: boolean;
  canCheck: boolean;
};

/** The licence as this person sees it (L-A): with /auth/me, and on its own. */
export async function licenceFor(req: FastifyRequest): Promise<LicenceForPerson> {
  const v = req.server.licence.view();
  let dismissed: string | null = null;
  if (v.notice && req.session) {
    const [s] = await req.db
      .select({ d: schema.sessions.noticeDismissed })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, req.session.id));
    dismissed = s?.d ?? null;
  }
  return {
    ...v,
    showNotice: !!v.notice && manages(req) && dismissed !== v.notice.id,
    canCheck: manages(req),
  };
}

/** The licence (licensing L-A): its state for anyone signed in, Check now for admins, and the reminder closed. */
export async function licenceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/licence", { config: { permission: "auth.self" } }, (req) => licenceFor(req));
  app.post(
    "/api/v1/licence/check",
    { config: { permission: "settings.manage", idempotent: false } },
    async (req) => {
      await req.server.licence.check();
      return licenceFor(req);
    },
  );
  // "I'll sort it": closed for this session only; the next sign-in shows it again (ruling R2).
  app.post(
    "/api/v1/licence/notice/dismiss",
    { config: { permission: "auth.self", idempotent: false } },
    async (req, reply) => {
      const notice = req.server.licence.view().notice;
      if (notice && req.session)
        await req.db
          .update(schema.sessions)
          .set({ noticeDismissed: notice.id })
          .where(eq(schema.sessions.id, req.session.id));
      return reply.code(204).send();
    },
  );
}
