import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomToken, safeEqual } from "@lume/core";
import { forbidden } from "../http/errors";
import { CSRF_COOKIE } from "./cookies";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

declare module "fastify" {
  interface FastifyContextConfig {
    /** false: exempt from CSRF (signed webhooks only). */
    csrf?: boolean;
  }
}

/**
 * Report §12.1 CSRF: SameSite cookies + Origin/Sec-Fetch-Site + double-submit token, on every
 * state-changing request, including public ones (login CSRF is real).
 */
export function assertCsrf(req: FastifyRequest, publicOrigin: string): void {
  if (SAFE.has(req.method) || req.routeOptions.config?.csrf === false) return;
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none")
    throw forbidden("CSRF", "Cross-site request refused");
  const origin = req.headers.origin;
  if (origin && origin !== publicOrigin) throw forbidden("CSRF", "Cross-origin request refused");
  const cookie = req.cookies[CSRF_COOKIE];
  const header = req.headers["x-csrf-token"];
  if (!cookie || typeof header !== "string" || !safeEqual(cookie, header))
    throw forbidden("CSRF", "Missing or invalid CSRF token");
}

export async function csrfRoutes(app: FastifyInstance, opts: { secure: boolean }): Promise<void> {
  app.get("/api/v1/auth/csrf", { config: { public: true } }, async (req, reply) => {
    const existing = req.cookies[CSRF_COOKIE];
    const token = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomToken();
    // Readable by JS on purpose: the page echoes it in X-CSRF-Token (double-submit).
    void reply.setCookie(CSRF_COOKIE, token, {
      httpOnly: false,
      secure: opts.secure,
      sameSite: "lax",
      path: "/",
    });
    return { token };
  });
}
