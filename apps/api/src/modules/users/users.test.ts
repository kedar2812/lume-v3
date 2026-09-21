import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_GRANTS } from "@lume/core";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
let admin: Awaited<ReturnType<Harness["signIn"]>>;
beforeAll(async () => {
  h = await createHarness();
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("users admin", () => {
  it("disabling a user kills every session they have (report §12.1)", async () => {
    const u = await h.seedUser({ grants: [] });
    const s1 = await h.signIn(u);
    const s2 = await h.signIn(u);
    expect((await admin.inject({ method: "POST", url: `/api/v1/users/${u.id}/disable` })).statusCode).toBe(
      204,
    );
    expect((await s1.inject({ method: "GET", url: "/api/v1/auth/me" })).statusCode).toBe(401);
    expect((await s2.inject({ method: "GET", url: "/api/v1/auth/me" })).statusCode).toBe(401);
    expect(
      (
        await h.pool.query("SELECT action FROM audit_log WHERE action = 'user.disabled' AND entity_id = $1", [
          u.id,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it("nobody can disable or demote the owner", async () => {
    const owner = await h.seedUser({ owner: true, totp: true });
    expect(
      (await admin.inject({ method: "POST", url: `/api/v1/users/${owner.id}/disable` })).json().error.code,
    ).toBe("OWNER_PROTECTED");
    expect(
      (
        await admin.inject({ method: "PATCH", url: `/api/v1/users/${owner.id}`, payload: { roleIds: [] } })
      ).json().error.code,
    ).toBe("OWNER_PROTECTED");
  });

  it("changing someone's roles takes effect on their next request", async () => {
    const u = await h.seedUser({ grants: [] });
    const s = await h.signIn(u);
    const {
      rows: [role],
    } = await h.pool.query("INSERT INTO roles (id, name) VALUES (gen_random_uuid(), 'Viewer') RETURNING id");
    await h.pool.query("INSERT INTO role_permissions VALUES ($1, 'audit.view', NULL)", [role.id]);
    expect((await s.inject({ method: "GET", url: "/api/v1/audit" })).statusCode).toBe(403);
    await admin.inject({ method: "PATCH", url: `/api/v1/users/${u.id}`, payload: { roleIds: [role.id] } });
    await h.waitForRbacNotify();
    expect((await s.inject({ method: "GET", url: "/api/v1/audit" })).statusCode).toBe(200);
  });

  it("someone who can manage people cannot hand out access they don't have", async () => {
    const manager = await h.seedUser({ grants: [{ key: "users.manage", scope: null }], totp: true });
    const c = await h.signIn(manager);
    const {
      rows: [powerful],
    } = await h.pool.query(
      "INSERT INTO roles (id, name) VALUES (gen_random_uuid(), 'Powerful') RETURNING id",
    );
    await h.pool.query("INSERT INTO role_permissions VALUES ($1, 'roles.manage', NULL)", [powerful.id]);
    const self = await c.inject({
      method: "PATCH",
      url: `/api/v1/users/${manager.id}`,
      payload: { roleIds: [powerful.id] },
    });
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toMatchObject({
      code: "ESCALATION",
      details: { permissions: ["roles.manage"] },
    });
    const invite = await c.inject({
      method: "POST",
      url: "/api/v1/invites",
      payload: { email: "sneaky@test.lume", name: "S", roleIds: [powerful.id] },
    });
    expect(invite.json().error.code).toBe("ESCALATION");
  });
});
