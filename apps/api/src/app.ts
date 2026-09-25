import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type pg from "pg";
import type { Keyring } from "@lume/core";
import type { Argon2Params } from "@lume/core/password";
import { csrfRoutes } from "./auth/csrf";
import { authPlugin } from "./auth/plugin";
import type { SetupTokens } from "./auth/setup-token";
import { dbContext } from "./db/context";
import { idempotency } from "./http/idempotency";
import { dbChecks } from "./health";
import type { Mailer } from "./mail/mailer";
import { auditRoutes } from "./modules/audit/routes";
import { catalogRoutes } from "./modules/catalog/routes";
import { fieldRoutes } from "./modules/fields/routes";
import { leadRoutes } from "./modules/leads/routes";
import { peopleRoutes } from "./modules/people/routes";
import { lockoutAlerts } from "./modules/auth/lockout";
import { authRoutes } from "./modules/auth/routes";
import { inviteRoutes } from "./modules/invites/routes";
import { meRoutes } from "./modules/me/routes";
import { pipelineRoutes } from "./modules/pipelines/routes";
import { roleRoutes } from "./modules/roles/routes";
import { settingsRoutes } from "./modules/settings/routes";
import { memoSettings } from "./modules/settings/service";
import { setupRoutes } from "./modules/setup/routes";
import { teamRoutes } from "./modules/teams/routes";
import { userRoutes } from "./modules/users/routes";
import { ActorCache, startRbacListener } from "./rbac/cache";
import { syncPermissionCatalog } from "./rbac/sync";
import { buildServer } from "./server";

export type Clock = () => Date;
export type AppConfig = { publicUrl: string; cookieSecure: boolean };
export type AppDeps = {
  pool: pg.Pool;
  keyring: Keyring;
  mailer: Mailer;
  config: AppConfig;
  clock: Clock;
  setupTokens: SetupTokens;
  isBreached: (pw: string) => boolean;
  argon2: Argon2Params;
  logger?: FastifyServerOptions["logger"];
  /** Observes every `lume_rbac` notification after the cache has handled it (tests). */
  onRbacEvent?: (payload: string) => void;
  /** Tests only: extra routes registered inside the authenticated scope. */
  extraRoutes?: (app: FastifyInstance) => void;
};

/** Composition root: every dependency comes in through `deps`, so tests build the real app. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  await syncPermissionCatalog(deps.pool);
  const cache = new ActorCache(deps.pool);
  const stopListener = await startRbacListener(deps.pool, cache, deps.onRbacEvent);
  try {
    const app = await buildServer({
      checks: dbChecks(deps.pool),
      logger: deps.logger,
      configure: (a) => {
        a.setValidatorCompiler(validatorCompiler);
        a.setSerializerCompiler(serializerCompiler);
      },
      register: async (scope) => {
        scope.addHook("onClose", stopListener);
        scope.decorate("actorCache", cache);
        scope.decorate("fieldRegistryCache", { value: null });
        await scope.register(cookie);
        // Hooks first (called directly so they cover this whole scope), then routes.
        authPlugin(scope, {
          pool: deps.pool,
          cache,
          clock: deps.clock,
          publicOrigin: new URL(deps.config.publicUrl).origin,
          settings: memoSettings(deps.pool),
        });
        dbContext(scope, { pool: deps.pool });
        idempotency(scope); // after dbContext: it needs the request transaction
        await scope.register(csrfRoutes, { secure: deps.config.cookieSecure });
        await scope.register(setupRoutes, deps);
        await scope.register(authRoutes, { ...deps, onLockout: lockoutAlerts(deps) });
        await scope.register(inviteRoutes, deps);
        await scope.register(meRoutes, deps);
        await scope.register(userRoutes, deps);
        await scope.register(roleRoutes);
        await scope.register(teamRoutes);
        await scope.register(settingsRoutes);
        await scope.register(auditRoutes);
        await scope.register(pipelineRoutes);
        await scope.register(fieldRoutes);
        await scope.register(catalogRoutes);
        await scope.register(leadRoutes);
        await scope.register(peopleRoutes);
        deps.extraRoutes?.(scope);
      },
    });
    return app;
  } catch (e) {
    await stopListener();
    throw e;
  }
}
