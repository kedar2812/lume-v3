import { PREFERENCES_DEFAULTS, TOUR_VERSION, totpCode } from "@lume/core";
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

describe("preferences, onboarding and tour state (spec §4.2)", () => {
  it("starts with defaults, merges a patch, and keeps the rest", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    const me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.preferences).toEqual(PREFERENCES_DEFAULTS);
    expect(me.flags).toEqual({ needsOnboarding: true, needsTwoFactorEnrolment: false, needsTour: false });
    const r = await c.inject({
      method: "PATCH",
      url: "/api/v1/me",
      payload: { timezone: "Asia/Kolkata", preferences: { digestTime: "07:15", sounds: { volume: 10 } } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().preferences).toMatchObject({
      digestTime: "07:15",
      sounds: { enabled: true, volume: 10 },
    });
    const again = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(again.preferences.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(again.preferences.digestTime).toBe("07:15");
    expect(again.user.timezone).toBe("Asia/Kolkata");
  });

  it("refuses nonsense preferences", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    const r = await c.inject({
      method: "PATCH",
      url: "/api/v1/me",
      payload: { preferences: { workStart: "9am" } },
    });
    expect(r.statusCode).toBe(400);
  });

  it("remembers where onboarding got to, what was skipped, and when it finished", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    let r = await c.inject({
      method: "PUT",
      url: "/api/v1/me/onboarding",
      payload: { step: "day", skip: "look" },
    });
    expect(r.json().onboarding).toMatchObject({ step: "day", skipped: ["look"], completedAt: null });
    r = await c.inject({ method: "PUT", url: "/api/v1/me/onboarding", payload: { skip: "look" } });
    expect(r.json().onboarding.skipped).toEqual(["look"]); // recorded once
    r = await c.inject({ method: "PUT", url: "/api/v1/me/onboarding", payload: { completed: true } });
    expect(r.json().onboarding.completedAt).not.toBeNull();
    const me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.flags.needsOnboarding).toBe(false);
    expect(me.flags.needsTour).toBe(true); // now the tour is what is outstanding
    expect(
      (await h.pool.query("SELECT count(*)::int n FROM audit_log WHERE action = 'user.onboarding.completed'"))
        .rows[0].n,
    ).toBe(1);
  });

  it("tracks tour progress and stops asking once finished", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    await c.inject({ method: "PUT", url: "/api/v1/me/onboarding", payload: { completed: true } });
    await c.inject({ method: "PUT", url: "/api/v1/me/tour", payload: { step: 4 } });
    let me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.tour).toMatchObject({ version: TOUR_VERSION, step: 4, completedAt: null });
    expect(me.flags.needsTour).toBe(true);
    await c.inject({ method: "PUT", url: "/api/v1/me/tour", payload: { completed: true } });
    me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.flags.needsTour).toBe(false);
    expect(me.tour.completedAt).not.toBeNull();
  });

  it("tells the app which integrations exist", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    expect((await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json().capabilities).toEqual({
      sheets: false,
      calendar: false,
    });
  });

  it("flags an admin who still has to enrol in two-step sign-in, and lets them record onboarding steps", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "users.manage", scope: null }] }));
    const me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.flags).toMatchObject({ needsTwoFactorEnrolment: true, needsOnboarding: true });
    const r = await c.inject({ method: "PUT", url: "/api/v1/me/onboarding", payload: { step: "secure" } });
    expect(r.statusCode).toBe(200);
  });

  // Onboarding asks for the name first and two-step sign-in second, so the steps before enrolment must
  // be able to save — but nothing that touches anyone else's data may open up.
  it("lets an admin who still has to enrol save their own profile and read the business name, and nothing more", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [{ key: "users.manage", scope: null }] }));
    const saved = await c.inject({
      method: "PATCH",
      url: "/api/v1/me",
      payload: { name: "Tasneem S", timezone: "Asia/Dubai", preferences: { workStart: "10:00" } },
    });
    expect(saved.statusCode).toBe(200);
    const settings = await c.inject({ method: "GET", url: "/api/v1/settings" });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toHaveProperty("businessName");
    for (const url of ["/api/v1/users", "/api/v1/leads", "/api/v1/roles/assignable", "/api/v1/me/sessions"])
      expect((await c.inject({ method: "GET", url })).statusCode, url).toBe(403);
  });
});
