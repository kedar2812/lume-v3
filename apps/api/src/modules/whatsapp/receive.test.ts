import { generateKeyPairSync } from "node:crypto";
import {
  newId,
  rawPublicKey,
  relaySign,
  signLicence,
  type LicencePayload,
  type LicenceStateName,
} from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { echo, inbound, PHONE_NUMBER_ID } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { tokenContext } from "./service";

/** WhatsApp deliveries arriving at a client's LUME from the relay (spec 2026-10-18 §3.3; plan W1 Task 5). */
const RELAY_TOKEN = "r".repeat(40);
const server = generateKeyPairSync("ed25519");
let h: Harness;
let state: LicenceStateName = "active";
let admin: { id: string; email: string; password: string };

const licenceToken = () =>
  signLicence(
    {
      v: 1,
      kid: "t1",
      instanceId: "LUME-TEST-WA-IN",
      state,
      licenseType: "subscription",
      issuedAt: h.clock.now.toISOString(),
      validUntil: new Date(h.clock.now.getTime() + 8 * 86_400_000).toISOString(),
      paidUntil: "2027-12-31",
      trialEndsAt: null,
      reason: state === "active" ? "paid" : "unpaid",
      notice: null,
    } satisfies LicencePayload,
    server.privateKey,
  );
const post = (body: unknown, o: { sig?: string; ts?: string; raw?: Buffer } = {}) => {
  const raw = o.raw ?? Buffer.from(JSON.stringify(body));
  const ts = o.ts ?? String(Math.floor(h.clock.now.getTime() / 1000));
  return h.app.inject({
    method: "POST",
    url: "/whatsapp/in",
    headers: {
      "content-type": "application/json",
      "x-lume-timestamp": ts,
      "x-lume-signature": o.sig ?? relaySign(RELAY_TOKEN, ts, raw),
    },
    payload: raw,
  });
};
const events = async () =>
  (
    await h.ownerPool.query<{ wamid: string; kind: string; status: string; has: boolean }>(
      "SELECT wamid, kind, status, event_enc IS NOT NULL AS has FROM whatsapp_events ORDER BY id",
    )
  ).rows;

beforeAll(async () => {
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: "http://127.0.0.1:9", version: "v23.0" },
    licence: {
      mode: "enforce",
      instanceId: "LUME-TEST-WA-IN",
      licenseKey: "LUME-KEY-SECRET-WA-IN",
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.7.0",
      fetch: (async () =>
        new Response(JSON.stringify({ token: licenceToken() }), { status: 200 })) as typeof fetch,
    },
  });
  admin = await h.seedUser({ owner: true, totp: true });
  const id = newId();
  await h.ownerPool.query(
    `INSERT INTO whatsapp_numbers (id, phone_number_id, waba_id, display_phone, run_as, status, token_enc)
     VALUES ($1, $2, '102290129340398', '+91 90000 00001', $3, 'active', $4)`,
    [id, PHONE_NUMBER_ID, admin.id, h.keyring.encrypt("EAAG-token", tokenContext(id))],
  );
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.ownerPool.query("TRUNCATE whatsapp_events");
  await h.ownerPool.query(
    `UPDATE settings SET integrations = jsonb_set(integrations, '{whatsapp}', '{"enabled": true}'::jsonb) WHERE id = 1`,
  );
  h.whatsappQueued.length = 0;
  state = "active";
  await check();
});
const check = async () => (await h.signIn(admin)).inject({ method: "POST", url: "/api/v1/licence/check" });

describe("the intake", () => {
  it("a delivery signed by the relay is kept once, encrypted, and queued", async () => {
    const r = await post(inbound());
    expect(r.statusCode).toBe(200);
    expect(await events()).toEqual([{ wamid: "wamid.IN1", kind: "received", status: "queued", has: true }]);
    expect(h.whatsappQueued).toHaveLength(1);
    const raw = (await h.ownerPool.query("SELECT event_enc FROM whatsapp_events")).rows[0]
      .event_enc as Buffer;
    expect(raw.toString()).not.toContain("Saturday");
  });

  it("Review Focus 1: Meta's retry of the same message is one event, queued once", async () => {
    await post(inbound());
    // Meta's retry comes later: the relay signs it afresh.
    h.clock.advance(30_000);
    const again = await post(inbound());
    expect(again.statusCode).toBe(200);
    expect(await events()).toHaveLength(1);
    expect(h.whatsappQueued).toHaveLength(1);
  });

  it("not the relay's signature, none, or a stale one: 401 and nothing kept", async () => {
    expect((await post(inbound(), { sig: "sha256=00" })).statusCode).toBe(401);
    expect((await post(inbound(), { sig: "" })).statusCode).toBe(401);
    const old = String(Math.floor(h.clock.now.getTime() / 1000) - 301);
    expect((await post(inbound(), { ts: old })).statusCode).toBe(401);
    expect(await events()).toEqual([]);
  });

  it("Review Focus 3: the same signed forward sent twice is refused the second time", async () => {
    const raw = Buffer.from(JSON.stringify(echo()));
    const ts = String(Math.floor(h.clock.now.getTime() / 1000));
    const sig = relaySign(RELAY_TOKEN, ts, raw);
    expect((await post(null, { raw, ts, sig })).statusCode).toBe(200);
    expect((await post(null, { raw, ts, sig })).statusCode).toBe(401);
  });

  it("a number LUME doesn't have, or WhatsApp switched off: 200 (Meta mustn't keep trying) and nothing kept", async () => {
    const stranger = JSON.parse(JSON.stringify(inbound()).replaceAll(PHONE_NUMBER_ID, "999999999999"));
    expect((await post(stranger)).statusCode).toBe(200);
    await h.ownerPool.query(`UPDATE settings SET integrations = integrations - 'whatsapp' WHERE id = 1`);
    expect((await post(inbound({ id: "wamid.OFF" }))).statusCode).toBe(200);
    expect(await events()).toEqual([]);
  });

  it("a read-only LUME takes nothing new, and still says 200", async () => {
    state = "read_only";
    await check();
    expect((await post(inbound({ id: "wamid.RO" }))).statusCode).toBe(200);
    expect(await events()).toEqual([]);
  });

  it("several messages in one delivery are each kept and queued", async () => {
    const two = inbound();
    const v = two.entry[0]!.changes[0]!.value as unknown as { messages: unknown[] };
    v.messages.push({ ...(v.messages[0] as object), id: "wamid.IN2" });
    expect((await post(two)).statusCode).toBe(200);
    expect((await events()).map((e) => e.wamid)).toEqual(["wamid.IN1", "wamid.IN2"]);
    expect(h.whatsappQueued).toHaveLength(2);
  });

  it("a big delivery (past chats come in chunks of up to a few MB) gets in", async () => {
    const big = inbound({ id: "wamid.BIG", type: "text", text: { body: "x".repeat(1024 * 1024) } });
    expect((await post(big)).statusCode).toBe(200);
    expect((await events()).map((e) => e.wamid)).toEqual(["wamid.BIG"]);
  });
});
