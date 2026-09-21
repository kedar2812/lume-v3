import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export type ErrorBody = { error: { code: string; message: string; details?: unknown } };

export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply): void {
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
  req.log.error({ err }, "unhandled error");
  void reply
    .code(500)
    .send({ error: { code: "INTERNAL_ERROR", message: "Something went wrong" } } satisfies ErrorBody);
}

export function notFoundHandler(_req: FastifyRequest, reply: FastifyReply): void {
  void reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } } satisfies ErrorBody);
}
