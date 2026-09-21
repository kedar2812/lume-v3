import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const tokenFrom = (url: string) => url.split("/").pop()!;

describe("invites (report §12.1: invite-only, single-use, 72 h)", () => {
  it("an admin invites, the invitee accepts once, and lands signed in with the right roles", async () => {
    const admin = await h.signIn(
      await h.seedUser({ grants: [{ key: "users.manage", scope: null }], totp: true }),
    );
    const {
      rows: [role],
    } = await h.pool.query("INSERT INTO roles (id, name) VALUES (gen_random_uuid(), 'Sales') RETURNING id");
    const res = await admin.inject({
      method: "POST",
      url: "/api/v1/invites",
      payload: { email: "riya@nupuur.com", name: "Riya", roleIds: [role.id] },
    });
    expect(res.statusCode).toBe(201);
    expect(h.mail.at(-1)).toMatchObject({ to: "riya@nupuur.com", kind: "invite" });
    const token = tokenFrom(res.json().url);

    expect((await h.app.inject({ method: "GET", url: `/api/v1/invites/${token}` })).json()).toMatchObject({
      email: "riya@nupuur.com",
      name: "Riya",
    });
    const c = await h.csrf();
    const weak = await h.app.inject({
      method: "POST",
      url: `/api/v1/invites/${token}/accept`,
      payload: { password: "short" },
      ...c,
    });
    expect(weak.json().error.code).toBe("WEAK_PASSWORD");
    const ok = await h.app.inject({
      method: "POST",
      url: `/api/v1/invites/${token}/accept`,
      payload: { password: "a long and lovely passphrase" },
      ...c,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.cookies.some((x) => x.name === "__Host-lume_session")).toBe(true);
    const { rows } = await h.pool.query(
      "SELECT u.status, ur.role_id FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.email = 'riya@nupuur.com'",
    );
    expect(rows).toEqual([{ status: "active", role_id: role.id }]);
    // single use
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: `/api/v1/invites/${token}/accept`,
          payload: { password: "a long and lovely passphrase" },
          ...c,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("expired invites are gone", async () => {
    const admin = await h.signIn(
      await h.seedUser({ grants: [{ key: "users.manage", scope: null }], totp: true }),
    );
    const res = await admin.inject({
      method: "POST",
      url: "/api/v1/invites",
      payload: { email: "late@nupuur.com", name: "Late", roleIds: [] },
    });
    h.clock.advance(72 * 3600_000 + 1);
    expect(
      (await h.app.inject({ method: "GET", url: `/api/v1/invites/${tokenFrom(res.json().url)}` })).statusCode,
    ).toBe(404);
  });

  it("cannot invite someone who already has an account", async () => {
    const existing = await h.seedUser({ grants: [] });
    const admin = await h.signIn(
      await h.seedUser({ grants: [{ key: "users.manage", scope: null }], totp: true }),
    );
    const res = await admin.inject({
      method: "POST",
      url: "/api/v1/invites",
      payload: { email: existing.email, name: "Dup", roleIds: [] },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("password reset (report §12.1: emailed single-use token, 30 min)", () => {
  it("never reveals whether an email exists, and resets + signs out everywhere", async () => {
    const u = await h.seedUser({ grants: [] });
    const session = await h.signIn(u);
    const c = await h.csrf();
    const before = h.mail.length;
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/v1/auth/password/forgot",
          payload: { email: "ghost@nowhere.test" },
          ...c,
        })
      ).statusCode,
    ).toBe(202);
    expect(h.mail.length).toBe(before);
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/v1/auth/password/forgot",
          payload: { email: u.email },
          ...c,
        })
      ).statusCode,
    ).toBe(202);
    const token = tokenFrom(/https:\/\/lume\.test\/reset\/\S+/.exec(h.mail.at(-1)!.text)![0]);
    const ok = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token, password: "an entirely new passphrase" },
      ...c,
    });
    expect(ok.statusCode).toBe(204);
    expect((await session.inject({ method: "GET", url: "/api/v1/auth/me" })).statusCode).toBe(401);
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/v1/auth/password/reset",
          payload: { token, password: "yet another passphrase!!" },
          ...c,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("sends at most three reset emails per account per 15 minutes", async () => {
    const u = await h.seedUser({ grants: [] });
    const c = await h.csrf();
    const before = h.mail.length;
    for (let i = 0; i < 5; i++) {
      const r = await h.app.inject({
        method: "POST",
        url: "/api/v1/auth/password/forgot",
        payload: { email: u.email },
        ...c,
      });
      expect(r.statusCode).toBe(202);
    }
    expect(h.mail.length - before).toBe(3);
  });
});
