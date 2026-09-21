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

describe("roles admin (report §7.1)", () => {
  it("creates a role; scopes are only accepted on scoped permissions", async () => {
    const ok = await admin.inject({
      method: "POST",
      url: "/api/v1/roles",
      payload: {
        name: "Team lead",
        grants: [{ key: "leads.view", scope: "team" }, { key: "templates.use" }],
      },
    });
    expect(ok.statusCode).toBe(201);
    const bad = await admin.inject({
      method: "POST",
      url: "/api/v1/roles",
      payload: { name: "Odd", grants: [{ key: "templates.use", scope: "all" }] },
    });
    expect(bad.json().error.code).toBe("SCOPE_NOT_SUPPORTED");
    const unknown = await admin.inject({
      method: "POST",
      url: "/api/v1/roles",
      payload: { name: "Odd2", grants: [{ key: "leads.steal" }] },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("deleting a role that people hold requires a replacement, moved in the same transaction", async () => {
    const holder = await h.seedUser({ grants: [{ key: "templates.use", scope: null }] });
    const {
      rows: [held],
    } = await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [holder.id]);
    expect(
      (await admin.inject({ method: "DELETE", url: `/api/v1/roles/${held.role_id}`, payload: {} })).json()
        .error.code,
    ).toBe("REPLACEMENT_REQUIRED");
    const json = (
      await admin.inject({ method: "POST", url: "/api/v1/roles", payload: { name: "Fallback", grants: [] } })
    ).json();
    const replacement = json.role.id;
    expect(
      (
        await admin.inject({
          method: "DELETE",
          url: `/api/v1/roles/${held.role_id}`,
          payload: { replacementRoleId: replacement },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [holder.id])).rows,
    ).toEqual([{ role_id: replacement }]);
  });

  it("clones a role with all its grants", async () => {
    const json = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/roles",
        payload: { name: "Source", grants: [{ key: "leads.view", scope: "own" }] },
      })
    ).json();
    const clone = await admin.inject({
      method: "POST",
      url: `/api/v1/roles/${json.role.id}/clone`,
      payload: { name: "Source copy" },
    });
    expect(clone.json().role.grants).toEqual([{ key: "leads.view", scope: "own" }]);
  });

  it("a role manager cannot write access they lack into any role, including their own", async () => {
    const rm = await h.seedUser({
      grants: [
        { key: "roles.manage", scope: null },
        { key: "leads.view", scope: "own" },
      ],
      totp: true,
    });
    const c = await h.signIn(rm);
    const wider = await c.inject({
      method: "POST",
      url: "/api/v1/roles",
      payload: { name: "Wider", grants: [{ key: "leads.view", scope: "all" }] },
    });
    expect(wider.json().error.code).toBe("ESCALATION");
    const {
      rows: [own],
    } = await h.pool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [rm.id]);
    const grow = await c.inject({
      method: "PATCH",
      url: `/api/v1/roles/${own.role_id}`,
      payload: { grants: [{ key: "roles.manage" }, { key: "leads.export", scope: "own" }] },
    });
    expect(grow.json().error).toMatchObject({
      code: "ESCALATION",
      details: { permissions: ["leads.export"] },
    });
    const same = await c.inject({
      method: "POST",
      url: "/api/v1/roles",
      payload: { name: "Narrow", grants: [{ key: "leads.view", scope: "own" }] },
    });
    expect(same.statusCode).toBe(201);
  });
});
