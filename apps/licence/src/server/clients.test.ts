import { checkBody, rawPublicKey, verifyLicence } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdmin } from "./auth";
import { analyticsClients } from "./clients";
import { handleCheck } from "./check";
import type { Ctx } from "./context";
import { adminSession, type Jar, licenceDb, TEST_PAIR, testCtx, type LicenceTestDb } from "./testing";

let t: LicenceTestDb;
let now: Date;
let ctx: Ctx;
let admin: Jar;
const KEYS = { t1: rawPublicKey(TEST_PAIR.publicKey) };

const NEW = {
  name: "Harbour Clinic",
  country: "IN",
  region: "KA",
  city: "Bengaluru",
  source: "demo",
  plan: { type: "subscription", currency: "INR", amount: 2999, periodMonths: 1 },
};
async function create(over: Record<string, unknown> = {}) {
  const r = await admin.call("POST", "/api/clients", { ...NEW, ...over });
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data as { client: { id: string; instanceId: string; slug: string }; licenseKey: string };
}
const detail = async (id: string) => (await admin.call("GET", `/api/clients/${id}`)).data;
const events = async (id: string) =>
  (
    await t.pool.query<{ kind: string; detail: Record<string, unknown> }>(
      // The admin's actions (check-ins add their own: first_check_in, version, state, and the binding at the first).
      "SELECT kind, detail FROM events WHERE client_id = $1 AND kind NOT IN ('first_check_in', 'version', 'state', 'activated') ORDER BY id",
      [id],
    )
  ).rows;
async function check(instanceId: string, licenseKey: string) {
  const r = await handleCheck(
    new Request("https://licence.test/v1/check", {
      method: "POST",
      headers: { "x-real-ip": "203.0.113.9" },
      body: JSON.stringify(
        checkBody({
          instanceId,
          licenseKey,
          installId: "0190e0c0-0000-7000-8000-0000000000c1",
          appVersion: "1.4.2",
          activeUserCount: 3,
          leadCount: 10,
          now,
        }),
      ),
    }),
    ctx,
  );
  return { status: r.status, token: r.status === 200 ? ((await r.json()) as { token: string }).token : null };
}

beforeAll(async () => {
  t = await licenceDb();
  now = new Date("2026-09-29T09:00:00Z");
  ctx = testCtx(t.pool, () => now);
  await createAdmin(ctx, { email: "owner@lume.test", password: "a long and lovely passphrase" });
  admin = await adminSession(ctx);
  await t.pool.query(
    "INSERT INTO fx_rates (day, currency, rate_to_inr) VALUES ('2026-09-29', 'AED', 24.07), ('2026-09-29', 'USD', 88.4)",
  );
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  now = new Date("2026-09-29T09:00:00Z");
});

describe("New licence (spec §4.4)", () => {
  it("creates the client, its licence and price; the key is shown once and only its hash is kept", async () => {
    const { client, licenseKey } = await create();
    expect(licenseKey).toMatch(/^LUME(-[0-9A-Z]{4}){5}$/);
    expect(client.instanceId).toMatch(/^LUME-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(client.slug).toBe("harbour-clinic");
    const d = await detail(client.id);
    expect(JSON.stringify(d)).not.toContain(licenseKey);
    expect(d.client).toMatchObject({
      name: "Harbour Clinic",
      country: "IN",
      region: "KA",
      city: "Bengaluru",
      source: "demo",
      type: "subscription",
      paidUntil: "2026-09-29",
      state: "active",
      price: { currency: "INR", amount: 2999, periodMonths: 1 },
      monthlyInr: 2999,
      keyMasked: `LUME-••••-••••-••••-••••-${licenseKey.slice(-4)}`,
    });
    expect((await events(client.id)).map((e) => e.kind)).toEqual(["created"]);
    // The key works, once.
    expect((await check(client.instanceId, licenseKey)).status).toBe(200);
  });

  it("a second client with the same name gets its own subdomain", async () => {
    const a = await create({ name: "Lotus Wellness" });
    const b = await create({ name: "Lotus Wellness" });
    expect(a.client.slug).toBe("lotus-wellness");
    expect(b.client.slug).toBe("lotus-wellness-2");
  });

  it("a trial runs 14 days and isn't paying yet; a one-time price is perpetual", async () => {
    const trial = await create({
      name: "Cedar & Co Salon",
      plan: { type: "trial", currency: "INR", amount: 3999, periodMonths: 1 },
    });
    expect((await detail(trial.client.id)).client).toMatchObject({
      type: "trial",
      trialEnds: "2026-10-13",
      monthlyInr: 0,
    });
    const once = await create({
      name: "Northwind Coaching",
      country: "GB",
      region: null,
      city: "Manchester",
      plan: { type: "perpetual", currency: "GBP", amount: 1200, periodMonths: 0 },
    });
    expect((await detail(once.client.id)).client).toMatchObject({
      type: "perpetual",
      monthlyInr: 0,
      paidUntil: null,
    });
  });

  it("refuses what doesn't make sense: no name, a state outside India, a bad country, a price of nothing", async () => {
    for (const bad of [
      { name: " " },
      { country: "AE", region: "KA" },
      { country: "XX" },
      { country: "in" },
      { plan: { type: "subscription", currency: "INR", amount: 0, periodMonths: 1 } },
      { plan: { type: "subscription", currency: "INR", amount: 100, periodMonths: 0 } },
      { plan: { type: "subscription", currency: "ZZZ", amount: 100, periodMonths: 1 } },
      { source: "tv" },
      { extra: true },
    ]) {
      const r = await admin.call("POST", "/api/clients", { ...NEW, ...bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("a client's actions (spec §4.4)", () => {
  it("changing the price adds a row (the old one stays), switching currency at today's rate in analytics", async () => {
    const { client } = await create({
      name: "Oakline Realty",
      country: "AE",
      region: null,
      city: "Dubai",
      plan: { type: "subscription", currency: "AED", amount: 350, periodMonths: 1 },
    });
    now = new Date("2026-09-29T10:00:00Z");
    const r = await admin.call("POST", `/api/clients/${client.id}/price`, {
      currency: "AED",
      amount: 450,
      periodMonths: 1,
    });
    expect(r.status).toBe(200);
    const d = await detail(client.id);
    expect(d.client.price).toEqual({ currency: "AED", amount: 450, periodMonths: 1 });
    expect(d.client.monthlyInr).toBeCloseTo(450 * 24.07, 2);
    const rows = await t.pool.query("SELECT amount FROM prices WHERE client_id = $1 ORDER BY id", [
      client.id,
    ]);
    expect(rows.rows.map((x) => Number(x.amount))).toEqual([350, 450]);
    expect((await events(client.id)).at(-1)).toEqual({
      kind: "price",
      detail: {
        from: { currency: "AED", amount: 350, periodMonths: 1 },
        to: { currency: "AED", amount: 450, periodMonths: 1 },
      },
    });
  });

  it("mark paid: a payment at the day's rate, paid until moves on one period, the reminder clears", async () => {
    const { client, licenseKey } = await create({
      name: "Riverstone Interiors",
      plan: { type: "subscription", currency: "USD", amount: 40, periodMonths: 1 },
    });
    await t.pool.query("UPDATE licences SET paid_until = '2026-09-26' WHERE client_id = $1", [client.id]);
    await admin.call("POST", `/api/clients/${client.id}/reminder`, { note: "UPI is fine." });
    expect(
      verifyLicence((await check(client.instanceId, licenseKey)).token!, KEYS, client.instanceId)?.notice,
    ).not.toBeNull();

    const r = await admin.call("POST", `/api/clients/${client.id}/paid`, { note: "Bank transfer" });
    expect(r.status).toBe(200);
    const d = await detail(client.id);
    // Late: from today, as the canvas's Extend does.
    expect(d.client.paidUntil).toBe("2026-10-29");
    expect(d.client.state).toBe("active");
    expect(d.notice).toBeNull();
    expect(d.payments[0]).toMatchObject({
      amount: 40,
      currency: "USD",
      rateToInr: 88.4,
      amountInr: 3536,
      paidUntil: "2026-10-29",
      note: "Bank transfer",
    });
    // The payment keeps its day's rate, whatever the rate does later.
    await t.pool.query("INSERT INTO fx_rates (day, currency, rate_to_inr) VALUES ('2026-10-05', 'USD', 90)");
    now = new Date("2026-10-05T09:00:00Z");
    expect(
      (await admin.call("GET", "/api/payments")).data.payments.find(
        (p: { clientId: string }) => p.clientId === client.id,
      ),
    ).toMatchObject({ rateToInr: 88.4, amountInr: 3536 });
    expect(
      verifyLicence((await check(client.instanceId, licenseKey)).token!, KEYS, client.instanceId)?.notice,
    ).toBeNull();
    expect((await events(client.id)).map((e) => e.kind)).toEqual([
      "created",
      "reminder_on",
      "paid",
      "reminder_off",
    ]);
  });

  it("paid early: paid until moves on from where it was, not from today", async () => {
    const { client } = await create({
      name: "Summit Fitness",
      plan: { type: "subscription", currency: "INR", amount: 41988, periodMonths: 12 },
    });
    await t.pool.query("UPDATE licences SET paid_until = '2026-10-20' WHERE client_id = $1", [client.id]);
    await admin.call("POST", `/api/clients/${client.id}/paid`, {});
    expect((await detail(client.id)).client.paidUntil).toBe("2027-10-20");
  });

  it("a trial's first payment makes it a subscription, paying from today", async () => {
    const { client } = await create({
      name: "Coral Bay Physio",
      plan: { type: "trial", currency: "INR", amount: 3999, periodMonths: 1 },
    });
    await admin.call("POST", `/api/clients/${client.id}/paid`, {});
    const d = await detail(client.id);
    expect(d.client).toMatchObject({ type: "subscription", paidUntil: "2026-10-29", monthlyInr: 3999 });
    expect((await events(client.id)).map((e) => e.kind)).toContain("converted");
  });

  it("a payment on a day with no fresh rate keeps the day its rate is from, not today", async () => {
    const { client } = await create({
      name: "Lantern Tutors",
      plan: { type: "subscription", currency: "USD", amount: 25, periodMonths: 1 },
    });
    now = new Date("2026-10-02T09:00:00Z"); // the rate fetch failed on the 30th, 1st and 2nd
    await admin.call("POST", `/api/clients/${client.id}/paid`, {});
    expect((await detail(client.id)).payments[0]).toMatchObject({
      rateToInr: 88.4,
      rateDay: "2026-09-29",
      amountInr: 2210,
    });
  });

  it("a payment in a currency with no known rate is kept, and says its rupees are unknown", async () => {
    const { client } = await create({
      name: "Kestrel Logistics",
      country: "SG",
      region: null,
      city: "Singapore",
      plan: { type: "subscription", currency: "SGD", amount: 120, periodMonths: 1 },
    });
    await admin.call("POST", `/api/clients/${client.id}/paid`, {});
    expect((await detail(client.id)).payments[0]).toMatchObject({
      currency: "SGD",
      amount: 120,
      rateToInr: null,
      amountInr: null,
    });
  });

  it("extend moves paid until by a month, three, or a year, with no payment", async () => {
    const { client } = await create({ name: "Saffron Events" });
    await admin.call("POST", `/api/clients/${client.id}/extend`, { months: 3 });
    expect((await detail(client.id)).client.paidUntil).toBe("2026-12-29");
    expect((await admin.call("POST", `/api/clients/${client.id}/extend`, { months: 2 })).status).toBe(400);
    expect((await detail(client.id)).payments).toEqual([]);
    expect((await events(client.id)).at(-1)).toEqual({
      kind: "extended",
      detail: { months: 3, until: "2026-12-29" },
    });
  });

  it("the reminder: on with a note (due the day it was paid until), and Stop", async () => {
    const { client } = await create({ name: "Bluebell Dental" });
    await t.pool.query("UPDATE licences SET paid_until = '2026-09-26' WHERE client_id = $1", [client.id]);
    expect(
      (await admin.call("POST", `/api/clients/${client.id}/reminder`, { note: "x".repeat(1001) })).status,
    ).toBe(400);
    expect(
      (await admin.call("POST", `/api/clients/${client.id}/reminder`, { note: "Same details as before." }))
        .status,
    ).toBe(200);
    expect((await detail(client.id)).notice).toMatchObject({
      note: "Same details as before.",
      dueDate: "2026-09-26",
    });
    // A second one replaces the note, never two open.
    await admin.call("POST", `/api/clients/${client.id}/reminder`, { note: "" });
    expect(
      (await t.pool.query("SELECT 1 FROM notices WHERE client_id = $1 AND cleared_at IS NULL", [client.id]))
        .rowCount,
    ).toBe(1);
    expect((await admin.call("DELETE", `/api/clients/${client.id}/reminder`)).status).toBe(200);
    expect((await detail(client.id)).notice).toBeNull();
  });

  it("rotate: a new key; the old one is decommissioned (spec 2026-10-15 §2.4), never unknown", async () => {
    const { client, licenseKey } = await create({ name: "Meridian Tutors" });
    const r = await admin.call("POST", `/api/clients/${client.id}/rotate`);
    expect(r.status).toBe(200);
    expect(r.data.licenseKey).not.toBe(licenseKey);
    // Never checked in, so no server holds the old key: it's refused as decommissioned at once.
    expect((await check(client.instanceId, licenseKey)).status).toBe(403);
    expect((await check(client.instanceId, r.data.licenseKey)).status).toBe(200);
    expect((await detail(client.id)).client.keyMasked).toMatch(new RegExp(`${r.data.licenseKey.slice(-4)}$`));
    expect((await events(client.id)).slice(-2).map((e) => e.kind)).toEqual([
      "key_rotated",
      "key_decommissioned",
    ]);
  });

  it("decommissioning later doesn't rewrite the history: the client left when it was suspended", async () => {
    const { client } = await create({ name: "Riverbend Studio" });
    await t.pool.query("UPDATE licences SET suspended_at = '2026-08-20T09:00:00Z' WHERE client_id = $1", [
      client.id,
    ]);
    const before = (await analyticsClients(t.pool)).find((c) => c.id === client.id)!;
    expect(before.endedAt?.toISOString()).toBe("2026-08-20T09:00:00.000Z");
    now = new Date("2026-09-05T09:00:00Z");
    await admin.call("POST", `/api/clients/${client.id}/decommission`);
    const after = (await analyticsClients(t.pool)).find((c) => c.id === client.id)!;
    expect(after.endedAt?.toISOString()).toBe("2026-08-20T09:00:00.000Z");
  });

  it("decommission: only once suspended; it's for good, its record stays, marked", async () => {
    const { client, licenseKey } = await create({ name: "Bluebell Dental" });
    const early = await admin.call("POST", `/api/clients/${client.id}/decommission`);
    expect(early.status).toBe(409);
    expect(early.data.error.message).toMatch(/Suspend it first/);
    await admin.call("POST", `/api/clients/${client.id}/suspend`);
    expect((await admin.call("POST", `/api/clients/${client.id}/decommission`)).status).toBe(200);
    const d = (await detail(client.id)).client;
    expect(d.decommissionedAt).toBeTruthy();
    // Resume can't bring it back, nor can anything else.
    expect((await admin.call("POST", `/api/clients/${client.id}/resume`)).status).toBe(409);
    expect((await admin.call("POST", `/api/clients/${client.id}/paid`, {})).status).toBe(409);
    expect(
      verifyLicence((await check(client.instanceId, licenseKey)).token!, KEYS, client.instanceId)?.state,
    ).toBe("suspended");
    expect((await events(client.id)).at(-1)?.kind).toBe("decommissioned");
  });

  it("suspend and resume: the instance hears it at its next check", async () => {
    const { client, licenseKey } = await create({ name: "Pinecrest Academy" });
    expect((await admin.call("POST", `/api/clients/${client.id}/suspend`)).status).toBe(200);
    expect(
      verifyLicence((await check(client.instanceId, licenseKey)).token!, KEYS, client.instanceId)?.state,
    ).toBe("suspended");
    expect((await detail(client.id)).client.state).toBe("suspended");
    await admin.call("POST", `/api/clients/${client.id}/resume`);
    expect(
      verifyLicence((await check(client.instanceId, licenseKey)).token!, KEYS, client.instanceId)?.state,
    ).toBe("active");
    expect((await events(client.id)).map((e) => e.kind)).toEqual(
      expect.arrayContaining(["suspended", "resumed"]),
    );
  });

  it("edits a client's details; an unknown client is 404", async () => {
    const { client } = await create({ name: "Fjord Analytics", country: "DE", region: null, city: "Berlin" });
    expect(
      (await admin.call("PATCH", `/api/clients/${client.id}`, { city: "Hamburg", source: "website" })).status,
    ).toBe(200);
    expect((await detail(client.id)).client).toMatchObject({ city: "Hamburg", source: "website" });
    expect((await admin.call("GET", "/api/clients/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await admin.call("GET", "/api/clients/not-a-uuid")).status).toBe(404);
  });

  it("the list: every client with its state, price in its own currency and in rupees, and its last check-in", async () => {
    const { client, licenseKey } = await create({
      name: "Brightpath Studio",
      plan: { type: "subscription", currency: "INR", amount: 59988, periodMonths: 12 },
    });
    await check(client.instanceId, licenseKey);
    const r = await admin.call("GET", "/api/clients");
    const row = r.data.clients.find((c: { id: string }) => c.id === client.id);
    expect(row).toMatchObject({
      name: "Brightpath Studio",
      state: "active",
      price: { currency: "INR", amount: 59988, periodMonths: 12 },
      monthlyInr: 4999,
      lastCheckIn: { at: now.toISOString(), version: "1.4.2" },
    });
    expect(r.data.rates).toMatchObject({ day: "2026-09-29" });
  });
});

describe("keys you can copy again, and where they're active (spec 2026-10-15 §2.3, §3.2)", () => {
  const q = (sql: string, params: unknown[]) => t.pool.query(sql, params);

  it("a new licence's key can be copied again later; nobody has entered it yet", async () => {
    const { client, licenseKey } = await create();
    const shown = await admin.call("GET", `/api/clients/${client.id}/key`);
    expect(shown.status).toBe(200);
    expect(shown.data).toEqual({ licenseKey });
    const d = await detail(client.id);
    expect(d.client.keyShowable).toBe(true);
    expect(d.client.activation).toEqual({ status: "not_activated", ip: null, at: null, installId: null });
  });

  it("active on a server, released, or decommissioned: the client says which", async () => {
    const { client } = await create();
    const install = "0190e0c0-0000-7000-8000-0000000000b1";
    await q(
      "UPDATE licences SET install_id = $2, activated_at = $3, activated_ip = '203.0.113.10' WHERE client_id = $1",
      [client.id, install, now],
    );
    expect((await detail(client.id)).client.activation).toEqual({
      status: "active",
      ip: "203.0.113.10",
      at: now.toISOString(),
      installId: install,
    });
    await q(
      "UPDATE licences SET install_id = NULL, activated_at = NULL, activated_ip = NULL, released_at = $2 WHERE client_id = $1",
      [client.id, now],
    );
    expect((await detail(client.id)).client.activation.status).toBe("released");
    await q("UPDATE licences SET key_dead_at = $2 WHERE client_id = $1", [client.id, now]);
    expect((await detail(client.id)).client.activation.status).toBe("decommissioned");
  });

  it("a licence made before keys were kept can't be shown; Rotate is the way to one that can", async () => {
    const { client } = await create();
    await q("UPDATE licences SET key_enc = NULL WHERE client_id = $1", [client.id]);
    const r = await admin.call("GET", `/api/clients/${client.id}/key`);
    expect(r.status).toBe(404);
    expect(r.data.error.code).toBe("NOT_SHOWABLE");
    expect((await detail(client.id)).client.keyShowable).toBe(false);
  });

  it("two licences can never share a key", async () => {
    const a = await create();
    const b = await create({ name: "Northwind Interiors" });
    await expect(
      t.pool.query(
        "UPDATE licences SET key_hash = (SELECT key_hash FROM licences WHERE client_id = $1) WHERE client_id = $2",
        [a.client.id, b.client.id],
      ),
    ).rejects.toThrow(/licences_key_hash/);
  });
});

describe("the key's actions (spec 2026-10-15 §2.4, §3.2)", () => {
  const INSTALL = "0190e0c0-0000-7000-8000-0000000000c1"; // the install check() sends
  const lic = async (id: string) =>
    (
      await t.pool.query<{ install_id: string | null; released_at: Date | null; key_dead_at: Date | null }>(
        "SELECT install_id, released_at, key_dead_at FROM licences WHERE client_id = $1",
        [id],
      )
    ).rows[0]!;
  const retired = async (id: string) =>
    (
      await t.pool.query<{ reason: string; install_id: string | null; key_last4: string }>(
        "SELECT reason, install_id, key_last4 FROM retired_keys WHERE client_id = $1 ORDER BY retired_at, key_last4",
        [id],
      )
    ).rows;

  it("rotate keeps the server: the new key works there, the old one goes to the retired keys with it", async () => {
    const { client, licenseKey } = await create({ name: "Lakeside Dental" });
    await check(client.instanceId, licenseKey); // binds
    const r = await admin.call("POST", `/api/clients/${client.id}/rotate`);
    expect((await lic(client.id)).install_id).toBe(INSTALL);
    expect(await retired(client.id)).toEqual([
      { reason: "rotated", install_id: INSTALL, key_last4: licenseKey.slice(-4) },
    ]);
    // The new key can be shown again; the old server keeps going on its old key for now.
    expect((await admin.call("GET", `/api/clients/${client.id}/key`)).data.licenseKey).toBe(
      r.data.licenseKey,
    );
    expect((await check(client.instanceId, licenseKey)).status).toBe(200);
  });

  it("release frees the key for a new server; a key nobody holds can't be released", async () => {
    const { client, licenseKey } = await create({ name: "Hilltop Fitness" });
    expect((await admin.call("POST", `/api/clients/${client.id}/release`)).data.error.code).toBe(
      "NOT_ACTIVE",
    );
    await check(client.instanceId, licenseKey);
    const r = await admin.call("POST", `/api/clients/${client.id}/release`);
    expect(r.status).toBe(200);
    expect(r.data.client.activation.status).toBe("released");
    expect(await lic(client.id)).toMatchObject({ install_id: null, released_at: now });
    expect((await events(client.id)).at(-1)).toEqual({ kind: "key_released", detail: { ip: "203.0.113.9" } });
  });

  it("decommission (held on the card): the key is dead for good, the client has no live key, twice is refused", async () => {
    const { client, licenseKey } = await create({ name: "Cedar Physio" });
    await check(client.instanceId, licenseKey);
    const r = await admin.call("POST", `/api/clients/${client.id}/key/decommission`);
    expect(r.status).toBe(200);
    expect(r.data.client.activation.status).toBe("decommissioned");
    expect(r.data.client.keyShowable).toBe(false);
    expect(await retired(client.id)).toEqual([
      { reason: "decommissioned", install_id: INSTALL, key_last4: licenseKey.slice(-4) },
    ]);
    expect((await admin.call("GET", `/api/clients/${client.id}/key`)).status).toBe(404);
    expect((await admin.call("POST", `/api/clients/${client.id}/key/decommission`)).status).toBe(409);
    expect((await events(client.id)).at(-1)).toEqual({
      kind: "key_decommissioned",
      detail: { last4: licenseKey.slice(-4), via: "hold" },
    });
  });

  it("issue a new key: only after a decommission; it's fresh, unbound, and can be shown", async () => {
    const { client } = await create({ name: "Maple Learning" });
    expect((await admin.call("POST", `/api/clients/${client.id}/key/issue`)).status).toBe(409);
    await admin.call("POST", `/api/clients/${client.id}/key/decommission`);
    const r = await admin.call("POST", `/api/clients/${client.id}/key/issue`);
    expect(r.status).toBe(200);
    expect(r.data.licenseKey).toMatch(/^LUME(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    expect(r.data.client.activation.status).toBe("not_activated");
    expect(await lic(client.id)).toMatchObject({ install_id: null, key_dead_at: null, released_at: null });
    expect((await admin.call("GET", `/api/clients/${client.id}/key`)).data.licenseKey).toBe(
      r.data.licenseKey,
    );
    expect((await check(client.instanceId, r.data.licenseKey)).status).toBe(200);
    expect((await events(client.id)).at(-1)?.kind).toBe("key_created");
  });

  it("the bell hears when the key is tried on another server", async () => {
    const { client, licenseKey } = await create({ name: "Pinecrest Clinic" });
    await check(client.instanceId, licenseKey); // binds to the test install
    const { handleActivate } = await import("./activate");
    const { activateBody } = await import("@lume/core");
    await handleActivate(
      new Request("https://licence.test/v1/activate", {
        method: "POST",
        headers: { "x-real-ip": "198.51.100.7" },
        body: JSON.stringify(
          activateBody({
            licenseKey,
            installId: "0190e0c0-0000-7000-8000-0000000000d4",
            appVersion: "1.5.0",
            now,
          }),
        ),
      }),
      ctx,
    );
    const { alerts } = (await admin.call("GET", "/api/alerts")).data as {
      alerts: { id: string; body: string }[];
    };
    expect(alerts.find((a) => a.id === `tried:${client.id}`)?.body).toMatch(/^198\.51\.100\.7 tried it on/);
  });

  it("rotate after a decommission is refused: issue a new key instead", async () => {
    const { client } = await create({ name: "Birch Wellness" });
    await admin.call("POST", `/api/clients/${client.id}/key/decommission`);
    expect((await admin.call("POST", `/api/clients/${client.id}/rotate`)).data.error.code).toBe("KEY_DEAD");
  });
});

describe("settings (spec §4.4)", () => {
  it("list price, latest version and billing contact; a bad contact link is refused", async () => {
    expect(
      (
        await admin.call("PATCH", "/api/settings", {
          listPriceInr: 3999,
          latestVersion: "1.4.2",
          billingContact: "mailto:billing@lume.test",
        })
      ).status,
    ).toBe(200);
    expect((await admin.call("GET", "/api/settings")).data).toMatchObject({
      listPriceInr: 3999,
      latestVersion: "1.4.2",
      billingContact: "mailto:billing@lume.test",
      email: "owner@lume.test",
    });
    expect(
      (await admin.call("PATCH", "/api/settings", { billingContact: "javascript:alert(1)" })).status,
    ).toBe(400);
    expect((await admin.call("PATCH", "/api/settings", { latestVersion: "not a version" })).status).toBe(400);
  });
});
