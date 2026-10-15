import { generateKeyPairSync } from "node:crypto";
import { rawPublicKey, signLicence, type LicencePayload } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../test/harness";

/**
 * A client's install with no key in its .env (spec 2026-10-15 §1.2): it makes its own install id, activates the
 * key the owner gave, keeps it sealed, and checks in with it from then on.
 */
const server = generateKeyPairSync("ed25519");
const KEY = "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K";
const INSTANCE = "LUME-H4RB-8C2L";
const D = 86_400_000;

let h: Harness;
type Answer = () => Promise<Response> | Response;
let answer: Answer;
const sent: { url: string; body: Record<string, unknown> }[] = [];
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
  return answer();
}) as typeof fetch;

const token = (over: Partial<LicencePayload> = {}) =>
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
      ...over,
    },
    server.privateKey,
  );
const approved = (): Answer => () =>
  new Response(JSON.stringify({ instanceId: INSTANCE, token: token() }), { status: 200 });
const refused =
  (status: number, code: string): Answer =>
  () =>
    new Response(JSON.stringify({ error: { code, message: "no" } }), { status });
const stored = async () =>
  (
    await h.ownerPool.query<{
      install_id: string;
      instance_id: string | null;
      license_key_enc: Buffer | null;
      token: string | null;
    }>("SELECT install_id, instance_id, license_key_enc, token FROM licence_state WHERE id = 1")
  ).rows[0]!;

beforeAll(async () => {
  h = await createHarness({
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
  // An activation starts the first check in the background: let it land before this test starts afresh.
  await h.app.licence.idle();
  sent.length = 0;
  await h.ownerPool.query(
    "UPDATE licence_state SET token = NULL, instance_id = NULL, license_key_enc = NULL, activated_at = NULL, last_success_at = NULL, last_error = NULL",
  );
  await h.app.licence.refresh();
});

describe("this install's key (spec 2026-10-15 §1.2)", () => {
  it("has its own install id from the start, and needs a key", async () => {
    expect((await stored()).install_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(h.app.licence.needsKey()).toBe(true);
    expect(h.app.licence.keySource()).toBeNull();
  });

  it("activates a key typed loosely: sends only the activation, keeps the key sealed, and is active", async () => {
    answer = approved();
    const r = await h.app.licence.activate(" lume 7k2p q9xd 4mrt h8vc 7q2k ");
    expect(r.ok).toBe(true);
    expect(sent[0]!.url).toBe("https://licence.test/v1/activate");
    expect(sent[0]!.body).toEqual({
      licenseKey: KEY,
      installId: (await stored()).install_id,
      appVersion: "1.5.0",
      serverTime: h.clock.now.toISOString(),
    });
    const s = await stored();
    expect(s.instance_id).toBe(INSTANCE);
    expect(s.license_key_enc).not.toBeNull();
    expect(s.license_key_enc!.toString("latin1")).not.toContain("7K2P");
    expect(h.app.licence.view().state).toBe("active");
    expect(h.app.licence.keySource()).toBe("stored");
    expect(h.app.licence.keyLast4()).toBe("7Q2K");
    expect(h.app.licence.info().instanceId).toBe(INSTANCE);
  });

  it.each([
    ["not_recognised", refused(401, "UNAUTHORIZED")],
    ["paused", refused(403, "LICENCE_PAUSED")],
    ["decommissioned", refused(403, "KEY_DECOMMISSIONED")],
    ["in_use", refused(409, "KEY_IN_USE")],
    ["too_many", refused(429, "RATE_LIMITED")],
    ["unreachable", refused(503, "DOWN")],
    [
      "unreachable",
      (() => {
        throw new TypeError("fetch failed");
      }) as Answer,
    ],
    // Signed by a stranger: never trusted.
    [
      "unreachable",
      (() =>
        new Response(
          JSON.stringify({
            instanceId: INSTANCE,
            token: signLicence(
              JSON.parse(JSON.stringify({})) as LicencePayload,
              generateKeyPairSync("ed25519").privateKey,
            ),
          }),
        )) as Answer,
    ],
  ])("an answer is told as %s, and nothing is stored", async (reason, a) => {
    answer = a;
    const r = await h.app.licence.activate(KEY);
    expect(r).toEqual({ ok: false, reason });
    const s = await stored();
    expect([s.instance_id, s.license_key_enc, s.token]).toEqual([null, null, null]);
    expect(h.app.licence.keySource()).toBeNull();
  });

  it("a key that isn't five groups of four never leaves the server", async () => {
    expect(await h.app.licence.activate("LUME-7K2P-Q9XD")).toEqual({ ok: false, reason: "format" });
    expect(sent).toHaveLength(0);
  });

  it("checks in with its stored key, its instance id and its install id", async () => {
    answer = approved();
    await h.app.licence.activate(KEY);
    sent.length = 0;
    answer = () => new Response(JSON.stringify({ token: token() }), { status: 200 });
    await h.app.licence.check();
    expect(sent[0]!.url).toBe("https://licence.test/v1/check");
    expect(sent[0]!.body).toMatchObject({
      instanceId: INSTANCE,
      licenseKey: KEY,
      installId: (await stored()).install_id,
    });
  });

  it("a key in use elsewhere at a check is said in words", async () => {
    answer = approved();
    await h.app.licence.activate(KEY);
    answer = refused(409, "KEY_IN_USE");
    await h.app.licence.check();
    expect(h.app.licence.lastError()).toBe("This key is in use on another server");
    answer = refused(403, "KEY_DECOMMISSIONED");
    await h.app.licence.check();
    expect(h.app.licence.lastError()).toBe("This key has been decommissioned");
  });
});
