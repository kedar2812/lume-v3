import { totpCode } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdmin } from "./auth";
import type { Ctx } from "./context";
import { adminSession, Jar, licenceDb, testCtx, type LicenceTestDb } from "./testing";

let t: LicenceTestDb;
let now: Date;
let ctx: Ctx;
let admin: Jar;
let secret: string;
const EMAIL = "owner@lume.test";
let password = "a long and lovely passphrase";

async function signIn(j: Jar, at = now) {
  await j.call("POST", "/api/auth/password", { email: EMAIL, password });
  return j.call("POST", "/api/auth/code", { code: totpCode(secret, at.getTime()) });
}
async function create(name: string, plan: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const r = await admin.call("POST", "/api/clients", {
    name,
    country: "IN",
    region: "MH",
    city: "Pune",
    source: "referrals",
    plan,
    ...over,
  });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.client.id as string;
}
const monthly = (amount: number) => ({ type: "subscription", currency: "INR", amount, periodMonths: 1 });

beforeAll(async () => {
  t = await licenceDb();
  now = new Date("2026-09-29T09:00:00Z");
  ctx = testCtx(t.pool, () => now);
  ({ secret } = await createAdmin(ctx, { email: EMAIL, password }));
  admin = await adminSession(ctx);
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  now = new Date(now.getTime() + 60_000);
});

describe("the bell (spec §4.4, Review Focus 5)", () => {
  it("lists what needs a look; one hides until its condition changes; all hide at once; then All clear", async () => {
    const late = await create("Harbour Clinic", monthly(2999));
    await t.pool.query("UPDATE licences SET paid_until = '2026-09-26' WHERE client_id = $1", [late]);
    const trial = await create("Cedar & Co Salon", {
      type: "trial",
      currency: "INR",
      amount: 3999,
      periodMonths: 1,
    });
    let r = await admin.call("GET", "/api/alerts");
    expect(r.data.alerts.map((a: { id: string }) => a.id)).toEqual([`late:${late}`, `trial:${trial}`]);

    expect((await admin.call("POST", "/api/alerts/dismiss", { id: `late:${late}` })).status).toBe(200);
    r = await admin.call("GET", "/api/alerts");
    expect(r.data.alerts.map((a: { id: string }) => a.id)).toEqual([`trial:${trial}`]);

    // Paid, then late again a month on: it's a new late payment, so it's back.
    await admin.call("POST", `/api/clients/${late}/paid`, {});
    now = new Date("2026-11-02T09:00:00Z");
    r = await admin.call("GET", "/api/alerts");
    expect(r.data.alerts.map((a: { id: string }) => a.id)).toContain(`late:${late}`);

    expect((await admin.call("POST", "/api/alerts/dismiss", { all: true })).status).toBe(200);
    expect((await admin.call("GET", "/api/alerts")).data.alerts).toEqual([]);
    now = new Date("2026-09-29T12:00:00Z");
  });
});

describe("analytics and releases (spec §4.4)", () => {
  it("analytics over the real data: this month's revenue in rupees, and the range asked for", async () => {
    const r = await admin.call("GET", "/api/analytics?range=6");
    expect(r.status).toBe(200);
    expect(r.data.series).toHaveLength(7);
    expect(r.data.mrr).toBeGreaterThan(0);
    expect(r.data.listPriceInr).toBeTypeOf("number");
    expect((await admin.call("GET", "/api/analytics?range=5")).status).toBe(400);
  });

  it("releases: the latest version and which clients are on which", async () => {
    await admin.call("PATCH", "/api/settings", { latestVersion: "1.4.2" });
    const id = await create("Kestrel Logistics", monthly(4000));
    await t.pool.query(
      "INSERT INTO check_ins (client_id, at, app_version, active_users, lead_count, state) VALUES ($1, $2, '1.3.8', 1, 1, 'active')",
      [id, now],
    );
    const r = await admin.call("GET", "/api/releases");
    expect(r.data.latest).toBe("1.4.2");
    expect(r.data.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: "1.3.8",
          clients: [expect.objectContaining({ id, name: "Kestrel Logistics" })],
        }),
      ]),
    );
  });
});

describe("the admin's own account (spec §4.4)", () => {
  it("changes the password with the current one; a wrong current one changes nothing", async () => {
    expect(
      (
        await admin.call("POST", "/api/settings/password", {
          current: "wrong wrong wrong",
          next: "another long passphrase",
        })
      ).status,
    ).toBe(400);
    expect(
      (await admin.call("POST", "/api/settings/password", { current: password, next: "short" })).status,
    ).toBe(400);
    expect(
      (
        await admin.call("POST", "/api/settings/password", {
          current: password,
          next: "another long passphrase",
        })
      ).status,
    ).toBe(200);
    password = "another long passphrase";
    now = new Date(now.getTime() + 60_000);
    expect((await signIn(new Jar(() => ctx))).status).toBe(200);
  });

  it("a new two-step: a fresh secret, switched only once a code from it is typed", async () => {
    const start = await admin.call("POST", "/api/settings/two-step", {});
    expect(start.status).toBe(200);
    expect(start.data.uri).toMatch(/^otpauth:\/\/totp\/LUME%20Licences:/);
    const fresh = start.data.secret as string;
    // Not yet: the old authenticator still signs in.
    now = new Date(now.getTime() + 60_000);
    expect((await signIn(new Jar(() => ctx))).status).toBe(200);
    expect((await admin.call("POST", "/api/settings/two-step/confirm", { code: "000000" })).status).toBe(400);
    expect(
      (await admin.call("POST", "/api/settings/two-step/confirm", { code: totpCode(fresh, now.getTime()) }))
        .status,
    ).toBe(200);
    secret = fresh;
    now = new Date(now.getTime() + 60_000);
    expect((await signIn(new Jar(() => ctx))).status).toBe(200);
  });
});
