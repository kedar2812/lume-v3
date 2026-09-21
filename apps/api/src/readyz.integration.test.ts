import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { QUEUE_NAMES } from "@lume/core";
import { MIGRATIONS_DIR_DEFAULT, createTestDatabase, installQueueSchema, migrate } from "@lume/db";
import { buildServer } from "./server";
import { dbChecks } from "./health";

describe("/readyz against real Postgres as lume_app", () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterAll(async () => {
    for (const f of cleanup.reverse()) await f();
  });

  it("is 200 when the DB and queue schema are reachable, 503 once the DB is gone", async () => {
    const db = await createTestDatabase();
    await installQueueSchema(db.url("lume_owner"), QUEUE_NAMES);
    await migrate(db.url("lume_owner"), MIGRATIONS_DIR_DEFAULT);
    const pool = new pg.Pool({ connectionString: db.url("lume_app"), max: 2 });
    pool.on("error", () => undefined);
    const app = await buildServer({ checks: dbChecks(pool), readinessTimeoutMs: 2000 });
    cleanup.push(
      () => app.close(),
      () => pool.end().catch(() => undefined),
    );

    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    await db.drop();
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
  });
});
