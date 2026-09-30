import { generateKeyPairSync } from "node:crypto";
import {
  ALL_GRANTS,
  LEGAL_VERSION,
  rawPublicKey,
  signLicence,
  type LicencePayload,
  type LicenceStateName,
} from "@lume/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../test/harness";
import { fire, sweep } from "../modules/tasks/engine";

const server = generateKeyPairSync("ed25519");
const INSTANCE = "LUME-TEST-0002";
const D = 24 * 3_600_000;

let h: Harness;
let admin: AuthedClient;
let adminUser: { id: string; email: string; password: string };
let state: LicenceStateName = "active";

const token = (s: LicenceStateName): string =>
  signLicence(
    {
      v: 1,
      kid: "t1",
      instanceId: INSTANCE,
      state: s,
      licenseType: "subscription",
      issuedAt: h.clock.now.toISOString(),
      validUntil: new Date(h.clock.now.getTime() + 8 * D).toISOString(),
      paidUntil: "2026-09-01",
      trialEndsAt: null,
      reason: s === "suspended" ? "suspended" : s === "active" ? "paid" : "overdue",
      notice: null,
    } satisfies LicencePayload,
    server.privateKey,
  );

beforeAll(async () => {
  h = await createHarness({
    licence: {
      mode: "enforce",
      instanceId: INSTANCE,
      licenseKey: "LUME-KEY-0002",
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.4.2",
      fetch: (async () =>
        new Response(JSON.stringify({ token: token(state) }), { status: 200 })) as typeof fetch,
    },
  });
  adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  admin = await h.signIn(adminUser);
});
afterAll(() => h.close());

/** The licence server says so, and the instance hears it. */
async function become(s: LicenceStateName) {
  state = s;
  await h.app.licence.check();
}
const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
  admin.inject({ method, url, ...(payload ? { payload } : {}) });
const code = async (r: Promise<{ json(): { error?: { code?: string } } }>) => (await r).json().error?.code;

describe("the licence is enforced in the API (L-A Task 3)", () => {
  it("active and grace: everything works", async () => {
    for (const s of ["active", "grace"] as const) {
      await become(s);
      expect((await call("POST", "/api/v1/leads", { name: `Works while ${s}` })).statusCode).toBe(201);
    }
  });

  it("read-only: every write is refused in LUME's words; reading still works", async () => {
    await become("read_only");
    const r = await call("POST", "/api/v1/leads", { name: "Blocked" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatchObject({
      code: "LICENSE_READ_ONLY",
      message: expect.stringMatching(/read-only/i),
    });
    expect(await code(call("PUT", "/api/v1/settings/messaging", { queueSize: 10 }))).toBe(
      "LICENSE_READ_ONLY",
    );
    expect((await call("GET", "/api/v1/leads")).statusCode).toBe(200);
    expect((await call("GET", "/api/v1/settings/messaging")).statusCode).toBe(200);
  });

  it("read-only still lets people sign in and out, check the licence and close the reminder", async () => {
    await become("read_only");
    const csrf = await h.csrf();
    const login = await h.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: adminUser.email, password: adminUser.password },
      cookies: csrf.cookies,
      headers: csrf.headers,
    });
    expect(login.statusCode).toBe(200);
    expect((await call("POST", "/api/v1/licence/check")).statusCode).toBe(200);
    expect((await call("POST", "/api/v1/licence/notice/dismiss")).statusCode).toBe(204);
  });

  it("suspended: everything is refused but signing in, the licence itself and the business's name", async () => {
    await become("suspended");
    expect(await code(call("GET", "/api/v1/leads"))).toBe("LICENSE_SUSPENDED");
    expect(await code(call("POST", "/api/v1/leads", { name: "No" }))).toBe("LICENSE_SUSPENDED");
    expect((await call("GET", "/api/v1/licence")).json()).toMatchObject({ state: "suspended" });
    expect((await call("GET", "/api/v1/auth/me")).statusCode).toBe(200);
    expect((await call("GET", "/api/v1/settings")).statusCode).toBe(200);
    // The licence server lifts it: the next check brings it back.
    await become("active");
    expect((await call("GET", "/api/v1/leads")).statusCode).toBe(200);
  });

  it("locked, people still get through the first-run steps LUME asks of them, so an admin reaches the export", async () => {
    for (const s of ["read_only", "suspended"] as const) {
      await become(s);
      // The agreement (after an update changes it) and onboarding's progress (with two-step enrolment in it).
      expect((await call("POST", "/api/v1/me/agreement", { version: LEGAL_VERSION })).statusCode).toBe(204);
      expect((await call("PUT", "/api/v1/me/onboarding", { step: "secure" })).statusCode).toBeLessThan(300);
      // Everything else stays refused.
      expect(await code(call("PUT", "/api/v1/me/tour", { status: "done" }))).toMatch(/^LICENSE_/);
    }
    await become("active");
  });

  it("read-only: a masked phone or email can still be revealed (it's reading, with a record of who did)", async () => {
    const lead = await h.seedLead({ ownerId: null, name: "Masked while read-only", phone: "+919812345678" });
    await become("read_only");
    const r = await call("POST", `/api/v1/leads/${lead}/contact/reveal`);
    expect(r.json().error?.code).not.toBe("LICENSE_READ_ONLY");
    await become("suspended");
    expect(await code(call("POST", `/api/v1/leads/${lead}/contact/reveal`))).toBe("LICENSE_SUSPENDED");
    await become("active");
  });

  it("webhooks are refused while read-only or suspended", async () => {
    await become("active");
    expect((await call("PUT", "/api/v1/integrations/webhooks", { enabled: true })).statusCode).toBe(200);
    const created = await call("POST", "/api/v1/webhooks/sources", {
      preset: "website",
      name: "Enforce hook",
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    const id = body.webhook?.id ?? body.source?.id ?? body.id;
    for (const s of ["read_only", "suspended"] as const) {
      await become(s);
      const r = await h.app.inject({
        method: "POST",
        url: `/webhooks/in/${id}`,
        payload: { name: "Hooked" },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe(s === "read_only" ? "LICENSE_READ_ONLY" : "LICENSE_SUSPENDED");
    }
    await become("active");
  });

  it("the follow-up clock waits while locked, and fires what was missed once the licence is back", async () => {
    await become("active");
    const lead = (await call("POST", "/api/v1/leads", { name: "Reminded Lead" })).json().lead.id;
    const t = await call("POST", `/api/v1/leads/${lead}/tasks`, {
      title: "Call back",
      // Follow-ups are scheduled against the real clock.
      due: { at: new Date(Date.now() + 60 * 60_000).toISOString() },
    });
    expect(t.statusCode).toBe(201);
    const [rem] = await h.queryAll<{ id: number }>(
      "SELECT id FROM scheduled_notifications WHERE task_id = $1 AND status = 'pending' ORDER BY fire_at LIMIT 1",
      [(t.json().task ?? t.json()).id],
    );
    await become("read_only");
    const deps = { app: h.app, pool: h.pool };
    const later = new Date(Date.now() + 3 * 3_600_000);
    expect(await fire(deps, rem!.id, later)).toBe("skipped");
    expect(await sweep(deps, later)).toBe(0);
    await become("active");
    expect(await sweep(deps, later)).toBeGreaterThanOrEqual(1);
  });
});

describe("work LUME holds back while locked says so in its log (spec §3.4)", () => {
  it("once when a clock stops, once when it carries on — not every tick", async () => {
    const { heldBack } = await import("./enforce");
    let s: LicenceStateName = "active";
    const info = vi.fn();
    const app = { licence: { view: () => ({ state: s }) }, log: { info } } as never;
    expect(heldBack(app, "the follow-up clock")).toBe(false);
    s = "read_only";
    expect(heldBack(app, "the follow-up clock")).toBe(true);
    expect(heldBack(app, "the follow-up clock")).toBe(true);
    expect(heldBack(app, "scheduled sheet syncs")).toBe(true);
    expect(info.mock.calls.map((c) => c[1])).toEqual([
      "the follow-up clock is held back while the licence is read_only",
      "scheduled sheet syncs is held back while the licence is read_only",
    ]);
    s = "active";
    expect(heldBack(app, "the follow-up clock")).toBe(false);
    expect(info.mock.calls.at(-1)![1]).toBe("the follow-up clock carries on: the licence is active");
  });
});
