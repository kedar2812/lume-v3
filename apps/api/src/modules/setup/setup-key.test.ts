import { generateKeyPairSync } from "node:crypto";
import { rawPublicKey, signLicence } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

/**
 * Setup's first step on a client's install (spec 2026-10-15 §1.1): the product key. Approval hands the setup token
 * to the browser that proved the key, and nothing else does.
 */
const server = generateKeyPairSync("ed25519");
const KEY = "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K";
const INSTANCE = "LUME-H4RB-8C2L";
const D = 86_400_000;

let h: Harness;
let answer: () => Response;
let calls = 0;
const fakeFetch = (async () => {
  calls++;
  return answer();
}) as unknown as typeof fetch;
const approved = () =>
  new Response(
    JSON.stringify({
      instanceId: INSTANCE,
      token: signLicence(
        {
          v: 1,
          kid: "t1",
          instanceId: INSTANCE,
          state: "active",
          licenseType: "subscription",
          issuedAt: h.clock.now.toISOString(),
          validUntil: new Date(h.clock.now.getTime() + 8 * D).toISOString(),
          paidUntil: "2026-11-15",
          trialEndsAt: null,
          reason: "paid",
          notice: null,
        },
        server.privateKey,
      ),
    }),
  );

const enter = async (key: string, ip = "203.0.113.20") =>
  h.app.inject({
    method: "POST",
    url: "/api/v1/setup/key",
    payload: { key },
    remoteAddress: ip,
    ...(await h.csrf()),
  });

beforeAll(async () => {
  h = await createHarness({
    noSettings: true,
    licence: {
      mode: "enforce",
      instanceId: null,
      licenseKey: null,
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.5.0",
      fetch: fakeFetch,
    },
  });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.app.licence.idle();
  calls = 0;
});

describe("setup asks for the product key (spec 2026-10-15 §1.1)", () => {
  it("says a key is needed", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/v1/setup/status" })).json()).toEqual({
      needsSetup: true,
      needsKey: true,
    });
  });

  it("a refused key gets its reason, and no token", async () => {
    answer = () => new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 });
    const r = await enter(KEY);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: "KEY_REFUSED", details: { reason: "not_recognised" } });
    expect(r.body).not.toContain(h.setupToken);
  });

  it("the licence server down: nothing stored, no token; the same key works once it's back", async () => {
    answer = () => {
      throw new TypeError("fetch failed");
    };
    const down = await enter(KEY);
    expect(down.json().error.details).toEqual({ reason: "unreachable" });
    const s = (
      await h.ownerPool.query<{ instance_id: string | null }>("SELECT instance_id FROM licence_state")
    ).rows[0]!;
    expect(s.instance_id).toBeNull();

    answer = approved;
    const ok = await enter("lume 7k2p q9xd 4mrt h8vc 7q2k");
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      token: h.setupToken,
      licence: { licenseType: "subscription", paidUntil: "2026-11-15", trialEndsAt: null },
    });
    // The token it handed over is the one setup takes.
    const totp = await h.app.inject({
      method: "POST",
      url: "/api/v1/setup/totp",
      payload: { token: ok.json().token },
      ...(await h.csrf()),
    });
    expect(totp.statusCode).toBe(200);
  });

  it("a key that isn't five groups of four is refused without asking the licence server", async () => {
    const r = await enter("LUME-7K2P");
    expect(r.json().error.details).toEqual({ reason: "format" });
    expect(calls).toBe(0);
  });

  it("ten tries an hour from one address, then too many", async () => {
    answer = () => new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 });
    for (let i = 0; i < 10; i++) expect((await enter(KEY, "198.51.100.20")).statusCode).toBe(422);
    const r = await enter(KEY, "198.51.100.20");
    expect(r.statusCode).toBe(429);
    expect((await enter(KEY, "198.51.100.21")).statusCode).toBe(422);
  });

  it("once someone has set LUME up, the key step is closed", async () => {
    await h.seedUser({ owner: true });
    answer = approved;
    const r = await enter(KEY, "192.0.2.30");
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("SETUP_DONE");
  });
});
