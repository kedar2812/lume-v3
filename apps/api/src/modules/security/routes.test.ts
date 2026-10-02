import { ALL_GRANTS, mergeAnomaly, type Grant } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { securitySweep } from "./sweep";

/** Phase 6A Task 5: Settings → Security's API — the rules, alerts and their review, access limits. */
let h: Harness;
let owner: AuthedClient;
let ownerUser: SeededUser;
let admin: AuthedClient;
let adminUser: SeededUser;
let rep: SeededUser;
let repClient: AuthedClient;
let lead: string;
const repGrants: Grant[] = (["leads.view", "leads.contact.reveal"] as const).map((key) => ({
  key,
  scope: "own" as const,
}));

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  ownerUser = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  owner = await h.signIn(ownerUser);
  adminUser = await h.seedUser({
    grants: [
      { key: "security.manage", scope: null },
      { key: "audit.view", scope: null },
    ],
    totp: true,
    name: "Hana Ito",
  });
  admin = await h.signIn(adminUser);
});
afterAll(() => h.close());
beforeEach(async () => {
  rep = await h.seedUser({ grants: repGrants, name: "Rory Reid" });
  repClient = await h.signIn(rep);
  lead = await h.seedLead({ ownerId: rep.id, name: "Dana Whitfield", phone: "+971501112233" });
  await h.ownerPool.query("UPDATE settings SET security = security - 'anomaly' - 'watermark' WHERE id = 1");
});

const get = (c: AuthedClient, url: string) => c.inject({ method: "GET", url });
const put = (c: AuthedClient, url: string, payload: unknown) =>
  c.inject({ method: "PUT", url, payload: payload as object });
const post = (c: AuthedClient, url: string, payload?: unknown) =>
  c.inject({ method: "POST", url, ...(payload !== undefined ? { payload: payload as object } : {}) });
async function burst(n: number, threshold = 5, action = "suspend") {
  await h.ownerPool.query(
    "UPDATE settings SET security = jsonb_set(security, '{anomaly}', $1::jsonb) WHERE id = 1",
    [JSON.stringify({ reveals: { action, threshold } })],
  );
  for (let i = 0; i < n; i++) await post(repClient, `/api/v1/leads/${lead}/contact/reveal`);
  const res = await get(admin, "/api/v1/security/alerts?status=open");
  expect(res.statusCode, res.body).toBe(200);
  const alerts = res.json().alerts as { id: string; user: { id: string } }[];
  return alerts.find((a) => a.user.id === rep.id)!;
}

describe("the rules and the watermark", () => {
  it("start at the report's defaults, and round-trip", async () => {
    expect((await get(admin, "/api/v1/security/settings")).json()).toEqual({
      anomaly: mergeAnomaly({}),
      watermark: "masked_roles",
    });
    const next = {
      anomaly: { ...mergeAnomaly({}), reveals: { action: "alert", threshold: 40 } },
      watermark: "everyone",
    };
    expect((await put(admin, "/api/v1/security/settings", next)).json()).toEqual(next);
    expect((await get(owner, "/api/v1/security/settings")).json()).toEqual(next);
    const audited = (
      await h.pool.query(
        "SELECT actor_user_id FROM audit_log WHERE action = 'security.settings_changed' ORDER BY id DESC LIMIT 1",
      )
    ).rows[0];
    expect(audited.actor_user_id).toBe(adminUser.id);
  });

  it("refuses a pause on the send-queue rule, and out-of-range limits", async () => {
    const base = mergeAnomaly({});
    for (const anomaly of [
      { ...base, queueRuns: { action: "suspend", threshold: 3 } },
      { ...base, reveals: { action: "suspend", threshold: 2 } },
    ])
      expect((await put(admin, "/api/v1/security/settings", { anomaly, watermark: "off" })).statusCode).toBe(
        400,
      );
  });

  it("keeps the session settings beside them", async () => {
    await h.ownerPool.query(
      "UPDATE settings SET security = security || '{\"sessionIdleHours\": 10}'::jsonb WHERE id = 1",
    );
    await put(admin, "/api/v1/security/settings", { anomaly: mergeAnomaly({}), watermark: "off" });
    const s = (await h.pool.query("SELECT security FROM settings WHERE id = 1")).rows[0].security;
    expect(s.sessionIdleHours).toBe(10);
  });

  it("is for people who manage security", async () => {
    expect((await get(repClient, "/api/v1/security/settings")).statusCode).toBe(403);
    expect((await get(repClient, "/api/v1/security/alerts")).statusCode).toBe(403);
    expect((await get(repClient, "/api/v1/security/access")).statusCode).toBe(403);
  });
});

describe("alerts and their review", () => {
  it("list the open ones, with the person and the numbers", async () => {
    const a = await burst(6);
    expect(a).toMatchObject({
      user: { id: rep.id, name: "Rory Reid", initials: "RR" },
      rule: "reveals",
      action: "suspended",
      observed: 6,
      threshold: 5,
      status: "open",
      resolution: null,
    });
  });

  it("detail: the burst per minute adds up, LUME's steps in words, and the person's usual day", async () => {
    const a = await burst(6);
    // Admins are told once the pause has committed: wait for "Told …" to be written.
    const d = await vi.waitFor(async () => {
      const res = await get(admin, `/api/v1/security/alerts/${a.id}`);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(JSON.stringify(body.timeline)).toMatch(/Told (Maya Kapoor|Hana Ito)/);
      return body;
    });
    expect(d.burst.reduce((n: number, m: { n: number }) => n + m.n, 0)).toBe(6);
    const words: string[] = d.timeline.map((t: { words: string }) => t.words);
    expect(words[0]).toBe("The 6th contact in an hour: the limit");
    expect(words).toContain("Paused sign-in. Rory sees “Your access is paused”");
    expect(words.join(" | ")).toMatch(/Ended Rory’s 1 session \(Unknown device\)/);
    expect(d.person).toMatchObject({ roles: expect.any(Array), leadCount: 1, usualPerDay: 0 });
    expect(d.last30).toHaveLength(30);
  });

  it("restore: active again, resolved, and a second answer is refused", async () => {
    const a = await burst(6);
    const r = await post(admin, `/api/v1/security/alerts/${a.id}/resolve`, { resolution: "restored" });
    expect(r.statusCode).toBe(200);
    expect((await h.pool.query("SELECT status FROM users WHERE id = $1", [rep.id])).rows[0].status).toBe(
      "active",
    );
    const again = await post(owner, `/api/v1/security/alerts/${a.id}/resolve`, {
      resolution: "kept_suspended",
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("ALREADY_RESOLVED");
  });

  it("keep paused: resolved, and they stay paused", async () => {
    const a = await burst(6);
    expect(
      (await post(admin, `/api/v1/security/alerts/${a.id}/resolve`, { resolution: "kept_suspended" }))
        .statusCode,
    ).toBe(200);
    expect((await h.pool.query("SELECT status FROM users WHERE id = $1", [rep.id])).rows[0].status).toBe(
      "suspended",
    );
  });

  it("dismiss is only for an alert that paused nobody", async () => {
    const paused = await burst(6);
    expect(
      (await post(admin, `/api/v1/security/alerts/${paused.id}/resolve`, { resolution: "dismissed" }))
        .statusCode,
    ).toBe(409);
    const other = await h.seedUser({ grants: repGrants, name: "Sam Okafor" });
    const sam = await h.signIn(other);
    const samLead = await h.seedLead({ ownerId: other.id, name: "Lina Farah" });
    await h.ownerPool.query(
      "UPDATE settings SET security = jsonb_set(security, '{anomaly}', $1::jsonb) WHERE id = 1",
      [JSON.stringify({ reveals: { action: "alert", threshold: 5 } })],
    );
    for (let i = 0; i < 6; i++) await post(sam, `/api/v1/leads/${samLead}/contact/reveal`);
    const alerts = (await get(admin, "/api/v1/security/alerts?status=open")).json().alerts;
    const told = alerts.find((x: { user: { id: string } }) => x.user.id === other.id);
    expect(
      (await post(admin, `/api/v1/security/alerts/${told.id}/resolve`, { resolution: "dismissed" }))
        .statusCode,
    ).toBe(200);
  });

  it("People can restore a person directly", async () => {
    await burst(6);
    expect((await post(admin, `/api/v1/security/people/${rep.id}/restore`)).statusCode).toBe(204);
    expect((await h.pool.query("SELECT status FROM users WHERE id = $1", [rep.id])).rows[0].status).toBe(
      "active",
    );
  });
});

describe("access limits", () => {
  // A role the admin doesn't hold: the rep's own.
  const sales = async () => {
    const res = await get(admin, "/api/v1/security/access");
    expect(res.statusCode, res.body).toBe(200);
    const mine = await h.ownerPool.query<{ role_id: string }>(
      "SELECT role_id FROM user_roles WHERE user_id = $1",
      [rep.id],
    );
    return (res.json().roles as { id: string }[]).find((r) => r.id === mine.rows[0]!.role_id)!;
  };

  it("lists every role with who holds it, the business's hours, and where you are", async () => {
    const r = (await get(admin, "/api/v1/security/access")).json();
    expect(r.roles.length).toBeGreaterThan(0);
    expect(r.roles[0]).toMatchObject({
      id: expect.any(String),
      people: expect.any(Number),
      loginHours: null,
    });
    expect(r).toMatchObject({ timezone: expect.any(String), yourIp: expect.any(String) });
  });

  it("stores a bare address as a one-address network, audited", async () => {
    const role = await sales();
    const r = await put(admin, `/api/v1/security/access/${role.id}`, {
      loginHours: null,
      ipAllowlist: ["86.98.40.12"],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().role.ipAllowlist).toEqual(["86.98.40.12/32"]);
    await put(admin, `/api/v1/security/access/${role.id}`, { loginHours: null, ipAllowlist: null });
  });

  it("won't save limits that would sign you out right now (Review Focus 5)", async () => {
    const r = (await get(admin, "/api/v1/security/access")).json();
    const mine = await h.ownerPool.query<{ role_id: string }>(
      "SELECT role_id FROM user_roles WHERE user_id = $1",
      [adminUser.id],
    );
    const roleId = mine.rows[0]!.role_id;
    const refused = await put(admin, `/api/v1/security/access/${roleId}`, {
      loginHours: null,
      ipAllowlist: ["10.200.0.0/16"],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("WOULD_LOCK_YOU_OUT");
    const kept = await h.pool.query("SELECT ip_allowlist FROM roles WHERE id = $1", [roleId]);
    expect(kept.rows[0].ip_allowlist).toBeNull();
    const ok = await put(admin, `/api/v1/security/access/${roleId}`, {
      loginHours: null,
      ipAllowlist: ["10.200.0.0/16", r.yourIp],
    });
    expect(ok.statusCode).toBe(200);
    await put(admin, `/api/v1/security/access/${roleId}`, { loginHours: null, ipAllowlist: null });
  });

  it("business hours follow Settings' working hours", async () => {
    const role = await sales();
    const r = await put(admin, `/api/v1/security/access/${role.id}`, {
      loginHours: { business: true, days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" },
      ipAllowlist: null,
    });
    expect(r.json().role.loginHours).toMatchObject({ business: true });
    await put(admin, `/api/v1/security/access/${role.id}`, { loginHours: null, ipAllowlist: null });
  });
});

describe("the 5-minute sweep", () => {
  it("catches a breach the inline check never saw, once", async () => {
    await h.ownerPool.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, at)
       SELECT $1, 'lead.contact.reveal', 'lead', $2, now() - interval '5 minutes' FROM generate_series(1, 31)`,
      [rep.id, lead],
    );
    expect(await securitySweep({ pool: h.pool, clock: () => h.clock.now })).toBe(1);
    expect((await h.pool.query("SELECT status FROM users WHERE id = $1", [rep.id])).rows[0].status).toBe(
      "suspended",
    );
    expect(await securitySweep({ pool: h.pool, clock: () => h.clock.now })).toBe(0);
    const alerts = await h.pool.query("SELECT observed, action FROM security_alerts WHERE user_id = $1", [
      rep.id,
    ]);
    expect(alerts.rows).toEqual([{ observed: 31, action: "suspended" }]);
  });

  it("never counts the owner, or someone who sees every contact", async () => {
    await h.ownerPool.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, at)
       SELECT $1, 'lead.contact.reveal', 'lead', $2, now() - interval '5 minutes' FROM generate_series(1, 40)`,
      [ownerUser.id, lead],
    );
    expect(await securitySweep({ pool: h.pool, clock: () => h.clock.now })).toBe(0);
  });
});

describe("the watermark, as each person signs in", () => {
  it("is on for people who can't see every contact, by default", async () => {
    const me = (await get(repClient, "/api/v1/auth/me")).json();
    expect(me.watermark).toBe(true);
    expect(me.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await get(owner, "/api/v1/auth/me")).json().watermark).toBe(false);
  });

  it("follows the setting", async () => {
    await put(admin, "/api/v1/security/settings", { anomaly: mergeAnomaly({}), watermark: "everyone" });
    expect((await get(owner, "/api/v1/auth/me")).json().watermark).toBe(true);
    await put(admin, "/api/v1/security/settings", { anomaly: mergeAnomaly({}), watermark: "off" });
    expect((await get(repClient, "/api/v1/auth/me")).json().watermark).toBe(false);
  });
});
