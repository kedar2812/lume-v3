import { totpCode } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ noSettings: true }); // a pristine installation
});
afterAll(async () => h.close());

const body = (secret: string, code: string, token = h.setupToken) => ({
  token,
  business: { name: "Nupuur Coaching", timezone: "Asia/Dubai", currency: "AED", defaultCountry: "AE" },
  preset: "coaching",
  owner: { name: "Nupuur Patil", email: "nupuur@nupuur.com", password: "a long and lovely passphrase" },
  totp: { secret, code },
});

describe("first-run setup (report §15.3)", () => {
  it("reports that setup is needed", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/v1/setup/status" })).json()).toEqual({
      needsSetup: true,
    });
  });

  it("refuses a wrong token and a wrong two-step code", async () => {
    const c = await h.csrf();
    const t = await h.app.inject({
      method: "POST",
      url: "/api/v1/setup/totp",
      payload: { token: h.setupToken },
      ...c,
    });
    const { secret } = t.json();
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/v1/setup",
          payload: body(secret, totpCode(secret, h.clock.now.getTime()), "wrong"),
          ...c,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app.inject({ method: "POST", url: "/api/v1/setup", payload: body(secret, "000000"), ...c })
      ).json().error.code,
    ).toBe("INVALID_CODE");
  });

  it("creates settings, the owner with 2FA, default roles, recovery codes and a session, once", async () => {
    const c = await h.csrf();
    const { secret } = (
      await h.app.inject({
        method: "POST",
        url: "/api/v1/setup/totp",
        payload: { token: h.setupToken },
        ...c,
      })
    ).json();
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: body(secret, totpCode(secret, h.clock.now.getTime())),
      ...c,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().recoveryCodes).toHaveLength(10);
    expect(
      res.cookies.some(
        (x) => x.name === "__Host-lume_session" && x.httpOnly && x.secure && x.sameSite === "Lax",
      ),
    ).toBe(true);
    const { rows } = await h.pool.query("SELECT is_owner, totp_enabled, status FROM users");
    expect(rows).toEqual([{ is_owner: true, totp_enabled: true, status: "active" }]);
    expect((await h.pool.query("SELECT name FROM roles ORDER BY name")).rows.map((r) => r.name)).toEqual([
      "Admin",
      "Sales",
    ]);
    expect(
      (await h.pool.query("SELECT action FROM audit_log WHERE action = 'setup.completed'")).rowCount,
    ).toBe(1);
    // token is burned; a second setup is impossible
    expect((await h.app.inject({ method: "GET", url: "/api/v1/setup/status" })).json()).toEqual({
      needsSetup: false,
    });
    expect(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/v1/setup",
          payload: body(secret, totpCode(secret, h.clock.now.getTime())),
          ...c,
        })
      ).statusCode,
    ).toBe(403);
  });
});
