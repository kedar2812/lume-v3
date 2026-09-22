import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../test/harness";
import { HttpError } from "./errors";

let h: Harness;
let c: AuthedClient;
beforeAll(async () => {
  h = await createHarness({
    extraRoutes: (app) => {
      app.post("/api/v1/t/make", { config: { permission: "auth.self" } }, async (req, reply) => {
        await req.db.execute(sql`INSERT INTO audit_log (action, entity_type) VALUES ('t.make', 't')`);
        return reply.code(201).send({ made: (req.body as { n: number }).n, at: Math.random() });
      });
      app.post("/api/v1/t/fail", { config: { permission: "auth.self" } }, async () => {
        throw new HttpError(409, "CONFLICT", "no");
      });
      app.post("/api/v1/t/reveal", { config: { permission: "auth.self", idempotent: false } }, async () => ({
        secret: Math.random(),
      }));
    },
  });
  c = await h.signIn(await h.seedUser({ grants: [] }));
});
afterAll(async () => h.close());

const made = async () =>
  (await h.pool.query("SELECT count(*)::int n FROM audit_log WHERE action = 't.make'")).rows[0].n;
const post = (url: string, body: object, key?: string) =>
  c.inject({ method: "POST", url, payload: body, headers: key ? { "idempotency-key": key } : {} });

describe("Idempotency-Key (report §4.4)", () => {
  it("replays the first response exactly for the same key and body, doing the work once", async () => {
    const a = await post("/api/v1/t/make", { n: 1 }, "key-aaaaaaaa");
    const b = await post("/api/v1/t/make", { n: 1 }, "key-aaaaaaaa");
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(await made()).toBe(1);
  });

  it("refuses the same key with a different request", async () => {
    await post("/api/v1/t/make", { n: 2 }, "key-bbbbbbbb");
    const r = await post("/api/v1/t/make", { n: 3 }, "key-bbbbbbbb");
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("does not remember failures (the client may retry), and without a key does the work each time", async () => {
    expect((await post("/api/v1/t/fail", {}, "key-cccccccc")).statusCode).toBe(409);
    expect(
      (await h.pool.query("SELECT count(*)::int n FROM idempotency_keys WHERE key = 'key-cccccccc'")).rows[0]
        .n,
    ).toBe(0);
    const before = await made();
    await post("/api/v1/t/make", { n: 9 });
    await post("/api/v1/t/make", { n: 9 });
    expect(await made()).toBe(before + 2);
  });

  it("never stores responses of routes that opt out (reveal)", async () => {
    await post("/api/v1/t/reveal", {}, "key-dddddddd");
    expect(
      (await h.pool.query("SELECT count(*)::int n FROM idempotency_keys WHERE key = 'key-dddddddd'")).rows[0]
        .n,
    ).toBe(0);
  });

  it("expires after 24 hours", async () => {
    await post("/api/v1/t/make", { n: 5 }, "key-eeeeeeee");
    await h.ownerPool.query(
      "UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE key = 'key-eeeeeeee'",
    );
    const before = await made();
    expect((await post("/api/v1/t/make", { n: 6 }, "key-eeeeeeee")).statusCode).toBe(201);
    expect(await made()).toBe(before + 1);
  });

  it("rejects malformed keys", async () => {
    expect((await post("/api/v1/t/make", { n: 1 }, "short")).json().error.code).toBe("BAD_IDEMPOTENCY_KEY");
  });
});
