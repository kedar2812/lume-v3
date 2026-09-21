import type { FastifyInstance, RouteOptions } from "fastify";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Permission key from the catalog (report §7.2). Required unless `public: true`. */
    permission?: string;
    /** Explicitly unauthenticated (health checks, login, webhooks with their own signatures). */
    public?: boolean;
  }
}

export class RouteDeclarationError extends Error {
  override name = "RouteDeclarationError";
}

/** Collect routes that declare neither a permission nor `public: true`; call the returned assert after `ready()`. */
export function trackRouteDeclarations(app: FastifyInstance): () => void {
  const missing: string[] = [];
  app.addHook("onRoute", (route: RouteOptions) => {
    const cfg = (route.config ?? {}) as { permission?: string; public?: boolean };
    if (!cfg.public && !cfg.permission) missing.push(`${[route.method].flat().join(",")} ${route.url}`);
  });
  return () => {
    if (missing.length) {
      throw new RouteDeclarationError(
        `Routes without a permission or public declaration:\n  ${missing.join("\n  ")}`,
      );
    }
  };
}
