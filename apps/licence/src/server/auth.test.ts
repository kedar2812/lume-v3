import { totpCode } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Limiter } from "@/lib/limit";
import { createAdmin } from "./auth";
import type { Ctx } from "./context";
import { Jar, licenceDb, testCtx, type LicenceTestDb } from "./testing";

let t: LicenceTestDb;
let now: Date;
let ctx: Ctx;
let secret: string;
const EMAIL = "owner@lume.test";
const PASSWORD = "a long and lovely passphrase";

const jar = (ip?: string) => new Jar(() => ctx, ip);
const code = (at = now) => totpCode(secret, at.getTime());
async function signIn(j: Jar, o: { email?: string; password?: string; code?: string } = {}) {
  const a = await j.call("POST", "/api/auth/password", {
    email: o.email ?? EMAIL,
    password: o.password ?? PASSWORD,
  });
  expect(a.status).toBe(200);
  expect(a.data).toEqual({ next: "code" });
  return j.call("POST", "/api/auth/code", { code: o.code ?? code() });
}
const outcomes = async () =>
  (await t.pool.query<{ outcome: string }>("SELECT outcome FROM sign_ins ORDER BY id")).rows.map(
    (r) => r.outcome,
  );

beforeAll(async () => {
  t = await licenceDb();
  now = new Date("2026-10-05T09:00:00Z");
  ctx = testCtx(t.pool, () => now);
  ({ secret } = await createAdmin(ctx, { email: EMAIL, password: PASSWORD }));
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  // Each test signs in with a fresh code: a step past the last one used.
  now = new Date(now.getTime() + 5 * 60_000);
  ctx.limits.signIn = new Limiter(10, 15 * 60_000);
  await t.pool.query("DELETE FROM sign_ins");
});

describe("the admin's sign-in (spec §4.4, Review Focus 4)", () => {
  it("password, then six digits, then a session: httpOnly, Secure, SameSite=Strict, with its CSRF cookie", async () => {
    const j = jar();
    const r = await signIn(j);
    expect(r.status).toBe(200);
    const cookies = r.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("lume_licence="));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/SameSite=Strict/i);
    expect(session).toMatch(/Path=\//);
    const csrf = cookies.find((c) => c.startsWith("lume_licence_csrf="));
    expect(csrf).toMatch(/SameSite=Strict/i);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect((await j.call("GET", "/api/me")).data).toEqual({ email: EMAIL });
    expect(await outcomes()).toEqual(["ok"]);
  });

  it("the password step never says whether it was right; the code step doesn't say which was wrong", async () => {
    const wrongPassword = await signIn(jar(), { password: "not the passphrase at all" });
    now = new Date(now.getTime() + 60_000);
    const wrongCode = await signIn(jar(), { code: code(new Date(now.getTime() - 10 * 60_000)) });
    now = new Date(now.getTime() + 60_000);
    const unknown = await signIn(jar(), { email: "someone@else.test" });
    for (const r of [wrongPassword, wrongCode, unknown]) {
      expect(r.status).toBe(401);
      expect(r.data).toEqual(wrongPassword.data);
    }
    expect(wrongPassword.data).toEqual({
      error: {
        code: "SIGN_IN_FAILED",
        message: "That didn't work. Check the email, password and code, then try again.",
      },
    });
    expect(await outcomes()).toEqual(["bad_password", "bad_code", "unknown_email"]);
  });

  it("a code used once is refused the second time, even inside its window", async () => {
    const c = code();
    expect((await signIn(jar(), { code: c })).status).toBe(200);
    expect((await signIn(jar(), { code: c })).status).toBe(401);
  });

  it("the code step needs a password step first, and it lasts five minutes", async () => {
    const j = jar();
    expect((await j.call("POST", "/api/auth/code", { code: code() })).status).toBe(401);
    await j.call("POST", "/api/auth/password", { email: EMAIL, password: PASSWORD });
    now = new Date(now.getTime() + 5 * 60_000 + 1000);
    expect((await j.call("POST", "/api/auth/code", { code: code() })).status).toBe(401);
    expect(await outcomes()).toContain("expired");
  });

  it("signing in is rate-limited per address, and the refusal is logged", async () => {
    ctx.limits.signIn = new Limiter(2, 15 * 60_000);
    const j = jar("198.51.100.20");
    await j.call("POST", "/api/auth/password", { email: EMAIL, password: "x".repeat(12) });
    await j.call("POST", "/api/auth/password", { email: EMAIL, password: "x".repeat(12) });
    const r = await j.call("POST", "/api/auth/password", { email: EMAIL, password: PASSWORD });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await outcomes()).toContain("limited");
    expect((await signIn(jar("198.51.100.21"))).status).toBe(200);
  });
});

describe("sessions and CSRF", () => {
  it("without a session, the API says 401", async () => {
    expect((await jar().call("GET", "/api/clients")).status).toBe(401);
    expect((await jar().call("GET", "/api/me")).status).toBe(401);
  });

  it("every write needs the session's CSRF token: a stolen cookie without it can't write", async () => {
    const j = jar();
    await signIn(j);
    const settings = { listPriceInr: 3999 };
    expect((await j.call("PATCH", "/api/settings", settings, { csrf: false })).status).toBe(403);
    expect((await j.call("PATCH", "/api/settings", settings, { csrf: "not-the-token" })).status).toBe(403);
    // Another session's token doesn't fit this one.
    const other = jar();
    await signIn(other, { code: code(new Date(now.getTime() + 30_000)) });
    expect((await j.call("PATCH", "/api/settings", settings, { csrf: other.csrf })).status).toBe(403);
    expect((await j.call("PATCH", "/api/settings", settings)).status).toBe(200);
  });

  it("a write from another site is refused, whatever it carries", async () => {
    const j = jar();
    await signIn(j);
    const r = await j.call("PATCH", "/api/settings", { listPriceInr: 1 }, { origin: "https://evil.test" });
    expect(r.status).toBe(403);
  });

  it("signing out ends the session", async () => {
    const j = jar();
    await signIn(j);
    const kept = j.snapshot();
    expect((await j.call("POST", "/api/auth/sign-out")).status).toBe(204);
    expect(await outcomes()).toContain("signed_out");
    j.restore(kept);
    expect((await j.call("GET", "/api/me")).status).toBe(401);
  });

  it("a session ends after 4 hours idle, and after 24 hours whatever", async () => {
    const j = jar();
    await signIn(j);
    now = new Date(now.getTime() + 3 * 3_600_000);
    expect((await j.call("GET", "/api/me")).status).toBe(200);
    now = new Date(now.getTime() + 4 * 3_600_000 + 1000);
    expect((await j.call("GET", "/api/me")).status).toBe(401);

    const k = jar();
    await signIn(k);
    for (let h = 0; h < 7; h++) {
      now = new Date(now.getTime() + 3 * 3_600_000);
      expect((await k.call("GET", "/api/me")).status).toBe(200);
    }
    now = new Date(now.getTime() + 3 * 3_600_000);
    expect((await k.call("GET", "/api/me")).status).toBe(401);
  });
});
