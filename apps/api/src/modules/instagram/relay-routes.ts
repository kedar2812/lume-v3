import { relayCheck } from "@lume/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { takeRelayNotes } from "./notes";
import { accountMoved, heldAccounts, instagramRelayOf } from "./service";

const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The relay's own calls are signed with this instance's token, within 5 minutes (as its deliveries are). */
export function fromRelay(req: FastifyRequest, d: AppDeps, raw: Buffer): boolean {
  const token = instagramRelayOf(d)?.relayToken;
  if (!token) return false;
  return (
    relayCheck(
      token,
      header(req.headers["x-lume-timestamp"]),
      header(req.headers["x-lume-signature"]),
      raw,
      d.clock().getTime(),
    ) === "ok"
  );
}

const moved = z.object({ accountId: z.string().regex(/^\d{5,30}$/) });

/**
 * What the relay asks of this LUME (NEW_FEATURES_PLAN §4.2), public and outside the session scope, each signed with
 * this instance's relay token: which accounts it holds (the relay rebuilds its routing table from these on start),
 * and that an account was connected to another LUME. Message content never comes this way.
 */
export async function instagramRelayRoutes(app: FastifyInstance, d: AppDeps) {
  app.get("/instagram/accounts", { config: { public: true, csrf: false, db: false } }, async (req, reply) => {
    if (!fromRelay(req, d, Buffer.alloc(0))) return reply.code(401).send({ error: "unauthorized" });
    return { accounts: await heldAccounts(d.pool) };
  });
  // The relay has something kept for this LUME (a gap, Meta's deauthorize or deletion request): fetched from it now,
  // in the background (the hourly run would get it anyway).
  app.post(
    "/instagram/notes",
    { config: { public: true, csrf: false, db: false }, bodyLimit: 4096 },
    async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!fromRelay(req, d, raw)) return reply.code(401).send({ error: "unauthorized" });
      void takeRelayNotes({ ...d, log: req.log }).catch((err: unknown) =>
        req.log.error({ err }, "instagram relay notes failed"),
      );
      return { ok: true };
    },
  );
  app.post(
    "/instagram/moved",
    { config: { public: true, csrf: false, db: false }, bodyLimit: 4096 },
    async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!fromRelay(req, d, raw)) return reply.code(401).send({ error: "unauthorized" });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send({ error: "bad_request" });
      }
      const b = moved.safeParse(parsed);
      if (!b.success) return reply.code(400).send({ error: "bad_request" });
      return { moved: await accountMoved(d.pool, b.data.accountId) };
    },
  );
}
