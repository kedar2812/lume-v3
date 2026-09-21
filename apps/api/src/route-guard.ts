import type { FastifyInstance, RouteOptions } from "fastify";
import { isPermissionKey, type PermissionKey } from "@lume/core";

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Permission key from the catalog (report §7.2), or `auth.self` for "any signed-in user acting on
     * their own account". Required unless `public: true`.
     */
    permission?: PermissionKey | "auth.self";
    /** Explicitly unauthenticated (health checks, login, webhooks with their own signatures). */
    public?: boolean;
  }
  interface FastifyInstance {
    /** Every registered route and its declaration (read by the access-matrix test). */
    lumeRoutes: readonly DeclaredRoute[];
  }
}

export type DeclaredRoute = {
  method: string;
  url: string;
  config: { public?: boolean; permission?: string };
};

export class RouteDeclarationError extends Error {
  override name = "RouteDeclarationError";
}

/** Collect routes that declare neither a valid permission nor `public: true`; call the returned assert after `ready()`. */
export function trackRouteDeclarations(app: FastifyInstance): () => void {
  const missing: string[] = [];
  const routes: DeclaredRoute[] = [];
  app.decorate("lumeRoutes", routes);
  app.addHook("onRoute", (route: RouteOptions) => {
    const cfg = (route.config ?? {}) as { permission?: string; public?: boolean };
    const label = `${[route.method].flat().join(",")} ${route.url}`;
    for (const method of [route.method].flat()) {
      if (method !== "HEAD")
        routes.push({ method, url: route.url, config: { public: cfg.public, permission: cfg.permission } });
    }
    if (cfg.public) return;
    if (!cfg.permission) missing.push(label);
    else if (cfg.permission !== "auth.self" && !isPermissionKey(cfg.permission))
      missing.push(`${label} (unknown permission "${cfg.permission}")`);
  });
  return () => {
    if (missing.length) {
      throw new RouteDeclarationError(
        `Routes without a valid permission or public declaration:\n  ${missing.join("\n  ")}`,
      );
    }
  };
}
