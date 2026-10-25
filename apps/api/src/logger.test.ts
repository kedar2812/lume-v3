import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loggerOptions, safeErr } from "./logger";

/**
 * A failed query in the logs (review 2026-10-25): drizzle wraps it with every bound value, in its message and in
 * `params`, and Postgres's own detail can name the value too ("Key (email)=(…) already exists"). None of it may
 * reach the logs: never contact data, never credentials.
 */
class DrizzleQueryErrorLike extends Error {
  constructor(
    public query: string,
    public params: unknown[],
    public override cause: unknown,
  ) {
    super(`Failed query: ${query}\nparams: ${params}`);
  }
}
const pgError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
  code: "23505",
  detail: "Key (email)=(maya@brightpath.test) already exists.",
});
const failed = () =>
  new DrizzleQueryErrorLike(
    "insert into users (email, name, password_hash) values ($1, $2, $3)",
    ["maya@brightpath.test", "Maya Kapoor", "$argon2id$v=19$m=65536$secret"],
    pgError,
  );

describe("an error, as the logs keep it", () => {
  it("its kind, code and the query's shape; never a value it was given", () => {
    const out = JSON.stringify(safeErr(failed()));
    for (const leak of ["maya@brightpath.test", "Maya Kapoor", "argon2id"]) expect(out).not.toContain(leak);
    expect(out).toContain("Failed query: insert into users (email, name, password_hash) values ($1, $2, $3)");
    expect(out).toContain("23505");
    expect(out).toContain("users_email_key");
  });

  it("through the API's own logger, as it runs", async () => {
    let written = "";
    const stream = new Writable({
      write(chunk, _enc, done) {
        written += chunk.toString();
        done();
      },
    });
    const app = Fastify({ logger: { ...loggerOptions("info"), stream } });
    app.log.error({ err: failed() }, "unhandled error");
    await app.close();
    expect(written).toContain("unhandled error");
    expect(written).not.toContain("maya@brightpath.test");
    expect(written).not.toContain("argon2id");
  });
});
