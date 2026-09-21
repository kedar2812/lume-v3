import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { can, requiresTwoFactor } from "@lume/core";
import { forbidden, unauthorized } from "../http/errors";
import type { AuthSettings } from "../modules/settings/service";
import type { ActorCache } from "../rbac/cache";
import { SESSION_COOKIE } from "./cookies";
import { assertCsrf } from "./csrf";
import { checkLoginRestrictions } from "./restrictions";
import { readSession, sessionPolicy, type SessionPolicy } from "./sessions";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Reachable while a mandatory 2FA enrolment is outstanding (enrolment itself, /auth/me, logout). */
    allowDuringEnrolment?: boolean;
  }
  interface FastifyRequest {
    session: { id: string; stage: "mfa" | "full"; userId: string } | null;
    sessionPolicy: SessionPolicy;
  }
}

export type AuthPluginOptions = {
  pool: pg.Pool;
  cache: ActorCache;
  clock: () => Date;
  publicOrigin: string;
  settings: () => Promise<AuthSettings | null>;
};

/**
 * One onRequest hook, in this order: CSRF → session → actor → login restrictions → 2FA gate → permission.
 * Anything not explicitly allowed is refused (fail closed). Call directly on a scope (not via register)
 * so the hook covers every route in it.
 */
export function authPlugin(app: FastifyInstance, o: AuthPluginOptions): void {
  app.decorateRequest("session", null);
  app.decorateRequest("sessionPolicy", null as unknown as SessionPolicy);

  app.addHook("onRequest", async (req) => {
    const cfg = req.routeOptions.config ?? {};
    assertCsrf(req, o.publicOrigin);
    const settings = await o.settings();
    req.sessionPolicy = sessionPolicy(settings?.security);
    const token = req.cookies[SESSION_COOKIE];
    const now = o.clock();
    const s = token ? await readSession(o.pool, token, now, req.sessionPolicy) : null;
    if (s) req.session = { id: s.id, stage: s.stage, userId: s.userId };

    if (cfg.public) {
      // Public routes may learn who is calling, but nothing is gated on it.
      if (s?.stage === "full") req.actor = await o.cache.get(s.userId);
      return;
    }
    if (!s) throw unauthorized();
    if (s.stage === "mfa") throw unauthorized("TWO_FACTOR_PENDING", "Enter your two-step code to continue");
    const actor = await o.cache.get(s.userId);
    if (!actor) throw unauthorized();
    req.actor = actor;

    if (!actor.isOwner && settings) {
      const verdict = checkLoginRestrictions({
        roles: actor.restrictions,
        ip: req.ip,
        now,
        timezone: settings.timezone,
      });
      if (verdict !== "ok") {
        throw forbidden(
          "LOGIN_RESTRICTED",
          verdict === "ip" ? "Sign-in isn't allowed from this network" : "Sign-in isn't allowed at this time",
        );
      }
    }
    if (requiresTwoFactor(actor) && !actor.twoFactorEnabled && !cfg.allowDuringEnrolment) {
      throw forbidden("TWO_FACTOR_REQUIRED", "Set up two-step sign-in to continue");
    }
    const p = cfg.permission;
    if (p === "auth.self") return;
    if (!p || !can(actor, p)) throw forbidden();
  });
}
