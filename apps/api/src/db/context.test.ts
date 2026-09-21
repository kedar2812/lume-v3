import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../test/harness";
import { HttpError } from "../http/errors";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    extraRoutes: (app) => {
      app.post("/t/write-then-throw", { config: { public: true } }, async (req) => {
        await req.db.execute(sql`INSERT INTO audit_log (action, entity_type) VALUES ('t.thrown', 't')`);
        throw new HttpError(409, "CONFLICT", "boom");
      });
      app.post("/t/write-then-401", { config: { public: true } }, async (req, reply) => {
        await req.db.execute(sql`INSERT INTO audit_log (action, entity_type) VALUES ('t.returned', 't')`);
        return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "no" } });
      });
      app.get("/t/scope", { config: { public: true } }, async (req) => {
        const r = await req.db.execute(sql`SELECT lume_user()::text AS u, lume_scope() AS s`);
        return r.rows[0];
      });
      app.get("/t/nodb", { config: { public: true, db: false } }, async (req) => ({
        hasDb: Boolean(req.db),
      }));
    },
  });
});
afterAll(async () => h.close());

const count = async (action: string) =>
  (await h.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = $1", [action])).rows[0].n;

describe("per-request transaction", () => {
  it("rolls back when the handler throws", async () => {
    const res = await h.app.inject({ method: "POST", url: "/t/write-then-throw", ...(await h.csrf()) });
    expect(res.statusCode).toBe(409);
    expect(await count("t.thrown")).toBe(0);
  });

  it("commits when the handler returns a 4xx (so failed logins still record throttling)", async () => {
    const res = await h.app.inject({ method: "POST", url: "/t/write-then-401", ...(await h.csrf()) });
    expect(res.statusCode).toBe(401);
    expect(await count("t.returned")).toBe(1);
  });

  it("has no RLS scope for anonymous requests and never leaks one between requests", async () => {
    const res = await h.app.inject({ method: "GET", url: "/t/scope" });
    expect(res.json()).toEqual({ u: null, s: null });
  });

  it("returns every connection to the pool", async () => {
    await Promise.all(Array.from({ length: 12 }, () => h.app.inject({ method: "GET", url: "/t/scope" })));
    // Only the lume_rbac LISTEN connection stays checked out.
    expect(h.pool.totalCount - h.pool.idleCount).toBe(1);
  });

  it("routes can opt out of a transaction", async () => {
    expect((await h.app.inject({ method: "GET", url: "/t/nodb" })).json()).toEqual({ hasDb: false });
  });
});
