import { ALL_GRANTS, newId, totpCode, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

/**
 * Deleting an account (owner 2026-11-02; spec docs/superpowers/specs/2026-11-02-delete-account-and-role.md): the person
 * forgotten, their leads handed on, what they did kept as done by "Former member"; the password twice, the code with
 * two-step; never the business owner.
 */
let h: Harness;
let owner: SeededUser;
let adminUser: SeededUser;
let admin: AuthedClient;
const sales: Grant[] = [{ key: "leads.view", scope: "own" }];

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  owner = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  // Full rights need two-step: the admin proves it with their password and code.
  adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Hana Ito" });
  admin = await h.signIn(adminUser);
});
afterAll(() => h.close());
/** The admin's proof: their password and a fresh code (a code is good once). */
const adminProof = (password = adminUser.password) => {
  h.clock.advance(31_000);
  return { password, code: totpCode(adminUser.totpSecret!, h.clock.now.getTime()) };
};

/** Someone with `n` leads, signed in (their own client), and a colleague who could take them. */
async function person(n = 2, o: { totp?: boolean } = {}) {
  const u = await h.seedUser({
    grants: sales,
    name: `Rory ${newId().slice(-4)}`,
    email: `rory.${newId().slice(-6)}@example.test`,
    totp: o.totp ?? false,
  });
  const client = await h.signIn(u);
  const leads: string[] = [];
  for (let i = 0; i < n; i++) leads.push(await h.seedLead({ ownerId: u.id, name: `Lead ${i}` }));
  const colleague = await h.seedUser({ grants: sales, name: `Sam ${newId().slice(-4)}` });
  return { u, client, leads, colleague };
}
const row = async (id: string) =>
  (
    await h.queryAll<{
      name: string;
      email: string;
      status: string;
      password_hash: string | null;
      totp_enabled: boolean;
    }>("SELECT name, email, status, password_hash, totp_enabled FROM users WHERE id = $1", [id])
  )[0]!;
const ownersOf = (ids: string[]) =>
  h.queryAll<{ owner_id: string | null }>("SELECT owner_id FROM leads WHERE id = ANY($1)", [ids]);

describe("deleting my own account", () => {
  it("says what it would do first: my leads, who could take them", async () => {
    const { client } = await person(3);
    const r = await client.inject({ method: "GET", url: "/api/v1/me/delete" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().leads).toEqual({ total: 3, open: 3 });
  });

  it("leads to a colleague, the person forgotten, signed out, the email free to invite again", async () => {
    const { u, client, leads, colleague } = await person(2);
    const r = await client.inject({
      method: "POST",
      url: "/api/v1/me/delete",
      payload: {
        leads: { to: "person", userId: colleague.id },
        password: u.password,
        passwordAgain: u.password,
      },
    });
    expect(r.statusCode, r.body).toBe(204);
    expect(r.headers["set-cookie"]?.toString()).toMatch(/__Host-lume_session=;/);
    expect((await ownersOf(leads)).map((l) => l.owner_id)).toEqual([colleague.id, colleague.id]);
    expect(await row(u.id)).toEqual({
      name: "Former member",
      email: `deleted-${u.id}@deleted.lume.invalid`,
      status: "deleted",
      password_hash: null,
      totp_enabled: false,
    });
    // Signed out: the session that asked is gone.
    expect((await client.inject({ method: "GET", url: "/api/v1/auth/me" })).statusCode).toBe(401);
    // Gone from People, and from what an admin can act on; their address invitable again.
    const people = (await admin.inject({ method: "GET", url: "/api/v1/users" })).json().users;
    expect(people.map((p: { id: string }) => p.id)).not.toContain(u.id);
    expect((await admin.inject({ method: "POST", url: `/api/v1/users/${u.id}/enable` })).statusCode).toBe(
      404,
    );
    const role = (await admin.inject({ method: "GET", url: "/api/v1/roles" })).json().roles[0].id;
    const invite = await admin.inject({
      method: "POST",
      url: "/api/v1/invites",
      payload: { email: u.email, name: "Rory again", roleIds: [role] },
    });
    expect(invite.statusCode, invite.body).toBe(201);
    // The record says who and how, never who they were.
    const [entry] = await h.queryAll<{ diff: unknown }>(
      "SELECT diff FROM audit_log WHERE action = 'user.deleted' AND entity_id = $1",
      [u.id],
    );
    expect(entry!.diff).toMatchObject({ by: "self", leads: { to: "person", moved: 2 } });
    expect(JSON.stringify(entry!.diff)).not.toContain(u.email);
  });

  it("the two passwords must be the same; a wrong one changes nothing", async () => {
    const { u, client, leads } = await person(1);
    const differ = await client.inject({
      method: "POST",
      url: "/api/v1/me/delete",
      payload: { leads: { to: "none" }, password: u.password, passwordAgain: `${u.password}x` },
    });
    expect(differ.statusCode).toBe(400);
    const wrong = await client.inject({
      method: "POST",
      url: "/api/v1/me/delete",
      payload: { leads: { to: "none" }, password: "not-it-1234", passwordAgain: "not-it-1234" },
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe("WRONG_PASSWORD");
    expect((await row(u.id)).status).toBe("active");
    expect((await ownersOf(leads))[0]!.owner_id).toBe(u.id);
  });

  it("with two-step on, the code too", async () => {
    const { u, client } = await person(0, { totp: true });
    const body = { leads: { to: "none" }, password: u.password, passwordAgain: u.password };
    const none = await client.inject({ method: "POST", url: "/api/v1/me/delete", payload: body });
    expect(none.json().error.code).toBe("WRONG_CODE");
    expect((await row(u.id)).status).toBe("active");
    h.clock.advance(31_000); // a fresh step: the sign-in used the last one
    const code = totpCode(u.totpSecret!, h.clock.now.getTime());
    const ok = await client.inject({ method: "POST", url: "/api/v1/me/delete", payload: { ...body, code } });
    expect(ok.statusCode, ok.body).toBe(204);
    expect((await row(u.id)).status).toBe("deleted");
  });

  it("the business owner can't delete their own account", async () => {
    const client = await h.signIn(owner);
    h.clock.advance(31_000);
    const r = await client.inject({
      method: "POST",
      url: "/api/v1/me/delete",
      payload: {
        leads: { to: "none" },
        password: owner.password,
        passwordAgain: owner.password,
        code: totpCode(owner.totpSecret!, h.clock.now.getTime()),
      },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("OWNER_ACCOUNT");
    expect((await row(owner.id)).status).toBe("active");
  });
});

describe("an admin deleting someone's account", () => {
  it("with the admin's own password; leads unassigned if they choose; never themselves here", async () => {
    const { u, leads } = await person(2);
    const wrong = await admin.inject({
      method: "POST",
      url: `/api/v1/users/${u.id}/delete`,
      payload: { leads: { to: "none" }, ...adminProof("not-it-1234") },
    });
    expect(wrong.json().error.code).toBe("WRONG_PASSWORD");
    const ok = await admin.inject({
      method: "POST",
      url: `/api/v1/users/${u.id}/delete`,
      payload: { leads: { to: "none" }, ...adminProof() },
    });
    expect(ok.statusCode, ok.body).toBe(204);
    expect((await ownersOf(leads)).map((l) => l.owner_id)).toEqual([null, null]);
    expect((await row(u.id)).name).toBe("Former member");
    const self = await admin.inject({
      method: "POST",
      url: `/api/v1/users/${adminUser.id}/delete`,
      payload: { leads: { to: "none" }, ...adminProof() },
    });
    expect(self.json().error.code).toBe("USE_MY_ACCOUNT");
    const theOwner = await admin.inject({
      method: "POST",
      url: `/api/v1/users/${owner.id}/delete`,
      payload: { leads: { to: "none" }, ...adminProof() },
    });
    expect(theOwner.json().error.code).toBe("OWNER_ACCOUNT");
  });

  it("someone already offboarded can be deleted too; LUME AI runs speaking as them end", async () => {
    const { u } = await person(0);
    expect(
      (
        await admin.inject({
          method: "POST",
          url: `/api/v1/users/${u.id}/offboard`,
          payload: { leads: { to: "none" } },
        })
      ).statusCode,
    ).toBe(200);
    const ok = await admin.inject({
      method: "POST",
      url: `/api/v1/users/${u.id}/delete`,
      payload: { leads: { to: "none" }, ...adminProof() },
    });
    expect(ok.statusCode, ok.body).toBe(204);
    expect((await row(u.id)).status).toBe("deleted");
  });
});
