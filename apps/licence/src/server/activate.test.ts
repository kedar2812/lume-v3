import { activateBody, rawPublicKey, verifyLicence } from "@lume/core";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleActivate } from "./activate";
import type { Ctx } from "./context";
import { licenceDb, seedClient, TEST_PAIR, testCtx, type LicenceTestDb } from "./testing";

const KEYS = { t1: rawPublicKey(TEST_PAIR.publicKey) };
const A = "0190e0c0-0000-7000-8000-0000000000a1";
const B = "0190e0c0-0000-7000-8000-0000000000b2";
let t: LicenceTestDb;
let now = new Date("2026-10-15T09:00:00Z");
let ctx: Ctx;

const post = (data: unknown, ip = "203.0.113.9") =>
  handleActivate(
    new Request("http://licence.test/v1/activate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: typeof data === "string" ? data : JSON.stringify(data),
    }),
    ctx,
  );
const activate = (licenseKey: string, installId = A, ip?: string) =>
  post(activateBody({ licenseKey, installId, appVersion: "1.5.0", now }), ip);
const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  (await t.pool.query<T>(sql, params)).rows;
const kinds = async (clientId: string) =>
  (await q<{ kind: string }>("SELECT kind FROM events WHERE client_id = $1 ORDER BY id", [clientId])).map(
    (e) => e.kind,
  );
const codeOf = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

beforeAll(async () => {
  t = await licenceDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  now = new Date("2026-10-15T09:00:00Z");
  ctx = testCtx(t.pool, () => now);
});

describe("POST /v1/activate (spec 2026-10-15 §2.1)", () => {
  it("binds a new licence to the first install, however the key was typed, and answers a token it verifies", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-12-01" });
    const r = await activate(c.licenseKey.toLowerCase().replaceAll("-", " "));
    expect(r.status).toBe(200);
    const { instanceId, token } = (await r.json()) as { instanceId: string; token: string };
    expect(instanceId).toBe(c.instanceId);
    const p = verifyLicence(token, KEYS, c.instanceId);
    expect(p?.state).toBe("active");
    expect(p?.paidUntil).toBe("2026-12-01");
    expect(
      await q("SELECT install_id, activated_ip, activated_at FROM licences WHERE client_id = $1", [
        c.clientId,
      ]),
    ).toEqual([{ install_id: A, activated_ip: "203.0.113.9", activated_at: now }]);
    expect(await kinds(c.clientId)).toEqual(["activated"]);
  });

  it("answers the same install again (a closed tab), with no second event", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    expect((await activate(c.licenseKey)).status).toBe(200);
    now = new Date(now.getTime() + 60_000);
    expect((await activate(c.licenseKey)).status).toBe(200);
    expect(await kinds(c.clientId)).toEqual(["activated"]);
  });

  it("refuses another install with KEY_IN_USE, says nothing about the first, and records the attempt", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await activate(c.licenseKey, A);
    const r = await activate(c.licenseKey, B, "198.51.100.7");
    expect(r.status).toBe(409);
    const body = await r.text();
    expect(JSON.parse(body).error.code).toBe("KEY_IN_USE");
    expect(body).not.toMatch(/203\.0\.113\.9|0190e0c0/);
    expect(
      await q<{ kind: string; detail: { ip: string } }>(
        "SELECT kind, detail FROM events WHERE client_id = $1 ORDER BY id",
        [c.clientId],
      ),
    ).toEqual([
      { kind: "activated", detail: { ip: "203.0.113.9", version: "1.5.0" } },
      { kind: "activation_refused", detail: { ip: "198.51.100.7" } },
    ]);
  });

  it("two installs racing: exactly one binds", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    const statuses = (await Promise.all([activate(c.licenseKey, A), activate(c.licenseKey, B)]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([200, 409]);
    expect((await kinds(c.clientId)).filter((k) => k === "activated")).toHaveLength(1);
  });

  it("a paused or decommissioned client: LICENCE_PAUSED, and nothing is bound", async () => {
    const paused = await seedClient(t.pool, { type: "perpetual", suspended: true });
    const gone = await seedClient(t.pool, { type: "perpetual", suspended: true, decommissioned: true });
    for (const c of [paused, gone]) {
      const r = await activate(c.licenseKey);
      expect(r.status).toBe(403);
      expect(await codeOf(r)).toBe("LICENCE_PAUSED");
      expect(await q("SELECT install_id FROM licences WHERE client_id = $1", [c.clientId])).toEqual([
        { install_id: null },
      ]);
    }
  });

  it("a retired key (rotated or decommissioned): KEY_DECOMMISSIONED, never 401", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    const { hashKey } = await import("@/lib/keys");
    const old = "LUME-0000-1111-2222-3333-4444";
    await q(
      "INSERT INTO retired_keys (key_hash, client_id, key_last4, reason, retired_at) VALUES ($1, $2, '4444', 'rotated', $3)",
      [hashKey(old), c.clientId, now],
    );
    const r = await activate(old);
    expect(r.status).toBe(403);
    expect(await codeOf(r)).toBe("KEY_DECOMMISSIONED");
  });

  it("an unknown key: 401 with nothing more, and wrong guesses from one address are limited", async () => {
    const r = await activate("LUME-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ", A, "192.0.2.50");
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Unknown licence." } });
    for (let i = 0; i < 10; i++) await activate("LUME-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZY", A, "192.0.2.50");
    expect((await activate("LUME-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZX", A, "192.0.2.50")).status).toBe(429);
  });

  it("a released licence binds to the next install that activates", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await activate(c.licenseKey, A);
    await q(
      "UPDATE licences SET install_id = NULL, activated_at = NULL, activated_ip = NULL, released_at = $2 WHERE client_id = $1",
      [c.clientId, now],
    );
    expect((await activate(c.licenseKey, B)).status).toBe(200);
    expect(
      await q("SELECT install_id, released_at FROM licences WHERE client_id = $1", [c.clientId]),
    ).toEqual([{ install_id: B, released_at: null }]);
  });

  it("takes nothing it doesn't expect: no lead data, no extra fields, no junk", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    const body = activateBody({ licenseKey: c.licenseKey, installId: A, appVersion: "1.5.0", now });
    expect((await post({ ...body, leadCount: 3 })).status).toBe(400);
    expect((await post({ ...body, installId: "not-a-uuid" })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
  });
});
