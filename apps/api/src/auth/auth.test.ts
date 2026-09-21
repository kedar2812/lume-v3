import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({
    extraRoutes: (app) => {
      app.get("/api/v1/t/leads", { config: { permission: "leads.view" } }, async (req) => ({
        user: req.actor!.userId,
      }));
      app.get("/api/v1/t/self", { config: { permission: "auth.self" } }, async () => ({ ok: true }));
      app.post("/api/v1/t/change", { config: { permission: "auth.self" } }, async () => ({ ok: true }));
    },
  });
});
afterAll(async () => h.close());

describe("authentication plugin", () => {
  it("401 without a session, 403 without the permission, 200 with it", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(401);
    const noPerms = await h.signIn(await h.seedUser({ grants: [] }));
    expect((await noPerms.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(403);
    expect((await noPerms.inject({ method: "GET", url: "/api/v1/t/self" })).statusCode).toBe(200);
    const rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] }));
    expect((await rep.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(200);
  });

  it("rejects state changes without a matching CSRF token or from another origin", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    expect((await c.inject({ method: "POST", url: "/api/v1/t/change" })).statusCode).toBe(200);
    expect(
      (await c.inject({ method: "POST", url: "/api/v1/t/change", headers: { "x-csrf-token": "forged" } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await c.inject({
          method: "POST",
          url: "/api/v1/t/change",
          headers: { origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await c.inject({
          method: "POST",
          url: "/api/v1/t/change",
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("disabling a user ends their session on the very next request (report §17 Phase 1)", async () => {
    const u = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const c = await h.signIn(u);
    expect((await c.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(200);
    await h.pool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [u.id]);
    expect((await c.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(401);
    const { rows } = await h.pool.query(
      "SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL",
      [u.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("expires idle sessions (12 h) and absolute ones (7 d)", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    h.clock.advance(11 * 3600_000);
    expect((await c.inject({ method: "GET", url: "/api/v1/t/self" })).statusCode).toBe(200);
    h.clock.advance(12 * 3600_000 + 1);
    expect((await c.inject({ method: "GET", url: "/api/v1/t/self" })).statusCode).toBe(401);
  });

  it("forces two-factor enrolment on roles that require it", async () => {
    const admin = await h.signIn(await h.seedUser({ grants: [{ key: "users.manage", scope: null }] }));
    const r = await admin.inject({ method: "GET", url: "/api/v1/t/self" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("TWO_FACTOR_REQUIRED");
  });

  it("permission changes apply on the next request (NOTIFY busts the cache)", async () => {
    const u = await h.seedUser({ grants: [] });
    const c = await h.signIn(u);
    expect((await c.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(403);
    await h.grant(u.id, [{ key: "leads.view", scope: "own" }]); // inserts + pg_notify('lume_rbac', userId)
    await h.waitForRbacNotify();
    expect((await c.inject({ method: "GET", url: "/api/v1/t/leads" })).statusCode).toBe(200);
  });
});
