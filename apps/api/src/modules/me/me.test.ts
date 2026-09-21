import { totpCode } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("/me", () => {
  it("lists my sessions without exposing their ids and lets me revoke another one", async () => {
    const u = await h.seedUser({ grants: [] });
    const a = await h.signIn(u);
    const b = await h.signIn(u);
    const list = (await a.inject({ method: "GET", url: "/api/v1/me/sessions" })).json().sessions;
    expect(list).toHaveLength(2);
    expect(list.every((s: { id: string }) => /^[0-9a-f]{16}$/.test(s.id))).toBe(true);
    const other = list.find((s: { current: boolean }) => !s.current);
    expect((await a.inject({ method: "DELETE", url: `/api/v1/me/sessions/${other.id}` })).statusCode).toBe(
      204,
    );
    expect((await b.inject({ method: "GET", url: "/api/v1/me/sessions" })).statusCode).toBe(401);
  });

  it("a user whose role requires 2FA can enrol (and only enrol) until done", async () => {
    const u = await h.seedUser({ grants: [{ key: "users.manage", scope: null }] });
    const c = await h.signIn(u);
    expect((await c.inject({ method: "GET", url: "/api/v1/me/sessions" })).statusCode).toBe(403);
    const { secret, otpauthUri } = (await c.inject({ method: "POST", url: "/api/v1/me/2fa/enrol" })).json();
    expect(otpauthUri).toContain(encodeURIComponent(u.email));
    const bad = await c.inject({
      method: "POST",
      url: "/api/v1/me/2fa/confirm",
      payload: { code: "000000" },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await c.inject({
      method: "POST",
      url: "/api/v1/me/2fa/confirm",
      payload: { code: totpCode(secret, h.clock.now.getTime()) },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recoveryCodes).toHaveLength(10);
    const rotated = ok.cookies.find((x) => x.name === "__Host-lume_session")!.value;
    const again = await c.inject({
      method: "GET",
      url: "/api/v1/me/sessions",
      cookies: { "__Host-lume_session": rotated },
    });
    expect(again.statusCode).toBe(200);
  });

  it("refuses to switch off 2FA when a role requires it", async () => {
    const u = await h.seedUser({ grants: [{ key: "roles.manage", scope: null }], totp: true });
    const c = await h.signIn(u);
    const r = await c.inject({
      method: "POST",
      url: "/api/v1/me/2fa/disable",
      payload: { password: u.password },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("TWO_FACTOR_REQUIRED");
  });

  it("a wrong password is a 400 that keeps me signed in, and is throttled", async () => {
    const u = await h.seedUser({ grants: [], totp: true });
    const c = await h.signIn(u);
    const bad = await c.inject({
      method: "POST",
      url: "/api/v1/me/recovery-codes",
      payload: { password: "nope" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("WRONG_PASSWORD");
    expect((await c.inject({ method: "GET", url: "/api/v1/me/sessions" })).statusCode).toBe(200);
    for (let i = 0; i < 12; i++) {
      await c.inject({ method: "POST", url: "/api/v1/me/recovery-codes", payload: { password: "nope" } });
    }
    const locked = await c.inject({
      method: "POST",
      url: "/api/v1/me/recovery-codes",
      payload: { password: u.password },
    });
    expect(locked.statusCode).toBe(429);
  });

  it("switches off optional 2FA with the right password", async () => {
    const u = await h.seedUser({ grants: [], totp: true });
    const c = await h.signIn(u);
    const r = await c.inject({
      method: "POST",
      url: "/api/v1/me/2fa/disable",
      payload: { password: u.password },
    });
    expect(r.statusCode).toBe(204);
    const { rows } = await h.pool.query("SELECT totp_enabled FROM users WHERE id = $1", [u.id]);
    expect(rows[0].totp_enabled).toBe(false);
  });

  it("updates my name, timezone and theme, validating each", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    const ok = await c.inject({
      method: "PATCH",
      url: "/api/v1/me",
      payload: { name: "Riya", timezone: "Asia/Kolkata", theme: "obsidian" },
    });
    expect(ok.json()).toMatchObject({ name: "Riya", timezone: "Asia/Kolkata", theme: "obsidian" });
    expect(
      (await c.inject({ method: "PATCH", url: "/api/v1/me", payload: { timezone: "Mars/Olympus" } }))
        .statusCode,
    ).toBe(400);
  });
});
