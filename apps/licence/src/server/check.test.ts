import { checkBody, rawPublicKey, verifyLicence } from "@lume/core";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Limiter } from "@/lib/limit";
import { handleCheck, pruneCheckIns } from "./check";
import type { Ctx } from "./context";
import { licenceDb, seedClient, TEST_PAIR, testCtx, type LicenceTestDb } from "./testing";

const KEYS = { t1: rawPublicKey(TEST_PAIR.publicKey) };
/** The install the seeded licences are checked from (spec 2026-10-15 §2.2). */
const INSTALL_A = "0190e0c0-0000-7000-8000-0000000000a1";
const INSTALL_B = "0190e0c0-0000-7000-8000-0000000000b2";
let t: LicenceTestDb;
let now = new Date("2026-10-05T09:00:00Z");
let ctx: Ctx;

const body = (o: {
  instanceId: string;
  licenseKey: string;
  appVersion?: string;
  leadCount?: number;
  installId?: string;
}) =>
  checkBody({
    instanceId: o.instanceId,
    licenseKey: o.licenseKey,
    installId: o.installId ?? INSTALL_A,
    appVersion: o.appVersion ?? "1.4.2",
    activeUserCount: 4,
    leadCount: o.leadCount ?? 312,
    now,
  });
const post = (data: unknown, ip = "203.0.113.9") =>
  handleCheck(
    new Request("http://licence.test/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: typeof data === "string" ? data : JSON.stringify(data),
    }),
    ctx,
  );
const tokenOf = async (r: Response) => ((await r.json()) as { token: string }).token;
const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
  (await t.pool.query<T>(sql, params)).rows;

beforeAll(async () => {
  t = await licenceDb();
});
afterAll(async () => {
  await t?.close();
});
beforeEach(() => {
  now = new Date("2026-10-05T09:00:00Z");
  ctx = testCtx(t.pool, () => now);
});

describe("/v1/check (spec §4.3)", () => {
  it("answers a signed token that an instance verifies, with the state worked out on the server", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-10-01" });
    const r = await post(body(c));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const p = verifyLicence(await tokenOf(r), KEYS, c.instanceId);
    expect(p).toMatchObject({
      v: 1,
      kid: "t1",
      instanceId: c.instanceId,
      state: "grace",
      reason: "overdue",
      licenseType: "subscription",
      paidUntil: "2026-10-01",
      trialEndsAt: null,
      notice: null,
      issuedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + 8 * 86_400_000).toISOString(),
    });
  });

  it("an unknown instance, or a wrong key, gets 401 and nothing more — the same answer for both", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    const wrong = await post(
      body({ ...c, licenseKey: c.licenseKey.slice(0, -1) + (c.licenseKey.endsWith("0") ? "1" : "0") }),
    );
    const unknown = await post(body({ instanceId: "LUME-ZZZZ-ZZZZ", licenseKey: c.licenseKey }));
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
    expect(await q("SELECT 1 FROM check_ins WHERE client_id = $1", [c.clientId])).toHaveLength(0);
  });

  it("the key is matched however it's typed: spaces around it and lower case", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    expect((await post(body({ ...c, licenseKey: ` ${c.licenseKey.toLowerCase()} ` }))).status).toBe(200);
  });

  it("the body is strict: an extra field, a missing one, a wrong type or not JSON is refused", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    const good = body(c);
    expect((await post({ ...good, leads: [{ name: "x" }] })).status).toBe(400);
    const missing: Partial<typeof good> = { ...good };
    delete missing.leadCount;
    expect((await post(missing)).status).toBe(400);
    expect((await post({ ...good, leadCount: "312" })).status).toBe(400);
    expect((await post({ ...good, leadCount: -1 })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post(`"${"x".repeat(20_000)}"`)).status).toBe(400);
  });

  it("a huge body is refused once it passes 4 KB, without reading the rest", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += chunk.length;
        if (pulled > 1024 * 1024) c.close();
        else c.enqueue(chunk);
      },
    });
    const r = await handleCheck(
      new Request("http://licence.test/v1/check", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.77" },
        body: stream,
        duplex: "half",
      } as RequestInit),
      ctx,
    );
    expect(r.status).toBe(400);
    expect(pulled).toBeLessThanOrEqual(16 * 1024);
  });

  it("records the check-in, and a new version or a new state is an event in the client's history", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-10-10" });
    await post(body({ ...c, appVersion: "1.4.1" }));
    await post(body({ ...c, appVersion: "1.4.1" }));
    now = new Date("2026-10-12T09:00:00Z");
    await post(body({ ...c, appVersion: "1.4.2", leadCount: 400 }));
    const ins = await q<{
      app_version: string;
      lead_count: number;
      active_users: number;
      state: string;
      ip: string;
    }>(
      "SELECT app_version, lead_count, active_users, state, ip FROM check_ins WHERE client_id = $1 ORDER BY at",
      [c.clientId],
    );
    expect(ins).toEqual([
      { app_version: "1.4.1", lead_count: 312, active_users: 4, state: "active", ip: "203.0.113.9" },
      { app_version: "1.4.1", lead_count: 312, active_users: 4, state: "active", ip: "203.0.113.9" },
      { app_version: "1.4.2", lead_count: 400, active_users: 4, state: "grace", ip: "203.0.113.9" },
    ]);
    const ev = await q<{ kind: string; detail: unknown }>(
      "SELECT kind, detail FROM events WHERE client_id = $1 AND kind IN ('first_check_in', 'version', 'state') ORDER BY id",
      [c.clientId],
    );
    expect(ev).toEqual([
      { kind: "first_check_in", detail: { version: "1.4.1", state: "active" } },
      { kind: "version", detail: { from: "1.4.1", to: "1.4.2" } },
      { kind: "state", detail: { from: "active", to: "grace" } },
    ]);
  });

  it("an open payment reminder rides in the token, with the billing contact; a cleared one doesn't", async () => {
    const c = await seedClient(t.pool, { type: "subscription", paidUntil: "2026-10-03" });
    await t.pool.query("UPDATE settings SET billing_contact = 'mailto:billing@lume.test'");
    const [n] = await q<{ id: string }>(
      "INSERT INTO notices (client_id, note, due_date) VALUES ($1, 'UPI is fine.', '2026-10-03') RETURNING id",
      [c.clientId],
    );
    const notice = async () => verifyLicence(await tokenOf(await post(body(c))), KEYS, c.instanceId)?.notice;
    expect(await notice()).toEqual({
      id: n!.id,
      kind: "payment_due",
      dueDate: "2026-10-03",
      note: "UPI is fine.",
      contact: "mailto:billing@lume.test",
    });
    await t.pool.query("UPDATE notices SET cleared_at = now() WHERE id = $1", [n!.id]);
    await t.pool.query("UPDATE settings SET billing_contact = NULL");
    expect(await notice()).toBeNull();
  });

  it("suspended answers suspended; a decommissioned client too", async () => {
    const c = await seedClient(t.pool, { type: "perpetual", suspended: true });
    expect(verifyLicence(await tokenOf(await post(body(c))), KEYS, c.instanceId)).toMatchObject({
      state: "suspended",
      reason: "suspended",
    });
    const d = await seedClient(t.pool, { type: "perpetual", decommissioned: true });
    expect(verifyLicence(await tokenOf(await post(body(d))), KEYS, d.instanceId)).toMatchObject({
      state: "suspended",
    });
  });

  it("rate-limits an instance to its checks an hour, and an address to its own limit", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    ctx.limits.instance = new Limiter(3, 3_600_000);
    for (let i = 0; i < 3; i++) expect((await post(body(c))).status).toBe(200);
    const r = await post(body(c));
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    now = new Date(now.getTime() + 3_600_000);
    expect((await post(body(c))).status).toBe(200);

    ctx.limits.ip = new Limiter(2, 3_600_000);
    const d = await seedClient(t.pool, { type: "perpetual" });
    expect((await post(body(d), "198.51.100.7")).status).toBe(200);
    expect((await post(body(d), "198.51.100.7")).status).toBe(200);
    expect((await post(body(d), "198.51.100.7")).status).toBe(429);
    expect((await post(body(d), "198.51.100.8")).status).toBe(200);
  });

  it("wrong keys never spend a client's own allowance (an instance ID isn't a secret)", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    ctx.limits.instance = new Limiter(2, 3_600_000);
    for (let i = 0; i < 5; i++) await post(body({ ...c, licenseKey: "WRONG" }), `198.51.100.${40 + i}`);
    expect((await post(body(c))).status).toBe(200);
  });

  it("wrong keys are limited per address and instance, so a key can't be guessed quickly", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    ctx.limits.wrongKey = new Limiter(2, 3_600_000);
    expect((await post(body({ ...c, licenseKey: "WRONG" }), "198.51.100.50")).status).toBe(401);
    expect((await post(body({ ...c, licenseKey: "WRONG" }), "198.51.100.50")).status).toBe(401);
    expect((await post(body({ ...c, licenseKey: "WRONG" }), "198.51.100.50")).status).toBe(429);
    // Even the right key from that address waits: it can't be told apart from the next guess.
    expect((await post(body(c), "198.51.100.50")).status).toBe(429);
    expect((await post(body(c), "198.51.100.51")).status).toBe(200);
  });

  it("keeps check-ins for 180 days", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await t.pool.query(
      `INSERT INTO check_ins (client_id, at, app_version, active_users, lead_count, state)
       VALUES ($1, $2::timestamptz - interval '181 days', '1.0.0', 1, 1, 'active'),
              ($1, $2::timestamptz - interval '179 days', '1.0.0', 1, 1, 'active')`,
      [c.clientId, now.toISOString()],
    );
    expect(await pruneCheckIns(t.pool, now)).toBe(1);
    expect(await q("SELECT 1 FROM check_ins WHERE client_id = $1", [c.clientId])).toHaveLength(1);
  });
});

describe("check-ins come from the bound install (spec 2026-10-15 §2.2, §2.4)", () => {
  const DAY = 86_400_000;
  const licence = async (clientId: string) =>
    (
      await q<{ install_id: string | null; released_at: Date | null }>(
        "SELECT install_id, released_at FROM licences WHERE client_id = $1",
        [clientId],
      )
    )[0]!;
  const checkInsOf = async (clientId: string) =>
    Number((await q<{ n: string }>("SELECT count(*) AS n FROM check_ins WHERE client_id = $1", [clientId]))[0]!.n);
  const retire = async (clientId: string, key: string, reason: "rotated" | "decommissioned", at: Date) => {
    const { hashKey } = await import("@/lib/keys");
    await q(
      "INSERT INTO retired_keys (key_hash, client_id, key_last4, reason, retired_at, install_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [hashKey(key), clientId, key.slice(-4), reason, at, INSTALL_A],
    );
  };

  it("a licence that was never bound binds to the install of its first check (keyed through .env)", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    expect((await post(body(c))).status).toBe(200);
    expect((await licence(c.clientId)).install_id).toBe(INSTALL_A);
    expect((await post(body({ ...c, installId: INSTALL_B }))).status).toBe(409);
  });

  it("another install is refused with KEY_IN_USE and isn't recorded as a check-in", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await post(body(c));
    const before = await checkInsOf(c.clientId);
    const r = await post(body({ ...c, installId: INSTALL_B }), "198.51.100.7");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("KEY_IN_USE");
    expect(await checkInsOf(c.clientId)).toBe(before);
    // The owner hears of it, at most once an hour from one address.
    await post(body({ ...c, installId: INSTALL_B }), "198.51.100.7");
    expect(
      await q("SELECT kind FROM events WHERE client_id = $1 AND kind = 'activation_refused'", [c.clientId]),
    ).toHaveLength(1);
  });

  it("a released key is answered but never bound by a check: only a key entered by hand takes it", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await post(body(c));
    await q(
      "UPDATE licences SET install_id = NULL, activated_at = NULL, activated_ip = NULL, released_at = $2 WHERE client_id = $1",
      [c.clientId, now],
    );
    expect((await post(body(c))).status).toBe(200);
    expect(await licence(c.clientId)).toMatchObject({ install_id: null });
  });

  it("a rotated key keeps the bound install going for 7 days, then KEY_DECOMMISSIONED", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await post(body(c));
    const old = c.licenseKey;
    const { hashKey } = await import("@/lib/keys");
    await q("UPDATE licences SET key_hash = $2 WHERE client_id = $1", [c.clientId, hashKey("LUME-NEWK-EY00-0000-0000-0001")]);
    await retire(c.clientId, old, "rotated", now);
    now = new Date(now.getTime() + 6 * DAY);
    const r = await post(body({ instanceId: c.instanceId, licenseKey: old }));
    expect(r.status).toBe(200);
    expect(verifyLicence(await tokenOf(r), KEYS, c.instanceId)?.state).toBe("active");
    now = new Date(now.getTime() + 2 * DAY);
    const late = await post(body({ instanceId: c.instanceId, licenseKey: old }));
    expect(late.status).toBe(403);
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe("KEY_DECOMMISSIONED");
  });

  it("a rotated key from any other install is refused at once", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await post(body(c));
    const { hashKey } = await import("@/lib/keys");
    await q("UPDATE licences SET key_hash = $2 WHERE client_id = $1", [c.clientId, hashKey("LUME-NEWK-EY00-0000-0000-0002")]);
    await retire(c.clientId, c.licenseKey, "rotated", now);
    expect((await post(body({ ...c, installId: INSTALL_B }))).status).toBe(403);
  });

  it("a decommissioned key: the install that held it hears it's suspended (signed); anywhere else, refused", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    await post(body(c));
    const { hashKey } = await import("@/lib/keys");
    await q(
      "UPDATE licences SET key_hash = $2, key_dead_at = $3, install_id = NULL WHERE client_id = $1",
      [c.clientId, hashKey("LUME-DEAD-0000-0000-0000-0003"), now],
    );
    await retire(c.clientId, c.licenseKey, "decommissioned", now);
    const r = await post(body(c));
    expect(r.status).toBe(200);
    const p = verifyLicence(await tokenOf(r), KEYS, c.instanceId);
    expect(p).toMatchObject({ state: "suspended", reason: "key_decommissioned" });
    expect((await post(body({ ...c, installId: INSTALL_B }))).status).toBe(403);
  });

  it("an install id is required", async () => {
    const c = await seedClient(t.pool, { type: "perpetual" });
    const { installId: _i, ...noInstall } = body(c);
    void _i;
    expect((await post(noInstall)).status).toBe(400);
  });
});
