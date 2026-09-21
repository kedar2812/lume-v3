import type { FastifyReply } from "fastify";

/** __Host- prefix: Secure, Path=/, no Domain; the browser refuses to let a subdomain overwrite it. */
export const SESSION_COOKIE = "__Host-lume_session";
export const CSRF_COOKIE = "__Host-lume_csrf";

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean): void {
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  void reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: "lax", path: "/" });
}
