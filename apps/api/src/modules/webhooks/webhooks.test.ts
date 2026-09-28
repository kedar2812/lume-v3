import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { signFor } from "./secret";

let h: Harness;
let admin: AuthedClient;
let manager: AuthedClient; // may manage integrations, but not add leads

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  manager = await h.signIn(
    await h.seedUser({ grants: [{ key: "integrations.manage", scope: "all" }], totp: true }),
  );
});
afterAll(() => h.close());

const call = (
  c: AuthedClient,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
) =>
  c.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
/** Post as the sender would, signed with this secret. */
function post(id: string, body: Record<string, unknown>, secret: string) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(h.clock.now.getTime() / 1000));
  return h.app.inject({
    method: "POST",
    url: `/webhooks/in/${id}`,
    headers: {
      "content-type": "application/json",
      "x-lume-timestamp": ts,
      "x-lume-signature": signFor(secret, ts, Buffer.from(raw)),
    },
    payload: raw,
  });
}
const TEST_POST = { name: "Test Person", contact: { phone: "+971501239001" }, email: "test@example.test" };

/** Create → test post → draft → save, as the wizard does. */
async function setUp(name = "Landing page") {
  const made = await call(admin, "POST", "/api/v1/webhooks/sources", { preset: "website", name });
  expect(made.statusCode).toBe(201);
  const { source, secret } = made.json();
  expect((await post(source.id, TEST_POST, secret)).statusCode).toBe(202);
  const d = await call(admin, "POST", `/api/v1/webhooks/sources/${source.id}/draft`);
  expect(d.statusCode).toBe(201);
  const saved = await call(admin, "POST", `/api/v1/webhooks/sources/${source.id}/save`, {
    importId: d.json().id,
    keepTest: true,
  });
  expect(saved.statusCode).toBe(200);
  await h.runWebhooks();
  return { id: source.id as string, secret: secret as string, draft: d.json() };
}

describe("the Webhooks module (2C spec §7)", () => {
  it("is off by default; switching it on is audited", async () => {
    expect((await call(admin, "GET", "/api/v1/integrations")).json().webhooks).toEqual({
      enabled: false,
      manychat: false,
    });
    const off = await call(admin, "POST", "/api/v1/webhooks/sources", {
      preset: "website",
      name: "Too soon",
    });
    expect(off.json().error.code).toBe("WEBHOOKS_OFF");
    const on = await call(admin, "PUT", "/api/v1/integrations/webhooks", { enabled: true });
    expect(on.json().webhooks).toEqual({ enabled: true, manychat: false });
    const logged = await h.queryAll<{ diff: { module: string } }>(
      "SELECT diff FROM audit_log WHERE action = 'integration.enabled'",
    );
    expect(logged.map((l) => l.diff.module)).toContain("webhooks");
  });

  it("a new webhook shows its address and secret once; they're never shown again", async () => {
    const made = (
      await call(admin, "POST", "/api/v1/webhooks/sources", { preset: "website", name: "Contact form" })
    ).json();
    expect(made.address).toBe(`${new URL(made.address).origin}/webhooks/in/${made.source.id}`);
    expect(made.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made).toMatchObject({
      mode: "signed",
      source: { status: "draft", preset: "website", mode: "signed" },
    });
    const got = (await call(admin, "GET", `/api/v1/webhooks/sources/${made.source.id}`)).body;
    expect(got).not.toContain(made.secret);
    const list = (await call(admin, "GET", "/api/v1/webhooks/sources")).body;
    expect(list).not.toContain(made.secret);
  });

  it("ManyChat stays hidden until it's switched on for this server", async () => {
    const r = await call(admin, "POST", "/api/v1/webhooks/sources", {
      preset: "manychat",
      name: "Instagram DMs",
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("PRESET_HIDDEN");
  });

  it("the test post lists its paths; save keeps it as the first lead", async () => {
    const made = (
      await call(admin, "POST", "/api/v1/webhooks/sources", { preset: "website", name: "Hero form" })
    ).json();
    expect((await call(admin, "GET", `/api/v1/webhooks/sources/${made.source.id}/test`)).statusCode).toBe(
      204,
    );
    await post(made.source.id, TEST_POST, made.secret);
    const t = (await call(admin, "GET", `/api/v1/webhooks/sources/${made.source.id}/test`)).json();
    expect(t.paths).toEqual(["name", "contact.phone", "email"]);
    expect(t.unmappable).toEqual([]);
    const d = (await call(admin, "POST", `/api/v1/webhooks/sources/${made.source.id}/draft`)).json();
    expect(d).toMatchObject({ headers: ["name", "contact.phone", "email"], rowCount: 1 });
    expect(d.mapping.columns).toEqual([
      { column: 0, to: "field", field: "name" },
      { column: 1, to: "field", field: "phone" },
      { column: 2, to: "field", field: "email" },
    ]);
    expect((await call(admin, "POST", `/api/v1/imports/${d.id}/preview`, {})).statusCode).toBe(200);
    const saved = (
      await call(admin, "POST", `/api/v1/webhooks/sources/${made.source.id}/save`, {
        importId: d.id,
        keepTest: true,
      })
    ).json();
    expect(saved).toMatchObject({ status: "active", name: "Hero form" });
    await h.runWebhooks();
    const leads = await h.queryAll<{ name: string }>("SELECT name FROM leads WHERE source_id = $1", [
      made.source.id,
    ]);
    expect(leads.map((l) => l.name)).toEqual(["Test Person"]);
    const view = (await call(admin, "GET", `/api/v1/webhooks/sources/${made.source.id}`)).json();
    expect(view).toMatchObject({ eventsAllTime: 1, created: 1, problems: 0 });
    expect(view.events[0]).toMatchObject({ status: "done", result: "created" });
  });

  it("a new secret works at once, and the old one stops", async () => {
    const w = await setUp("Rotating form");
    const { secret } = (await call(admin, "POST", `/api/v1/webhooks/sources/${w.id}/rotate`)).json();
    expect(secret).not.toBe(w.secret);
    expect((await post(w.id, { name: "Old Secret" }, w.secret)).statusCode).toBe(401);
    expect((await post(w.id, { name: "New Secret" }, secret)).statusCode).toBe(202);
  });

  it("paused asks senders to come back later; resumed takes posts again", async () => {
    const w = await setUp("Pausing form");
    expect(
      (await call(admin, "PATCH", `/api/v1/webhooks/sources/${w.id}`, { paused: true })).json().status,
    ).toBe("paused");
    expect((await post(w.id, { name: "While Paused" }, w.secret)).statusCode).toBe(503);
    await call(admin, "PATCH", `/api/v1/webhooks/sources/${w.id}`, { paused: false });
    expect((await post(w.id, { name: "After Resume" }, w.secret)).statusCode).toBe(202);
  });

  it("a problem post can be retried once the setup is fixed, or dismissed", async () => {
    const w = await setUp("Problem form");
    // A value over 10,000 characters is always a problem (process.ts), whatever the setup.
    await post(w.id, { name: "a".repeat(10_001) }, w.secret);
    await post(w.id, { name: "b".repeat(10_001) }, w.secret);
    await h.runWebhooks();
    const { problemEvents: problems } = (await call(admin, "GET", `/api/v1/webhooks/sources/${w.id}`)).json();
    expect(problems).toHaveLength(2);
    expect(problems[0].problems.length).toBeGreaterThan(0);
    const retry = await call(
      admin,
      "POST",
      `/api/v1/webhooks/sources/${w.id}/events/${problems[0].id}/retry`,
    );
    expect(retry.statusCode).toBe(202);
    expect(h.webhookQueue).toContain(problems[0].id);
    await h.runWebhooks();
    const dismiss = await call(
      admin,
      "POST",
      `/api/v1/webhooks/sources/${w.id}/events/${problems[1].id}/dismiss`,
    );
    expect(dismiss.statusCode).toBe(204);
    const after = (await call(admin, "GET", `/api/v1/webhooks/sources/${w.id}`)).json();
    expect(after.problemEvents.map((p: { id: number }) => p.id)).toEqual([problems[0].id]);
    expect(after.problems).toBe(1);
  });

  it("removing a webhook archives it; posts to it are refused like a stranger's", async () => {
    const w = await setUp("Removed form");
    expect((await call(admin, "DELETE", `/api/v1/webhooks/sources/${w.id}`)).statusCode).toBe(204);
    expect((await post(w.id, { name: "After Removal" }, w.secret)).statusCode).toBe(401);
    expect((await call(admin, "GET", `/api/v1/webhooks/sources/${w.id}`)).statusCode).toBe(404);
    const [s] = await h.queryAll<{ status: string }>("SELECT status FROM lead_sources WHERE id = $1", [w.id]);
    expect(s!.status).toBe("archived");
  });

  it("closing the setup throws away only its draft, never the webhook or its posts", async () => {
    const w = await setUp("Kept form");
    const d = (await call(admin, "POST", `/api/v1/webhooks/sources/${w.id}/draft`)).json();
    expect((await call(admin, "DELETE", `/api/v1/imports/${d.id}`)).statusCode).toBe(204);
    expect((await call(admin, "GET", `/api/v1/webhooks/sources/${w.id}`)).json()).toMatchObject({
      status: "active",
      eventsAllTime: 1,
    });
    expect(await h.queryAll("SELECT 1 FROM imports WHERE id = $1", [d.id])).toHaveLength(0);
  });

  it("someone who can manage integrations but can't add leads can't set up the columns", async () => {
    const made = (
      await call(admin, "POST", "/api/v1/webhooks/sources", { preset: "website", name: "Manager form" })
    ).json();
    await post(made.source.id, TEST_POST, made.secret);
    const r = await call(manager, "POST", `/api/v1/webhooks/sources/${made.source.id}/draft`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("CANNOT_IMPORT");
  });
});
