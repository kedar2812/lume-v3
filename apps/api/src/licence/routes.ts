import type { FastifyInstance, FastifyRequest } from "fastify";
import { can, type LicenceView } from "@lume/core";
import { schema } from "@lume/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "../audit/audit";
import { conflict, forbidden, HttpError } from "../http/errors";

/** Owners and admins (people who manage settings) see the payment reminder and may Check now. */
const manages = (req: FastifyRequest) =>
  !!req.actor && (req.actor.isOwner || can(req.actor, "settings.manage"));

export type LicenceForPerson = LicenceView & {
  instanceId: string | null;
  nextCheckAt: string | null;
  /** Show the payment reminder now: there is one, this person runs the business, and not closed this session. */
  showNotice: boolean;
  canCheck: boolean;
  /** Why the last check brought no new answer: for people who manage settings, else null. */
  lastError: string | null;
  /** The product key (spec 2026-10-15 §1.3): its last four, where it's set, and whether this person may change it. */
  key: { masked: string | null; source: "env" | "stored" | null; canChange: boolean };
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
  const admin = manages(req);
  return {
    ...v,
    // The reminder is between LUME's provider and the people who pay: never sent to anyone else.
    notice: admin ? v.notice : null,
    ...req.server.licence.info(),
    showNotice: !!v.notice && admin && dismissed !== v.notice.id,
    canCheck: admin,
    lastError: admin ? req.server.licence.lastError() : null,
    key: keyFor(req),
  };
}

function keyFor(req: FastifyRequest): LicenceForPerson["key"] {
  const k = req.server.licence;
  const last4 = k.keyLast4();
  const source = k.keySource();
  return {
    masked: last4 ? `LUME-••••-••••-••••-••••-${last4}` : null,
    source,
    canChange: !!req.actor?.isOwner && source !== "env" && !k.dev,
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
  // Change key (spec 2026-10-15 §1.3): the owner only; the new key goes through the same activation, on this
  // install, and replaces the old one only once approved. A key from .env is the server's to change.
  app.post(
    "/api/v1/licence/key",
    {
      config: { permission: "settings.manage", idempotent: false },
      schema: { body: z.object({ key: z.string().min(1).max(128) }).strict() },
    },
    async (req) => {
      if (!req.actor?.isOwner) throw forbidden("OWNER_ONLY", "Only the owner can change the product key");
      if (req.server.licence.keySource() === "env")
        throw conflict("KEY_FROM_ENV", "This LUME's key is set on its server");
      const r = await req.server.licence.activate((req.body as { key: string }).key);
      if (!r.ok)
        throw new HttpError(422, "KEY_REFUSED", "That product key wasn't approved", { reason: r.reason });
      await audit(req, {
        action: "licence.key_changed",
        entityType: "licence",
        entityId: "1",
        diff: { last4: req.server.licence.keyLast4() },
      });
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
