import { generateKeyPairSync } from "node:crypto";
import { ALL_GRANTS, rawPublicKey, signLicence, type LicencePayload } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../test/harness";
import { resolveLicence } from "./options";

const server = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const INSTANCE = "LUME-TEST-0001";
const KEY = "LUME-KEY-SECRET-0001";
const H = 3_600_000;
const D = 24 * H;

let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;
let owner: AuthedClient;
let repUser: { id: string; email: string; password: string };
let adminUser: { id: string; email: string; password: string };

// A fake licence server: answers as each test says, and remembers what it was sent.
type Answer = () => Promise<Response> | Response;
let answer: Answer;
const sent: { url: string; body: Record<string, unknown> }[] = [];
let gate: Promise<void> | null = null;
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
  if (gate) await gate;
  return answer();
}) as typeof fetch;

const token = (over: Partial<LicencePayload> = {}, key = server.privateKey) =>
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
    key,
  );
const ok =
  (t: string): Answer =>
  () =>
    new Response(JSON.stringify({ token: t }), { status: 200 });

beforeAll(async () => {
  h = await createHarness({
    licence: {
      mode: "enforce",
      instanceId: INSTANCE,
      licenseKey: KEY,
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.4.2",
      fetch: fakeFetch,
    },
  });
  owner = await h.signIn(await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true }));
  adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  admin = await h.signIn(adminUser);
  repUser = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
  rep = await h.signIn(repUser);
});
afterAll(() => h.close());
beforeEach(async () => {
  sent.length = 0;
  gate = null;
  // Each test starts from a new install that has never heard from its licence server.
  await h.ownerPool.query(
    "UPDATE licence_state SET token = NULL, last_attempt_at = NULL, last_success_at = NULL, last_error = NULL, first_boot_at = $1",
    [h.clock.now],
  );
  await h.app.licence.refresh();
});

// Fresh sessions each time: moving the clock days ahead would otherwise sign the test clients out.
const check = async () =>
  (await h.signIn(adminUser)).inject({ method: "POST", url: "/api/v1/licence/check" });
const view = async () =>
  (await (await h.signIn(repUser)).inject({ method: "GET", url: "/api/v1/licence" })).json();
const me = async (c: AuthedClient) => (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();

describe("the instance checks its licence (L-A Task 2)", () => {
  it("before its first check a new install is in grace, and says so", async () => {
    expect(await view()).toMatchObject({
      state: "grace",
      reason: "not_checked",
      dev: false,
      checkedAt: null,
    });
  });

  it("a good answer is kept, and the state follows it; everyone can see it", async () => {
    answer = ok(token());
    const r = await check();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      state: "active",
      reason: "paid",
      licenseType: "subscription",
      paidUntil: "2026-12-31",
    });
    expect(await view()).toMatchObject({ state: "active" });
    expect((await me(rep)).licence).toMatchObject({ state: "active", showNotice: false, canCheck: false });
    expect((await me(admin)).licence).toMatchObject({ canCheck: true, instanceId: INSTANCE });
    // The next check is 6 hours after the last try.
    const l = (await me(admin)).licence;
    expect(Date.parse(l.nextCheckAt) - Date.parse(l.checkedAt)).toBe(6 * H);
  });

  it("sends only the six things it may, with real counts and never a lead", async () => {
    await h.seedLead({ ownerId: repUser.id, name: "Counted Lead", phone: "+971501234567" });
    answer = ok(token());
    await check();
    const { url, body } = sent[0]!;
    expect(url).toBe("https://licence.test/v1/check");
    expect(Object.keys(body).sort()).toEqual(
      ["activeUserCount", "appVersion", "instanceId", "leadCount", "licenseKey", "serverTime"].sort(),
    );
    expect(body).toMatchObject({ instanceId: INSTANCE, licenseKey: KEY, appVersion: "1.4.2" });
    expect(body.leadCount).toBeGreaterThanOrEqual(1);
    expect(body.activeUserCount).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(body)).not.toMatch(/Counted Lead|1234567/);
  });

  it("out of reach: the last token stands; 24 hours on it's grace, 7 days on it's read-only", async () => {
    answer = ok(token());
    await check();
    answer = () => {
      throw new TypeError("fetch failed");
    };
    const r = (await check()).json();
    expect(r).toMatchObject({ state: "active" });
    const [row] = (await h.ownerPool.query("SELECT last_error FROM licence_state")).rows;
    expect(row.last_error).toMatch(/couldn't reach/i);
    h.clock.advance(24 * H);
    expect(await view()).toMatchObject({ state: "grace", reason: "unreachable" });
    h.clock.advance(6 * D);
    expect(await view()).toMatchObject({ state: "read_only", reason: "unreachable" });
    h.clock.advance(-7 * D);
  });

  it("an answer not signed by LUME changes nothing, and is recorded", async () => {
    answer = ok(token());
    await check();
    answer = ok(token({ state: "suspended", reason: "suspended" }, stranger.privateKey));
    expect((await check()).json()).toMatchObject({ state: "active" });
    const [row] = (await h.ownerPool.query("SELECT last_error FROM licence_state")).rows;
    expect(row.last_error).toMatch(/not signed by LUME/i);
  });

  it("a refused key keeps the last token until it runs out", async () => {
    answer = ok(token());
    await check();
    answer = () => new Response(JSON.stringify({ error: { code: "UNKNOWN_KEY" } }), { status: 401 });
    expect((await check()).json()).toMatchObject({ state: "active" });
    h.clock.advance(8 * D);
    // Still answering (so not "unreachable"), but the token has run out.
    await check();
    expect(await view()).toMatchObject({ state: "read_only" });
    h.clock.advance(-8 * D);
  });

  it("a sign-in checks when the last check is stale, never waits for it, and not again while fresh", async () => {
    answer = ok(token());
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    const signIn = async (u: { email: string; password: string }) => {
      const csrf = await h.csrf();
      return h.app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: u.email, password: u.password },
        cookies: csrf.cookies,
        headers: csrf.headers,
      });
    };
    const r = await signIn(repUser);
    expect(r.statusCode).toBe(200); // answered while the licence server hasn't
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    release();
    await h.app.licence.idle();
    expect(await view()).toMatchObject({ state: "active" });
    await signIn(repUser);
    expect(sent).toHaveLength(1); // fresh: no second check
    h.clock.advance(16 * 60_000);
    await signIn(repUser);
    await h.app.licence.idle();
    expect(sent).toHaveLength(2);
  });

  it("the payment reminder: owners and admins at every sign-in until it's gone, never reps", async () => {
    const notice = { id: "n-1", kind: "payment_due" as const, dueDate: "2026-09-26", note: "UPI is fine" };
    answer = ok(token({ notice, state: "grace", reason: "overdue" }));
    await check();
    expect((await me(owner)).licence).toMatchObject({ showNotice: true, notice });
    expect((await me(admin)).licence).toMatchObject({ showNotice: true });
    expect((await me(rep)).licence).toMatchObject({ showNotice: false });
    // "I'll sort it": closed for this session…
    expect((await admin.inject({ method: "POST", url: "/api/v1/licence/notice/dismiss" })).statusCode).toBe(
      204,
    );
    expect((await me(admin)).licence.showNotice).toBe(false);
    // …and back at the next sign-in.
    const again = await h.signIn(adminUser);
    expect((await me(again)).licence.showNotice).toBe(true);
    // Paid: the server's next token has no notice, and nobody sees it.
    answer = ok(token());
    await check();
    expect((await me(again)).licence.showNotice).toBe(false);
  });

  it("Check now is for people who manage settings", async () => {
    expect((await rep.inject({ method: "POST", url: "/api/v1/licence/check" })).statusCode).toBe(403);
  });
});

describe("where the licence comes from (a release build trusts only itself)", () => {
  const env = {
    LUME_LICENSE_MODE: "dev",
    LUME_LICENSE_EXTRA_KEYS: "x1:AAAA",
    LUME_LICENSE_KEY: KEY,
    LUME_INSTANCE_ID: INSTANCE,
    LUME_LICENSE_URL: "https://licence.test",
  };
  it("a release build ignores dev mode and keys from its environment", () => {
    const r = resolveLicence({ env, release: true, version: "1.4.2" });
    expect(r.mode).toBe("enforce");
    expect(Object.keys(r.keys)).not.toContain("x1");
  });
  it("a development build is dev unless told to enforce, and may be given a test key", () => {
    expect(resolveLicence({ env: {}, release: false, version: "dev" }).mode).toBe("dev");
    const r = resolveLicence({
      env: { ...env, LUME_LICENSE_MODE: "enforce" },
      release: false,
      version: "dev",
    });
    expect(r).toMatchObject({ mode: "enforce", instanceId: INSTANCE, url: "https://licence.test" });
    expect(r.keys.x1).toBe("AAAA");
  });
});

describe("a development build", () => {
  let dev: Harness;
  beforeAll(async () => {
    dev = await createHarness();
  });
  afterAll(() => dev.close());
  it("is always active, says so, and never calls anyone", async () => {
    const who = await dev.signIn(await dev.seedUser({ grants: ALL_GRANTS, totp: true }));
    expect((await who.inject({ method: "GET", url: "/api/v1/licence" })).json()).toMatchObject({
      state: "active",
      reason: "dev",
      dev: true,
    });
    const before = sent.length;
    expect((await who.inject({ method: "POST", url: "/api/v1/licence/check" })).json()).toMatchObject({
      dev: true,
    });
    expect(sent.length).toBe(before);
  });
});
