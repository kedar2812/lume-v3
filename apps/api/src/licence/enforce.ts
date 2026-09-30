import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { LicenceStateName } from "@lume/core";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const LOCKED = {
  read_only: {
    code: "LICENSE_READ_ONLY",
    message:
      "LUME is read-only while its licence is sorted out. You can still look around and export everything.",
  },
  suspended: {
    code: "LICENSE_SUSPENDED",
    message: "LUME is paused. An admin can still export all the data.",
  },
} as const;

const isAuth = (url: string) => url.startsWith("/api/v1/auth/") || url === "/api/v1/csrf";
const isExport = (url: string) => url === "/api/v1/export" || url.startsWith("/api/v1/export/");
const LICENCE_WRITES = new Set(["/api/v1/licence/check", "/api/v1/licence/notice/dismiss"]);
/** Reads done over POST: revealing a masked contact writes only the record of who looked. */
const READS_BY_POST = new Set(["/api/v1/leads/:id/contact/reveal"]);

/**
 * What a locked instance still does (spec §3.4). Read-only: anything that doesn't write, and signing in
 * and out, the licence's own Check now and reminder, and the export. Suspended: signing in, the licence,
 * the business's name (for the lock screen), and the export — nothing else. In both, the steps LUME puts
 * before the app (the agreement, a required two-step enrolment: the routes marked `allowDuringEnrolment`)
 * stay open, or someone who must take them could never reach the export behind them.
 */
export function allowed(
  state: LicenceStateName,
  method: string,
  url: string,
  o: { firstRun?: boolean } = {},
): boolean {
  if (state === "active" || state === "grace") return true;
  if (isAuth(url) || isExport(url) || LICENCE_WRITES.has(url) || o.firstRun) return true;
  if (state === "read_only") return !WRITES.has(method) || READS_BY_POST.has(url);
  return (
    method === "GET" && (url === "/api/v1/licence" || url === "/api/v1/settings" || url === "/api/v1/about")
  );
}

/** Whether LUME should hold back work it does on its own (the follow-up clock, scheduled syncs). */
export const isLocked = (state: LicenceStateName) => state === "read_only" || state === "suspended";

/** The licence enforced on every route of a scope (after authentication, so a 401 stays a 401). */
export function licenceGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const state = req.server.licence.view().state;
    const url = req.routeOptions.url ?? req.url.split("?")[0]!;
    const firstRun = !!(req.routeOptions.config as { allowDuringEnrolment?: boolean } | undefined)
      ?.allowDuringEnrolment;
    if (allowed(state, req.method, url, { firstRun })) return;
    const said = LOCKED[state as "read_only" | "suspended"];
    return reply.code(403).send({ error: said });
  });
}
