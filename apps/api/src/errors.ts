import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { markRequestFailed } from "./db/context";
import { HttpError } from "./http/errors";

export type ErrorBody = { error: { code: string; message: string; details?: unknown } };

export function errorHandler(err: FastifyError | HttpError, req: FastifyRequest, reply: FastifyReply): void {
  // A thrown error always rolls the request transaction back, whatever status it maps to.
  markRequestFailed(req);
  if (err instanceof HttpError) {
    const retry = (err.details as { retryAfterSec?: unknown } | undefined)?.retryAfterSec;
    if (err.status === 429 && typeof retry === "number") void reply.header("Retry-After", String(retry));
    void reply.code(err.status).send({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    } satisfies ErrorBody);
    return;
  }
  if (err.validation) {
    void reply.code(400).send({
      error: { code: "VALIDATION_FAILED", message: "Request is invalid", details: err.validation },
    } satisfies ErrorBody);
    return;
  }
  const status = err.statusCode ?? 500;
  if (status < 500) {
    void reply
      .code(status)
      .send({ error: { code: err.code ?? "BAD_REQUEST", message: err.message } } satisfies ErrorBody);
    return;
  }
  // The database stopped a query that ran past the statement timeout, or no connection came free in time: a
  // moment's overload, not a fault. Said in LUME's words, with when to try again; logged for the operator.
  const pgCode = (err as { code?: unknown }).code;
  if (pgCode === "57014" || /timeout exceeded when trying to connect/.test(err.message)) {
    const slow = pgCode === "57014";
    req.log.warn({ err }, slow ? "query stopped by the statement timeout" : "no database connection in time");
    void reply
      .code(503)
      .header("Retry-After", "5")
      .send({
        error: slow
          ? { code: "TOO_SLOW", message: "LUME took too long to answer that. Try again in a moment." }
          : { code: "BUSY", message: "LUME is busy right now. Try again in a moment." },
      } satisfies ErrorBody);
    return;
  }
  req.log.error({ err }, "unhandled error");
  void reply
    .code(500)
    .send({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } } satisfies ErrorBody);
}

export function notFoundHandler(_req: FastifyRequest, reply: FastifyReply): void {
  void reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } } satisfies ErrorBody);
}
