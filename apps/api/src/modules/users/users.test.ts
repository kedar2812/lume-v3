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

  it("offers someone who manages people exactly the roles they are allowed to give", async () => {
    const manager = await h.seedUser({
      grants: [
        { key: "users.manage", scope: null },
        { key: "leads.view", scope: "own" },
      ],
      totp: true,
    });
    const c = await h.signIn(manager);
    const make = async (name: string, grants: [string, string | null][]) => {
      const {
        rows: [r],
      } = await h.pool.query("INSERT INTO roles (id, name) VALUES (gen_random_uuid(), $1) RETURNING id", [
        name,
      ]);
      for (const [key, scope] of grants)
        await h.pool.query("INSERT INTO role_permissions VALUES ($1, $2, $3)", [r.id, key, scope]);
      return r.id as string;
    };
    const giveable = await make("Assignable Viewer", [["leads.view", "own"]]);
    const wider = await make("Assignable Wider", [["leads.view", "all"]]);
    const res = await c.inject({ method: "GET", url: "/api/v1/roles/assignable" });
    expect(res.statusCode).toBe(200);
    const ids = res.json().roles.map((r: { id: string }) => r.id);
    expect(ids).toContain(giveable);
    expect(ids).not.toContain(wider); // "all" is more than this person holds
    expect(res.json().roles.find((r: { id: string }) => r.id === giveable)).toEqual({
      id: giveable,
      name: "Assignable Viewer",
      color: expect.any(String),
    });
    // Someone who holds every grant is offered every role.
    const all = (await admin.inject({ method: "GET", url: "/api/v1/roles/assignable" })).json().roles;
    expect(all.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([giveable, wider]));
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

  it("disabling someone can hand their leads to a colleague", async () => {
    const leaving = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const taking = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const one = await h.seedLead({ ownerId: leaving.id });
    const two = await h.seedLead({ ownerId: leaving.id });
    const r = await admin.inject({
      method: "POST",
      url: `/api/v1/users/${leaving.id}/disable`,
      payload: { reassignTo: taking.id },
    });
    expect(r.statusCode).toBe(204);
    for (const id of [one, two])
      expect((await admin.inject({ method: "GET", url: `/api/v1/leads/${id}` })).json().lead.ownerId).toBe(
        taking.id,
      );
    const logged = await h.pool.query(
      "SELECT diff FROM audit_log WHERE action = 'user.disabled' AND entity_id = $1",
      [leaving.id],
    );
    expect(logged.rows[0].diff).toEqual({ reassignedTo: taking.id, leads: 2 });
  });

  it("disabling someone can leave their leads unassigned, or keep them as they are", async () => {
    const a = await h.seedUser({ grants: [] });
    const lead = await h.seedLead({ ownerId: a.id });
    await admin.inject({
      method: "POST",
      url: `/api/v1/users/${a.id}/disable`,
      payload: { reassignTo: null },
    });
    expect(
      (await admin.inject({ method: "GET", url: `/api/v1/leads/${lead}` })).json().lead.ownerId,
    ).toBeNull();
    const b = await h.seedUser({ grants: [] });
    const kept = await h.seedLead({ ownerId: b.id });
    await admin.inject({ method: "POST", url: `/api/v1/users/${b.id}/disable`, payload: {} });
    expect((await admin.inject({ method: "GET", url: `/api/v1/leads/${kept}` })).json().lead.ownerId).toBe(
      b.id,
    );
  });

  it("refuses to disable yourself or the owner, or to hand leads to someone who can't take them", async () => {
    const me = await h.seedUser({ grants: ALL_GRANTS, totp: true });
    const c = await h.signIn(me);
    const self = await c.inject({ method: "POST", url: `/api/v1/users/${me.id}/disable`, payload: {} });
    expect(self.json().error.code).toBe("SELF");
    const target = await h.seedUser({ grants: [] });
    const bad = await c.inject({
      method: "POST",
      url: `/api/v1/users/${target.id}/disable`,
      payload: { reassignTo: "0190e0c0-0000-7000-8000-00000000dead" },
    });
    expect(bad.json().error.code).toBe("UNKNOWN_USER");
    // The owner account can't be disabled by anyone else at all (so LUME always has its owner).
    let ownerId = (await h.pool.query<{ id: string }>("SELECT id FROM users WHERE is_owner")).rows[0]?.id;
    if (!ownerId) {
      ownerId = target.id;
      await h.ownerPool.query("UPDATE users SET is_owner = true WHERE id = $1", [ownerId]);
    }
    const owner = await c.inject({ method: "POST", url: `/api/v1/users/${ownerId}/disable`, payload: {} });
    expect(owner.json().error.code).toBe("OWNER_PROTECTED");
  });
});
