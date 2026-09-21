/** Thrown by services; the error handler turns it into { error: { code, message, details? } } (report §4.4). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (code = "UNAUTHENTICATED", message = "Sign in to continue") =>
  new HttpError(401, code, message);
export const forbidden = (code = "FORBIDDEN", message = "You don't have access to this") =>
  new HttpError(403, code, message);
export const notFound = (code = "NOT_FOUND", message = "Not found") => new HttpError(404, code, message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const tooMany = (retryAfterSec: number) =>
  new HttpError(429, "TOO_MANY_ATTEMPTS", "Too many attempts. Try again shortly.", { retryAfterSec });
