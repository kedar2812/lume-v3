import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCalendlyFake, type CalendlyFake } from "../../../test/calendly-fake";
import { TEST_PUBLIC_URL, createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let fake: CalendlyFake;
let admin: AuthedClient;
let rep: AuthedClient;
const url = "/api/v1/integrations/calendly";

beforeAll(async () => {
  fake = await startCalendlyFake();
  h = await createHarness({ preset: "coaching", calendlyEndpoint: fake.url });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true }));
});
afterAll(async () => {
  await h.close();
  await fake.close();
});

const call = (c: AuthedClient, method: "GET" | "POST" | "PATCH" | "DELETE", payload?: unknown) =>
  c.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
const sources = () =>
  h.ownerPool.query<{ id: string; status: string }>(
    "SELECT id, status FROM lead_sources WHERE type = 'calendly' ORDER BY created_at",
  );

describe("connecting Calendly (5B Task 4)", () => {
  it("isn't connected until an admin connects it", async () => {
    expect((await call(admin, "GET")).json()).toEqual({ connected: false });
    expect((await admin.inject({ method: "GET", url: "/api/v1/integrations" })).json().calendly).toEqual({
      connected: false,
    });
    expect((await call(rep, "GET")).statusCode).toBe(403);
    expect((await call(rep, "POST", { token: fake.token })).statusCode).toBe(403);
  });

  it("a token Calendly refuses, a plan without webhooks, or Calendly down: said in LUME's words, nothing kept", async () => {
    const bad = await call(admin, "POST", { token: "not-a-token" });
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, "CALENDLY_TOKEN"]);
    expect(bad.body).not.toContain("not-a-token");
    fake.freePlan = true;
    try {
      const plan = await call(admin, "POST", { token: fake.token });
      expect([plan.statusCode, plan.json().error.code]).toEqual([409, "CALENDLY_PLAN"]);
      expect(plan.json().error.message).toMatch(/Standard plan/);
    } finally {
      fake.freePlan = false;
    }
    fake.fail(503, 8);
    const down = await call(admin, "POST", { token: fake.token });
    expect([down.statusCode, down.json().error.code]).toEqual([503, "CALENDLY_UNAVAILABLE"]);
    fake.fail(503, 0);
    expect((await sources()).rows).toEqual([]);
    expect(fake.subscriptions).toEqual([]);
  });

  it("connects: one source, one subscription to this instance's address, the token and key sealed away", async () => {
    const r = await call(admin, "POST", { token: fake.token });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      connected: true,
      account: { name: "Maya Kapoor", email: "maya@business.test" },
      scope: "organization",
      status: "active",
      settings: { createLeads: true, rescheduleFollowUp: true, phoneQuestion: null },
    });
    const [src] = (await sources()).rows;
    expect(fake.subscriptions).toHaveLength(1);
    const sub = fake.subscriptions[0]!;
    expect(sub.callbackUrl).toBe(`${TEST_PUBLIC_URL}/webhooks/calendly/${src!.id}`);
    // Neither secret anywhere it could be read: the response, any column of the source, the audit.
    const everywhere = [
      r.body,
      JSON.stringify((await h.ownerPool.query("SELECT * FROM lead_sources WHERE id = $1", [src!.id])).rows),
      JSON.stringify(
        (await h.ownerPool.query("SELECT * FROM audit_log WHERE action LIKE 'calendly.%'")).rows,
      ),
    ].join("\n");
    expect(everywhere).not.toContain(fake.token);
    expect(everywhere).not.toContain(sub.signingKey);
    const audit = await h.queryAll<{ action: string }>(
      "SELECT action FROM audit_log WHERE action LIKE 'calendly.%' ORDER BY id",
    );
    expect(audit.map((a) => a.action)).toEqual(["calendly.connected"]);
    expect((await admin.inject({ method: "GET", url: "/api/v1/integrations" })).json().calendly).toEqual({
      connected: true,
    });
  });

  it("one Calendly per LUME", async () => {
    const again = await call(admin, "POST", { token: fake.token });
    expect([again.statusCode, again.json().error.code]).toEqual([409, "CALENDLY_CONNECTED"]);
  });

  it("its switches: new leads, a Reschedule follow-up, and which booking question holds the phone", async () => {
    const r = await call(admin, "PATCH", { createLeads: false, phoneQuestion: "  Your WhatsApp number " });
    expect(r.json().settings).toEqual({
      createLeads: false,
      rescheduleFollowUp: true,
      phoneQuestion: "Your WhatsApp number",
    });
    expect((await call(admin, "PATCH", { phoneQuestion: "x".repeat(201) })).statusCode).toBe(400);
    expect((await call(admin, "PATCH", { createLeads: true, phoneQuestion: null })).json().settings).toEqual({
      createLeads: true,
      rescheduleFollowUp: true,
      phoneQuestion: null,
    });
  });

  it("disconnecting unsubscribes and forgets — even with Calendly down", async () => {
    const r = await call(admin, "DELETE");
    expect([r.statusCode, r.json()]).toEqual([200, { connected: false }]);
    expect(fake.subscriptions).toEqual([]);
    expect((await sources()).rows.map((s) => s.status)).toEqual(["archived"]);
    expect((await call(admin, "POST", { token: fake.token })).statusCode).toBe(200);
    fake.fail(503, 8);
    const down = await call(admin, "DELETE");
    fake.fail(503, 0);
    expect(down.statusCode).toBe(200);
    expect((await sources()).rows.map((s) => s.status)).toEqual(["archived", "archived"]);
    const audit = await h.queryAll<{ action: string }>(
      "SELECT action FROM audit_log WHERE action IN ('calendly.connected', 'calendly.disconnected') ORDER BY id",
    );
    expect(audit.map((a) => a.action)).toEqual([
      "calendly.connected",
      "calendly.disconnected",
      "calendly.connected",
      "calendly.disconnected",
    ]);
    expect((await call(admin, "DELETE")).statusCode).toBe(404);
    fake.subscriptions.splice(0);
  });

  it("someone who doesn't administer the Calendly organization connects their own bookings", async () => {
    fake.orgAdmin = false;
    try {
      expect((await call(admin, "POST", { token: fake.token })).json().scope).toBe("user");
    } finally {
      fake.orgAdmin = true;
      await call(admin, "DELETE");
    }
  });
});
