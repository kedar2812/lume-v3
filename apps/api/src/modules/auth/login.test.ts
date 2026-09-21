import { totpCode } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

async function login(email: string, password: string) {
  const c = await h.csrf();
  const res = await h.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
    ...c,
  });
  const session = res.cookies.find((x) => x.name === "__Host-lume_session")?.value;
  return { res, c, session };
}

describe("POST /auth/login (report §12.1)", () => {
  it("signs in without 2FA and returns next: done", async () => {
    const u = await h.seedUser({ grants: [] });
    const { res, session } = await login(u.email, u.password);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ next: "done" });
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const u = await h.seedUser({ grants: [] });
    const a = await login(u.email, "not the password at all");
    const b = await login("nobody@nowhere.test", "not the password at all");
    expect(a.res.statusCode).toBe(401);
    expect(b.res.statusCode).toBe(401);
    expect(a.res.json()).toEqual(b.res.json());
    expect(a.res.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("requires the TOTP code when 2FA is on, and refuses replays", async () => {
    const u = await h.seedUser({ grants: [], totp: true });
    const { res, c, session } = await login(u.email, u.password);
    expect(res.json()).toEqual({ next: "otp" });
    const cookies = { ...c.cookies, "__Host-lume_session": session! };
    // a pending (mfa) session can't reach normal routes
    expect((await h.app.inject({ method: "GET", url: "/api/v1/auth/me", cookies })).statusCode).toBe(401);
    const code = totpCode(u.totpSecret!, h.clock.now.getTime());
    const ok = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa",
      payload: { code },
      headers: c.headers,
      cookies,
    });
    expect(ok.statusCode).toBe(200);
    const full = ok.cookies.find((x) => x.name === "__Host-lume_session")!.value;
    expect(full).not.toBe(session); // rotated on privilege change
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          cookies: { ...c.cookies, "__Host-lume_session": full },
        })
      ).statusCode,
    ).toBe(200);
    // same code again (new login) is rejected: replay
    const again = await login(u.email, u.password);
    const replay = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/2fa",
      payload: { code },
      headers: again.c.headers,
      cookies: { ...again.c.cookies, "__Host-lume_session": again.session! },
    });
    expect(replay.json().error.code).toBe("INVALID_CODE");
  });

  it("locks the account after 10 failures and says so with Retry-After", async () => {
    const u = await h.seedUser({ grants: [] });
    let last;
    for (let i = 0; i < 12; i++) {
      last = (await login(u.email, `wrong-${i}-xxxxxxxx`)).res;
      h.clock.advance(31_000); // step past the progressive delay
    }
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers["retry-after"])).toBeGreaterThan(0);
    expect((await login(u.email, u.password)).res.statusCode).toBe(429); // even the right password waits
    expect(
      (await h.pool.query("SELECT count(*)::int n FROM audit_log WHERE action = 'user.login.locked'")).rows[0]
        .n,
    ).toBe(1);
  });

  it("logout revokes the session", async () => {
    const u = await h.seedUser({ grants: [] });
    const { c, session } = await login(u.email, u.password);
    const cookies = { ...c.cookies, "__Host-lume_session": session! };
    expect(
      (await h.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: c.headers, cookies }))
        .statusCode,
    ).toBe(204);
    expect((await h.app.inject({ method: "GET", url: "/api/v1/auth/me", cookies })).statusCode).toBe(401);
  });

  it("/auth/me reports permissions and whether 2FA is required", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "team" }] }));
    const me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.permissions).toEqual([{ key: "leads.view", scope: "team" }]);
    expect(me.twoFactor).toEqual({ enabled: false, required: false });
  });
});
