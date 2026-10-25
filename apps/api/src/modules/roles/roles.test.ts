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

  it("sign-in hours and networks are Security's to set, with its checks: never through a role (review 2026-10-25)", async () => {
    // Through here they skipped Security's checks: a time like 99:99, hours that end before they start, and the
    // check that stops someone locking themselves out.
    const made = await admin.inject({
      method: "POST",
      url: "/api/v1/roles",
      payload: { name: "Night shift", grants: [{ key: "templates.use" }], ipAllowlist: ["10.0.0.0/8"] },
    });
    expect(made.statusCode).toBe(400);
    expect(made.json().error).toEqual({
      code: "ACCESS_IN_SECURITY",
      message: "Sign-in hours and networks are set in Settings → Security.",
    });
    const ok = await admin.inject({
      method: "POST",
      url: "/api/v1/roles",
      payload: { name: "Night shift", grants: [{ key: "templates.use" }] },
    });
    const id = ok.json().role.id;
    const hours = await admin.inject({
      method: "PATCH",
      url: `/api/v1/roles/${id}`,
      payload: { loginHours: { days: [1], from: "18:00", to: "09:00" } },
    });
    expect(hours.statusCode).toBe(400);
    expect(hours.json().error.code).toBe("ACCESS_IN_SECURITY");
    const { rows } = await h.pool.query("SELECT login_hours, ip_allowlist FROM roles WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ login_hours: null, ip_allowlist: null });
  });

  it("a role still used by an open invite, a template's allow-list or a shared view: deleting it asks for a replacement, and everything moves to it (review 2026-10-25)", async () => {
    // Left behind, an invite signed its person in with no access, Resend failed, and a template limited to the role
    // was usable by nobody (an empty list would have meant everybody, so it isn't simply dropped).
    const make = async (name: string) =>
      (await admin.inject({ method: "POST", url: "/api/v1/roles", payload: { name, grants: [] } })).json()
        .role.id as string;
    const old = await make("Old desk");
    const next = await make("New desk");
    const ownerId = (await h.pool.query<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1"))
      .rows[0]!.id;
    const invite = (
      await h.pool.query<{ id: string }>(
        `INSERT INTO user_invites (id, email, name, role_ids, token_hash, expires_at, invited_by, created_at)
         VALUES (gen_random_uuid(), 'desk@brightpath.test', 'Desk', ARRAY[$1]::uuid[], md5(random()::text) || md5(random()::text),
                 now() + interval '3 days', $2, now()) RETURNING id`,
        [old, ownerId],
      )
    ).rows[0]!.id;
    const template = (
      await h.pool.query<{ id: string }>(
        `INSERT INTO message_templates (id, name, category, allowed_role_ids)
         VALUES (gen_random_uuid(), 'Desk hello', 'custom', ARRAY[$1]::uuid[]) RETURNING id`,
        [old],
      )
    ).rows[0]!.id;
    // Saved views keep their own row-level security: written and read as their owner, who manages views.
    const asOwner = async <R extends Record<string, unknown>>(q: string, params: unknown[]) => {
      const c = await h.ownerPool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "SELECT set_config('lume.user_id', $1, true), set_config('lume.manage_views', 'on', true)",
          [ownerId],
        );
        const rows = (await c.query<R>(q, params)).rows;
        await c.query("COMMIT");
        return rows;
      } finally {
        c.release();
      }
    };
    const view = (
      await asOwner<{ id: string }>(
        `INSERT INTO saved_views (id, name, owner_id, shared_role_ids)
         VALUES (gen_random_uuid(), 'Desk view', $2, ARRAY[$1]::uuid[]) RETURNING id`,
        [old, ownerId],
      )
    )[0]!.id;
    // Someone who manages roles, not views: the shared view, not theirs to see, still counts and still moves.
    const roleAdmin = await h.signIn(
      await h.seedUser({ grants: [{ key: "roles.manage", scope: null }], totp: true }),
    );
    const read = (await roleAdmin.inject({ method: "GET", url: `/api/v1/roles/${old}` })).json().role;
    expect(read).toMatchObject({ holders: 0, uses: { invites: 1, templates: 1, views: 1 } });

    const bare = await roleAdmin.inject({ method: "DELETE", url: `/api/v1/roles/${old}`, payload: {} });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe("REPLACEMENT_REQUIRED");

    const moved = await roleAdmin.inject({
      method: "DELETE",
      url: `/api/v1/roles/${old}`,
      payload: { replacementRoleId: next },
    });
    expect(moved.statusCode, moved.body).toBe(204);
    const one = async (q: string, id: string) => (await h.queryAll<{ ids: string[] }>(q, [id]))[0]!.ids;
    expect(await one("SELECT role_ids::text[] AS ids FROM user_invites WHERE id = $1", invite)).toEqual([
      next,
    ]);
    expect(
      await one("SELECT allowed_role_ids::text[] AS ids FROM message_templates WHERE id = $1", template),
    ).toEqual([next]);
    expect(
      (
        await asOwner<{ ids: string[] }>(
          "SELECT shared_role_ids::text[] AS ids FROM saved_views WHERE id = $1",
          [view],
        )
      )[0]!.ids,
    ).toEqual([next]);
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
