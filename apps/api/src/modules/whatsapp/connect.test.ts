import { generateKeyPairSync } from "node:crypto";
import {
  ALL_GRANTS,
  instanceIdOf,
  rawPublicKey,
  seal,
  sign,
  signLicence,
  verify,
  type Handoff,
  type LicencePayload,
  type PlanClaim,
} from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";

/** Connecting a WhatsApp number, and whose it is (spec 2026-10-18 §3.2; plan W1 Task 4). */
const RELAY_TOKEN = "r".repeat(40);
const server = generateKeyPairSync("ed25519");
const all = {
  googleSheets: true,
  webhooks: true,
  googleCalendar: true,
  calendly: true,
  ai: true,
  whatsapp: true,
};
let h: Harness;
let meta: MetaFake;
let admin: { id: string; email: string; password: string };
let rep: { id: string; email: string; password: string };
let plan: PlanClaim | undefined;

const token = () =>
  signLicence(
    {
      v: 1,
      kid: "t1",
      instanceId: "LUME-TEST-WA",
      state: "active",
      licenseType: "subscription",
      issuedAt: h.clock.now.toISOString(),
      validUntil: new Date(h.clock.now.getTime() + 8 * 86_400_000).toISOString(),
      paidUntil: "2027-12-31",
      trialEndsAt: null,
      reason: "paid",
      notice: null,
      ...(plan ? { plan } : {}),
    } satisfies LicencePayload,
    server.privateKey,
  );
const as = (u: typeof admin): Promise<AuthedClient> => h.signIn(u);
const withPlan = async (p: PlanClaim | undefined) => {
  plan = p;
  await (await as(admin)).inject({ method: "POST", url: "/api/v1/licence/check" });
};
const switchTo = async (enabled: boolean, u = admin) =>
  (await as(u)).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { enabled } });
/** What the relay hands back after Embedded Signup, for the nonce in a start link. */
function handBack(
  nonce: string,
  over: Partial<NonNullable<Handoff["whatsapp"]>> = {},
  exp = Date.now() + 60_000,
) {
  const h: Handoff = {
    nonce,
    kind: "whatsapp",
    whatsapp: {
      token: "EAAG-business-token",
      wabaId: "102290129340398",
      phoneNumberId: "106540352242922",
      display: "+91 90000 00001",
      name: "Harbour Studio",
      history: true,
      ...over,
    },
    exp,
  };
  const p = seal(RELAY_TOKEN, h);
  return { p, s: sign(RELAY_TOKEN, p) };
}
async function startNonce(u = admin): Promise<string> {
  const r = await (await as(u)).inject({ method: "POST", url: "/api/v1/whatsapp/connect" });
  expect(r.statusCode).toBe(200);
  const url = new URL(r.json().url as string);
  expect(url.origin + url.pathname).toBe("https://relay.test/wa/start");
  expect(url.searchParams.get("i")).toBe(instanceIdOf(RELAY_TOKEN));
  const n = url.searchParams.get("n")!;
  expect(verify(RELAY_TOKEN, `${n}.whatsapp`, url.searchParams.get("s")!)).toBe(true);
  return n;
}
const complete = async (body: { p: string; s: string }, u = admin) =>
  (await as(u)).inject({ method: "POST", url: "/api/v1/whatsapp/connect/complete", payload: body });

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
    licence: {
      mode: "enforce",
      instanceId: "LUME-TEST-WA",
      licenseKey: "LUME-KEY-SECRET-WA",
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.7.0",
      fetch: (async () => new Response(JSON.stringify({ token: token() }), { status: 200 })) as typeof fetch,
    },
  });
  h.setRelayUrl("https://relay.test");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query(`UPDATE settings SET integrations = integrations - 'whatsapp' WHERE id = 1`);
  await withPlan({ places: null, modules: all });
  meta.calls.length = 0;
});

describe("the switch", () => {
  it("off by default; an admin switches it on", async () => {
    const before = await (await as(admin)).inject({ method: "GET", url: "/api/v1/integrations" });
    expect(before.json().whatsapp).toEqual({ enabled: false, available: true, inPlan: true });
    const r = await switchTo(true);
    expect(r.statusCode).toBe(200);
    expect(r.json().whatsapp.enabled).toBe(true);
  });

  it("not while the plan leaves WhatsApp out", async () => {
    await withPlan({ places: null, modules: { ...all, whatsapp: false } });
    const r = await switchTo(true);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("PLAN_MODULE");
  });

  it("a rep can't switch it, start a connection, or list numbers", async () => {
    expect((await switchTo(true, rep)).statusCode).toBe(403);
    expect(
      (await (await as(rep)).inject({ method: "POST", url: "/api/v1/whatsapp/connect" })).statusCode,
    ).toBe(403);
    expect(
      (await (await as(rep)).inject({ method: "GET", url: "/api/v1/whatsapp/numbers" })).statusCode,
    ).toBe(403);
  });

  it("connecting waits for the switch", async () => {
    const r = await (await as(admin)).inject({ method: "POST", url: "/api/v1/whatsapp/connect" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("WHATSAPP_OFF");
  });
});

describe("connecting a number", () => {
  beforeEach(() => switchTo(true));

  it("the hand-back stores the number with its token encrypted, never shown; audited", async () => {
    const r = await complete(handBack(await startNonce()));
    expect(r.statusCode).toBe(200);
    expect(r.json().numbers).toEqual([
      {
        id: expect.any(String),
        display: "+91 90000 00001",
        name: "Harbour Studio",
        owner: null,
        status: "active",
        problem: null,
        historyShared: true,
        connectedAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(r.json())).not.toContain("EAAG");
    const row = (await h.ownerPool.query("SELECT token_enc, run_as FROM whatsapp_numbers")).rows[0];
    expect(row.token_enc.toString()).not.toContain("EAAG");
    expect(row.run_as).toBe(admin.id);
    const audit = await h.ownerPool.query("SELECT action FROM audit_log WHERE action LIKE 'whatsapp.%'");
    expect(audit.rows.map((x) => x.action)).toContain("whatsapp.connected");
  });

  it("a tampered, expired or reused hand-back is refused", async () => {
    const n = await startNonce();
    const good = handBack(n);
    expect((await complete({ p: good.p, s: "x" })).statusCode).toBe(400);
    expect((await complete(handBack(n, {}, Date.now() - 1))).json().error.code).toBe("CONNECT_EXPIRED");
    expect((await complete(good)).statusCode).toBe(200);
    expect((await complete(good)).statusCode).toBe(404);
  });

  it("connecting the same number again updates it (a new token), never a second row", async () => {
    await complete(handBack(await startNonce()));
    await complete(handBack(await startNonce(), { token: "EAAG-new-token", name: "Harbour Studio Hyd" }));
    const rows = (await h.ownerPool.query("SELECT verified_name FROM whatsapp_numbers")).rows;
    expect(rows).toEqual([{ verified_name: "Harbour Studio Hyd" }]);
  });
});

describe("whose number it is, and disconnecting", () => {
  let id: string;
  beforeEach(async () => {
    await switchTo(true);
    id = (await complete(handBack(await startNonce()))).json().numbers[0].id as string;
  });

  it("a person's, or the business's", async () => {
    const mine = await (
      await as(admin)
    ).inject({ method: "PATCH", url: `/api/v1/whatsapp/numbers/${id}`, payload: { ownerId: rep.id } });
    expect(mine.json().numbers[0].owner).toEqual({ id: rep.id, name: expect.any(String) });
    const biz = await (
      await as(admin)
    ).inject({ method: "PATCH", url: `/api/v1/whatsapp/numbers/${id}`, payload: { ownerId: null } });
    expect(biz.json().numbers[0].owner).toBeNull();
    const nobody = await (
      await as(admin)
    ).inject({
      method: "PATCH",
      url: `/api/v1/whatsapp/numbers/${id}`,
      payload: { ownerId: "0190e0c0-0000-7000-8000-00000000dead" },
    });
    expect(nobody.statusCode).toBe(400);
  });

  it("disconnecting stops Meta's deliveries to LUME and drops the token", async () => {
    const r = await (await as(admin)).inject({ method: "DELETE", url: `/api/v1/whatsapp/numbers/${id}` });
    expect(r.statusCode).toBe(200);
    expect(r.json().numbers).toEqual([]);
    expect(
      meta.calls.some((c) => c.method === "DELETE" && c.path.endsWith("/102290129340398/subscribed_apps")),
    ).toBe(true);
    const row = (await h.ownerPool.query("SELECT status, token_enc FROM whatsapp_numbers")).rows[0];
    expect(row).toEqual({ status: "disconnected", token_enc: null });
  });

  it("Meta refusing the unsubscribe (a revoked token) still disconnects", async () => {
    meta.revoked.add("EAAG-business-token");
    const r = await (await as(admin)).inject({ method: "DELETE", url: `/api/v1/whatsapp/numbers/${id}` });
    meta.revoked.clear();
    expect(r.statusCode).toBe(200);
    expect((await h.ownerPool.query("SELECT status FROM whatsapp_numbers")).rows[0].status).toBe(
      "disconnected",
    );
  });
});
