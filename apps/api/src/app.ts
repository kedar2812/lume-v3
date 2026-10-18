import { exportRoutes } from "./export/routes";
import { licenceGuard } from "./licence/enforce";
import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type pg from "pg";
import { PLAN_MODULES, PLAN_V1_MODULES, type Keyring } from "@lume/core";
import type { AiProvider } from "./ai/provider";
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
import { ErrorWindow, healthReport } from "./licence/health-report";
import { applyPlan } from "./licence/plan";
import { LicenceKeeper } from "./licence/keeper";
import { licenceRoutes } from "./licence/routes";
import { feedbackRoutes } from "./modules/feedback/routes";
import type { LicenceOptions } from "./licence/options";
import { queueRoutes } from "./modules/queues/routes";
import { importRoutes } from "./modules/imports/routes";
import { sheetRoutes } from "./modules/sheets/routes";
import { calendarRoutes } from "./modules/calendar/routes";
import { meetingRoutes } from "./modules/meetings/routes";
import { calendlyRoutes } from "./modules/calendly/routes";
import { calendlyReceiveRoutes } from "./modules/calendly/receive";
import { serverHelpers } from "./server-helpers";
import type { GoogleSheets } from "./modules/sheets/google";
import type { Limiter } from "./modules/webhooks/limits";
import { receiveRoutes } from "./modules/webhooks/receive";
import { webhookRoutes } from "./modules/webhooks/routes";
import { taskRoutes } from "./modules/tasks/routes";
import { healthRoutes } from "./modules/health/routes";
import { templateRoutes } from "./modules/templates/routes";
import { viewRoutes } from "./modules/views/routes";
import { notificationRoutes } from "./modules/notifications/routes";
import { peopleRoutes } from "./modules/people/routes";
import { analyticsRoutes } from "./modules/analytics/routes";
import { securityRoutes } from "./modules/security/routes";
import { leadExportRoutes } from "./modules/lead-exports/routes";
import { aiRoutes } from "./modules/ai/routes";
import { whatsappRoutes } from "./modules/whatsapp/routes";
import { whatsappReceiveRoutes } from "./modules/whatsapp/receive";
import { lockoutAlerts } from "./modules/auth/lockout";
import { authRoutes } from "./modules/auth/routes";
import { inviteRoutes } from "./modules/invites/routes";
import { meRoutes } from "./modules/me/routes";
import { pipelineRoutes } from "./modules/pipelines/routes";
import { roleRoutes } from "./modules/roles/routes";
import { settingsRoutes } from "./modules/settings/routes";
import { aboutRoutes } from "./modules/about/routes";
import type { RateSource } from "./money/rates";
import { memoSettings } from "./modules/settings/service";
import { setupRoutes } from "./modules/setup/routes";
import { teamRoutes } from "./modules/teams/routes";
import { userRoutes } from "./modules/users/routes";
import { ActorCache, startRbacListener } from "./rbac/cache";
import { syncPermissionCatalog } from "./rbac/sync";
import { buildServer } from "./server";

export type Clock = () => Date;
export type AppConfig = { publicUrl: string; cookieSecure: boolean; version?: string };
export type AppDeps = {
  pool: pg.Pool;
  keyring: Keyring;
  mailer: Mailer;
  config: AppConfig;
  clock: Clock;
  setupTokens: SetupTokens;
  isBreached: (pw: string) => boolean;
  argon2: Argon2Params;
  /** Exchange rates for switching the business currency (defaults to open.er-api.com). */
  rates?: RateSource;
  logger?: FastifyServerOptions["logger"];
  /** Observes every `lume_rbac` notification after the cache has handled it (tests). */
  onRbacEvent?: (payload: string) => void;
  /** Where a started import is queued (pg-boss in production, an inline list in tests). */
  imports?: { enqueue(id: string): Promise<void> };
  /** LUME AI (spec 2026-10-18 §2.1): the provider this server reads notes with, or null when none is set up. */
  ai?: AiProvider | null;
  /** Tests only: how long a read may take before it's given up (20 s otherwise). */
  aiTimeoutMs?: number;
  /** Where a bulk run over the inline limit is queued (7B: pg-boss in production, a list in tests). */
  bulk?: { enqueue(id: string): Promise<void> };
  /**
   * Connections for work that runs beside a request (an import preview's all-leads lookup) or with no
   * request (the import job). Never the request pool: a request must not wait on the pool it holds.
   */
  jobPool?: pg.Pool;
  /** Google Sheets (2B spec): the read-only client when this server has a service-account key, else null. */
  google?: GoogleSheets | null;
  /** The sheet sync queue in this process, and the most rows a sheet may have (LUME_SHEETS_MAX_ROWS). */
  sheets?: { enqueue(syncId: string): Promise<void>; maxRows: number };
  /** Google Calendar (5A): where a connection's sync is queued. */
  calendar?: { enqueue(connectionId: string): Promise<void> };
  /** Connect with Google (2B-2): the owner's relay and this instance's token there; null when not set up. */
  googleOAuth?: { relayUrl: string; relayToken: string } | null;
  /** Tests and e2e only: where the Google APIs are (the fake). */
  googleEndpoint?: string;
  /**
   * WhatsApp (spec 2026-10-18 §3): Meta's Graph API, which this server calls with each number's own token (media,
   * disconnecting). Connecting goes through the relay (googleOAuth), so WhatsApp needs both.
   */
  meta?: { graphUrl: string; version: string } | null;
  /** WhatsApp's queues (plan W1 Tasks 5–7): an event to make into lead activity, a media item to fetch. */
  whatsapp?: { enqueue(eventId: number): Promise<void>; enqueueMedia(mediaId: string): Promise<void> };
  /** Tests and e2e only: where Calendly's API is (the fake, 5B). */
  calendlyEndpoint?: string;
  /** Tests only: how the Calendly client waits between retries (no real 1-2-4 s). */
  calendlyWait?: (ms: number) => Promise<void>;
  /** Webhooks (2C): where an accepted post is queued, and (tests) the rate limiter to use. */
  webhooks?: { enqueue(eventId: number): Promise<void>; limiter?: Limiter };
  /** Follow-ups (Phase 3): where a reminder is queued for its time. */
  tasks?: {
    enqueue(reminders: { id: number; fireAt: Date }[]): Promise<void>;
    /** When the sweeper last ran (3C System health); set once the queue is running. */
    lastSweepAt?: () => Date | null;
    /** When the follow-up queue started (health: a moment to catch up before "late" means stopped). */
    startedAt?: Date;
  };
  /** LUME_MANYCHAT_PRESET=on: offer the ManyChat preset (hidden until verified, 2C spec §2). */
  manychatPreset?: boolean;
  /** Tests only: extra routes registered inside the authenticated scope. */
  extraRoutes?: (app: FastifyInstance, deps: AppDeps) => void;
  /** The licence (licensing L-A): how it's checked. Unset: a development build's licence, always active. */
  licence?: LicenceOptions;
};

declare module "fastify" {
  interface FastifyInstance {
    /** What this instance knows of its licence, and the one place that checks it (licensing L-A). */
    licence: LicenceKeeper;
  }
}

/** Composition root: every dependency comes in through `deps`, so tests build the real app. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  await syncPermissionCatalog(deps.pool);
  const cache = new ActorCache(deps.pool);
  const stopListener = await startRbacListener(deps.pool, cache, deps.onRbacEvent);
  const licence = new LicenceKeeper(
    deps.pool,
    deps.licence ?? { mode: "dev", instanceId: null, licenseKey: null, url: "", keys: {}, version: "dev" },
    deps.clock,
    undefined,
    deps.keyring,
  );
  await licence.refresh();
  // Fleet (spec 2026-10-16 fleet §1.1): its health goes with each check-in — counts and fixed keys only.
  const errors = new ErrorWindow();
  const startedAt = deps.clock();
  licence.reportHealth(() =>
    healthReport(deps.pool, {
      now: deps.clock(),
      startedAt,
      errors24h: errors.count(deps.clock()),
      ...(deps.tasks?.lastSweepAt ? { lastSweepAt: deps.tasks.lastSweepAt } : {}),
      ...(deps.tasks?.startedAt ? { queueStartedAt: deps.tasks.startedAt } : {}),
      // A licence server that signs LUME AI in a plan knows it; until one has, only the modules every server knows.
      reportable:
        licence.view().plan && "ai" in licence.view().plan!.modules ? PLAN_MODULES : PLAN_V1_MODULES,
    }),
  );
  // Control each client (spec 2026-10-17 control §2.2): a module the plan leaves out is switched off once.
  licence.keepPlan((plan) => applyPlan(deps.pool, plan));
  try {
    const app = await buildServer({
      checks: dbChecks(deps.pool),
      logger: deps.logger,
      // Posts from outside: 2C's webhooks, then Calendly's (5B), sharing one raw-body parser and licence guard.
      open: async (a) => {
        await receiveRoutes(a, deps);
        await calendlyReceiveRoutes(a, deps);
        await whatsappReceiveRoutes(a, deps);
      },
      configure: (a) => {
        a.decorate("licence", licence);
        a.addHook("onClose", async () => licence.stop());
        // Server errors, counted for the health a check-in carries (no detail kept: a count by the hour).
        a.addHook("onResponse", async (_req, reply) => {
          if (reply.statusCode >= 500) errors.add(deps.clock());
        });
        a.setValidatorCompiler(validatorCompiler);
        a.setSerializerCompiler(serializerCompiler);
      },
      register: async (scope) => {
        scope.addHook("onClose", stopListener);
        scope.decorate("actorCache", cache);
        scope.decorate("fieldRegistryCache", { value: null });
        // Notifications (3B), stage automations' needs (3C), settling reminders: one set, shared with jobs.
        const helpers = serverHelpers({ pool: deps.pool, tasks: deps.tasks });
        scope.decorate("notify", helpers.notify);
        scope.decorate("automationDeps", helpers.automationDeps);
        scope.decorate("settleReminders", helpers.settleReminders);
        scope.decorate("notifyNameOf", helpers.notifyNameOf);
        // The watch (6A): it tells admins on the pool once an alert has committed.
        scope.decorate("watch", { pool: deps.pool, clock: deps.clock });
        await scope.register(cookie);
        // Hooks first (called directly so they cover this whole scope), then routes.
        authPlugin(scope, {
          pool: deps.pool,
          cache,
          clock: deps.clock,
          publicOrigin: new URL(deps.config.publicUrl).origin,
          settings: memoSettings(deps.pool),
        });
        // The licence (L-A): after authentication, so a 401 stays a 401; before any work.
        licenceGuard(scope);
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
        await scope.register(settingsRoutes, deps);
        await scope.register(aboutRoutes, deps);
        await scope.register(auditRoutes);
        await scope.register(pipelineRoutes);
        await scope.register(fieldRoutes);
        await scope.register(catalogRoutes);
        await scope.register(leadRoutes, deps);
        await scope.register(importRoutes, deps);
        await scope.register(sheetRoutes, deps);
        await scope.register(calendarRoutes, deps);
        await scope.register(meetingRoutes, deps);
        await scope.register(calendlyRoutes, deps);
        await scope.register(webhookRoutes, deps);
        await scope.register(taskRoutes, deps);
        await scope.register(healthRoutes, deps);
        await scope.register(templateRoutes);
        await scope.register(viewRoutes);
        await scope.register(licenceRoutes);
        await scope.register(feedbackRoutes);
        await scope.register(exportRoutes, deps);
        await scope.register(queueRoutes, deps);
        await scope.register(notificationRoutes, deps);
        await scope.register(peopleRoutes);
        await scope.register(analyticsRoutes, deps);
        await scope.register(securityRoutes, deps);
        await scope.register(leadExportRoutes, deps);
        await scope.register(aiRoutes, deps);
        await scope.register(whatsappRoutes, deps);
        deps.extraRoutes?.(scope, deps);
      },
    });
    return app;
  } catch (e) {
    await stopListener();
    throw e;
  }
}
