import { drizzle } from "drizzle-orm/node-postgres";
import { ALL_GRANTS, PAUSED_MESSAGE } from "@lume/core";
import { schema } from "@lume/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import type { Db } from "../../db/context";
import { raiseAlert } from "./alerts";
import { restoreUser, suspendUser } from "./suspend";

/** Phase 6A Task 4: a paused person can't sign in, and is told why — on every request, not a bare 401. */
let h: Harness;
let admin: AuthedClient;
let adminUser: SeededUser;
let rory: SeededUser;
let roryClient: AuthedClient;

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Hana Ito" });
  admin = await h.signIn(adminUser);
});
afterAll(() => h.close());
beforeEach(async () => {
  rory = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Rory Reid" });
  roryClient = await h.signIn(rory);
});

async function asLume<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const c = await h.pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(drizzle(c, { schema }));
    await c.query("COMMIT");
    return out;
  } finally {
    c.release();
  }
}
async function pause(userId: string) {
  const a = await asLume((db) =>
    raiseAlert(db, { userId, rule: "reveals", observed: 31, threshold: 30, action: "suspended", tz: "UTC" }),
  );
  await asLume((db) => suspendUser(db, userId, h.clock.now, a.id));
  await h.waitForRbacNotify();
  return a.id;
}
const login = (email: string, password: string) =>
  h.csrf().then((c) =>
    h.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: c.headers,
      cookies: c.cookies,
      payload: { email, password },
    }),
  );
const SUSPENDED = { error: { code: "SUSPENDED", message: PAUSED_MESSAGE } };

describe("a paused person's live cookie (Review Focus 2)", () => {
  it("is refused as SUSPENDED on every route: reading, writing, the live stream", async () => {
    await pause(rory.id);
    const me = await roryClient.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(me.statusCode).toBe(403);
    expect(me.json()).toEqual(SUSPENDED);
    const write = await roryClient.inject({
      method: "POST",
      url: "/api/v1/leads",
      payload: { name: "Taken" },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe("SUSPENDED");
    const stream = await roryClient.inject({ method: "GET", url: "/api/v1/stream" });
    expect(stream.statusCode).toBe(403);
    expect(stream.json().error.code).toBe("SUSPENDED");
  });

  it("on a public route, is simply signed out", async () => {
    await pause(rory.id);
    const r = await roryClient.inject({ method: "GET", url: "/api/v1/setup/status" });
    expect(r.statusCode).toBe(200);
  });

  it("a disabled person's cookie still gets a plain sign-in-again", async () => {
    await admin.inject({ method: "POST", url: `/api/v1/users/${rory.id}/disable`, payload: {} });
    const r = await roryClient.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(r.statusCode).toBe(401);
  });
});

describe("signing in while paused", () => {
  it("the right password is told why, and gets no session", async () => {
    await pause(rory.id);
    const r = await login(rory.email, rory.password);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual(SUSPENDED);
    expect(r.cookies.find((c) => c.name === "__Host-lume_session")).toBeUndefined();
  });

  it("a wrong password learns nothing about the account", async () => {
    await pause(rory.id);
    const r = await login(rory.email, "not the password at all, no");
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("restored, they sign in and are let through at once (Review Focus 4)", async () => {
    await pause(rory.id);
    await asLume((db) => restoreUser(db, rory.id, adminUser.id));
    await h.waitForRbacNotify();
    const r = await login(rory.email, rory.password);
    expect(r.statusCode).toBe(200);
    const cookie = r.cookies.find((c) => c.name === "__Host-lume_session")!.value;
    const me = await h.app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      cookies: { "__Host-lume_session": cookie },
    });
    expect(me.statusCode).toBe(200);
  });
});

describe("People and a paused person", () => {
  it("disabling them offboards their open alerts", async () => {
    const alertId = await pause(rory.id);
    const r = await admin.inject({ method: "POST", url: `/api/v1/users/${rory.id}/disable`, payload: {} });
    expect(r.statusCode).toBe(204);
    const row = (
      await h.pool.query("SELECT status, resolution, resolved_by FROM security_alerts WHERE id = $1", [
        alertId,
      ])
    ).rows[0];
    expect(row).toEqual({ status: "resolved", resolution: "offboarded", resolved_by: adminUser.id });
    expect((await h.pool.query("SELECT status FROM users WHERE id = $1", [rory.id])).rows[0].status).toBe(
      "disabled",
    );
  });

  it("Enable never lets a paused person back in: that's Restore, in Security", async () => {
    await pause(rory.id);
    const r = await admin.inject({ method: "POST", url: `/api/v1/users/${rory.id}/enable` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("PAUSED");
    expect((await h.pool.query("SELECT status FROM users WHERE id = $1", [rory.id])).rows[0].status).toBe(
      "suspended",
    );
  });
});
