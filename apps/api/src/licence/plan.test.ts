import { generateKeyPairSync } from "node:crypto";
import { ALL_GRANTS, rawPublicKey, signLicence, type LicencePayload, type PlanClaim } from "@lume/core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../test/harness";

/** Control each client (spec 2026-10-17 control §2): a LUME keeps the plan its licence server signs. */
const server = generateKeyPairSync("ed25519");
const INSTANCE = "LUME-TEST-PLAN";
const KEY = "LUME-KEY-SECRET-PLAN";
const D = 86_400_000;
let h: Harness;
let owner: AuthedClient;
let ownerUser: { id: string; email: string; password: string };
let repUser: { id: string; email: string; password: string };
let plan: PlanClaim | undefined;
const sent: Record<string, unknown>[] = [];

const all = { googleSheets: true, webhooks: true, googleCalendar: true, calendly: true };
const token = () =>
  signLicence(
    {
      v: 1,
      kid: "t1",
      instanceId: INSTANCE,
      state: "active",
      licenseType: "subscription",
      issuedAt: h.clock.now.toISOString(),
      validUntil: new Date(h.clock.now.getTime() + 8 * D).toISOString(),
      paidUntil: "2026-12-31",
      trialEndsAt: null,
      reason: "paid",
      notice: null,
      ...(plan ? { plan } : {}),
    } satisfies LicencePayload,
    server.privateKey,
  );
const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
  return new Response(JSON.stringify({ token: token() }), { status: 200 });
}) as typeof fetch;

beforeAll(async () => {
  h = await createHarness({
    licence: {
      mode: "enforce",
      instanceId: INSTANCE,
      licenseKey: KEY,
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.6.0",
      fetch: fakeFetch,
    },
  });
  ownerUser = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  owner = await h.signIn(ownerUser);
  repUser = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
});
afterAll(() => h.close());
beforeEach(async () => {
  plan = undefined;
  sent.length = 0;
  await h.ownerPool.query(
    "UPDATE user_invites SET revoked_at = now() WHERE accepted_at IS NULL AND revoked_at IS NULL",
  );
  await h.ownerPool.query(
    `UPDATE settings SET integrations = jsonb_set(integrations, '{webhooks}', '{"enabled": true}'::jsonb) WHERE id = 1`,
  );
});

const check = async () =>
  (await h.signIn(ownerUser)).inject({ method: "POST", url: "/api/v1/licence/check" });
const taken = async () =>
  Number(
    (
      await h.ownerPool.query<{ n: string }>(
        `SELECT ((SELECT count(*) FROM users WHERE status IN ('active', 'suspended'))
               + (SELECT count(*) FROM user_invites WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())) AS n`,
      )
    ).rows[0]!.n,
  );
const invite = (email: string) =>
  owner.inject({
    method: "POST",
    url: "/api/v1/invites",
    payload: { email, name: "New Person", roleIds: [] },
  });

describe("the plan, kept (spec 2026-10-17 control §2)", () => {
  it("says it can keep a plan and which modules are on, with its check-in", async () => {
    await check();
    expect(sent[0]!.accepts).toEqual(["announcements", "plan", "plan2"]);
    expect((sent[0]!.health as { modulesOn: string[] }).modulesOn).toContain("webhooks");
  });

  it("tells only a licence server that knows LUME AI that it's on (an older one would refuse the check-in)", async () => {
    await h.ownerPool.query(
      `UPDATE settings SET integrations = jsonb_set(integrations, '{ai}', '{"enabled": true}'::jsonb) WHERE id = 1`,
    );
    plan = { places: null, modules: all }; // an older licence server: no ai key in what it signs
    await check();
    await check();
    expect((sent.at(-1)!.health as { modulesOn: string[] }).modulesOn).not.toContain("ai");
    plan = { places: null, modules: { ...all, ai: true, whatsapp: true }, aiReadsHourly: null, aiReadsWeekly: null };
    await check();
    await check();
    expect((sent.at(-1)!.health as { modulesOn: string[] }).modulesOn).toContain("ai");
    await h.ownerPool.query(
      `UPDATE settings SET integrations = integrations - 'ai' WHERE id = 1`,
    );
  });

  it("switches LUME AI off once when the plan leaves it out", async () => {
    await h.ownerPool.query(
      `UPDATE settings SET integrations = jsonb_set(integrations, '{ai}', '{"enabled": true}'::jsonb) WHERE id = 1`,
    );
    plan = { places: null, modules: { ...all, ai: false, whatsapp: true }, aiReadsHourly: null, aiReadsWeekly: null };
    await check();
    await check();
    const s = await h.ownerPool.query("SELECT integrations -> 'ai' ->> 'enabled' AS on FROM settings WHERE id = 1");
    expect(s.rows[0].on).toBe("false");
    const audits = await h.ownerPool.query(
      "SELECT diff FROM audit_log WHERE action = 'integration.disabled' AND diff ->> 'by' = 'plan' AND diff ->> 'module' = 'ai'",
    );
    expect(audits.rows).toHaveLength(1);
  });

  it("shows places taken to people who manage settings, and nothing to anyone else", async () => {
    plan = { places: 50, modules: all };
    await check();
    const me = (await owner.inject({ method: "GET", url: "/api/v1/licence" })).json();
    expect(me.plan).toEqual({ places: 50, taken: await taken(), modules: all });
    const rep = await h.signIn(repUser);
    expect((await rep.inject({ method: "GET", url: "/api/v1/licence" })).json().plan).toBeNull();
  });

  it("refuses an invite when every place is taken (open invites count), in plain words", async () => {
    const n = await taken();
    plan = { places: n + 1, modules: all };
    await check();
    expect((await invite("first@plan.example")).statusCode).toBe(201);
    const r = await invite("second@plan.example");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({
      code: "PLAN_PLACES",
      message: `Every place on this LUME's plan is taken (${n + 1} of ${n + 1}). Pause someone, or ask LUME's team about more places.`,
    });
  });

  it("removes nobody when places shrink below the people using it, and restoring someone waits for room", async () => {
    const someone = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
    await owner.inject({ method: "POST", url: `/api/v1/users/${someone.id}/disable`, payload: {} });
    plan = { places: 1, modules: all };
    await check();
    const active = await h.ownerPool.query("SELECT count(*)::int AS n FROM users WHERE status = 'active'");
    expect(active.rows[0].n).toBeGreaterThan(1);
    const r = await owner.inject({ method: "POST", url: `/api/v1/users/${someone.id}/enable` });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("PLAN_PLACES");
  });

  it("switches off a module the plan leaves out, once, with an audit row and one notice to admins", async () => {
    plan = { places: null, modules: { ...all, webhooks: false } };
    await check();
    await check();
    const s = await h.ownerPool.query(
      "SELECT integrations -> 'webhooks' ->> 'enabled' AS on FROM settings WHERE id = 1",
    );
    expect(s.rows[0].on).toBe("false");
    const audits = await h.ownerPool.query(
      "SELECT diff FROM audit_log WHERE action = 'integration.disabled' AND diff ->> 'by' = 'plan' AND diff ->> 'module' = 'webhooks'",
    );
    expect(audits.rows.map((r) => r.diff.module)).toEqual(["webhooks"]);
    // One notice per admin (the owner and anyone who manages settings), however many check-ins carried the plan.
    // Notifications are each person's own (row-level security): read them as the backup role, as other tests do.
    const reader = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
    await reader.connect();
    const notes = await reader
      .query(
        "SELECT user_id, title, body FROM notifications WHERE kind = 'system_alert' AND title LIKE 'Webhooks%'",
      )
      .finally(() => reader.end());
    expect(notes.rows.length).toBeGreaterThan(0);
    expect(new Set(notes.rows.map((r) => r.user_id)).size).toBe(notes.rows.length);
    expect(notes.rows[0]).toMatchObject({
      title: "Webhooks was switched off",
      body: "It isn't in this LUME's plan any more. Its settings are kept.",
    });
    // And it can't be switched back on while the plan leaves it out.
    const on = await owner.inject({
      method: "PUT",
      url: "/api/v1/integrations/webhooks",
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(409);
    expect(on.json().error.code).toBe("PLAN_MODULE");
  });

  it("no plan in the answer means no limits", async () => {
    plan = undefined;
    await check();
    expect((await owner.inject({ method: "GET", url: "/api/v1/licence" })).json().plan).toBeNull();
    expect((await invite("free@plan.example")).statusCode).toBe(201);
    const on = await owner.inject({
      method: "PUT",
      url: "/api/v1/integrations/webhooks",
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
  });
});
