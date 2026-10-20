import { generateKeyPairSync } from "node:crypto";
import { ALL_GRANTS, rawPublicKey, signLicence, type LicencePayload } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../test/harness";
import { appVersion, resolveLicence } from "./options";

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

  it("sends only the things it may (this install's own id, what it can show, its health), with real counts and never a lead", async () => {
    await h.seedLead({ ownerId: repUser.id, name: "Counted Lead", phone: "+971501234567" });
    answer = ok(token());
    await check();
    const { url, body } = sent[0]!;
    expect(url).toBe("https://licence.test/v1/check");
    expect(Object.keys(body).sort()).toEqual(
      [
        "activeUserCount",
        "appVersion",
        "installId",
        "instanceId",
        "leadCount",
        "licenseKey",
        "serverTime",
        "accepts",
        "health",
      ].sort(),
    );
    expect(body).toMatchObject({
      instanceId: INSTANCE,
      licenseKey: KEY,
      appVersion: "1.4.2",
      accepts: ["announcements", "plan", "plan2", "plan3", "plan4"],
    });
    expect(Object.keys(body.health as object).sort()).toEqual(
      [
        "dbBytes",
        "diskFreePct",
        "errors24h",
        "modulesOn",
        "problems",
        "queue",
        "remindersLate",
        "restoreTest",
        "sourcesNeedingAttention",
        "uptimeS",
      ].sort(),
    );
    expect(body.installId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.leadCount).toBeGreaterThanOrEqual(1);
    expect(body.activeUserCount).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(body)).not.toMatch(/Counted Lead|1234567/);
  });

  it("a key in .env wins over one stored in the database (spec 2026-10-15 §1.2)", async () => {
    await h.ownerPool.query(
      "UPDATE licence_state SET instance_id = 'LUME-OTHR-0001', license_key_enc = '\\x00'::bytea WHERE id = 1",
    );
    await h.app.licence.refresh();
    answer = ok(token());
    await check();
    expect(sent.at(-1)!.body).toMatchObject({ instanceId: INSTANCE, licenseKey: KEY });
    expect(h.app.licence.keySource()).toBe("env");
    expect(h.app.licence.needsKey()).toBe(false);
    await h.ownerPool.query(
      "UPDATE licence_state SET instance_id = NULL, license_key_enc = NULL WHERE id = 1",
    );
  });

  it("a key from .env can't be changed in Settings → About: the card says so", async () => {
    const me = await owner.inject({ method: "GET", url: "/api/v1/licence" });
    expect(me.json().key).toEqual({
      masked: `LUME-••••-••••-••••-••••-${KEY.slice(-4)}`,
      source: "env",
      canChange: false,
    });
    const r = await owner.inject({
      method: "POST",
      url: "/api/v1/licence/key",
      payload: { key: "LUME-W4NB-8TZC-1KPE-6RDJ-3VXA" },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("KEY_FROM_ENV");
  });

  it("counts a paused person: pausing someone never frees a place (6A ruling R7)", async () => {
    answer = ok(token());
    await check();
    const before = sent.at(-1)!.body.activeUserCount as number;
    await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], status: "suspended" });
    await check();
    expect(sent.at(-1)!.body.activeUserCount).toBe(before + 1);
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
    // A rep never gets the note, the due date or the contact at all.
    expect((await me(rep)).licence).toMatchObject({ showNotice: false, notice: null });
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

  it("an older token never replaces a newer one (a suspension can't be undone by replaying an old answer)", async () => {
    const before = token();
    h.clock.advance(H);
    answer = ok(token({ state: "suspended", reason: "suspended" }));
    await check();
    answer = ok(before);
    expect((await check()).json()).toMatchObject({ state: "suspended" });
    const [row] = (await h.ownerPool.query("SELECT last_error FROM licence_state")).rows;
    expect(row.last_error).toMatch(/older/i);
    h.clock.advance(-H);
  });

  it("people who manage settings see why the last check failed; others don't", async () => {
    answer = () => new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 });
    await check();
    expect((await me(admin)).licence.lastError).toMatch(/didn't recognise this install's key/);
    expect((await me(rep)).licence.lastError).toBeNull();
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
  it("a release build with no licence keys refuses to start, and says why (it would lock every client in 7 days)", () => {
    expect(() => resolveLicence({ env, release: true, version: "1.4.2", keys: {} })).toThrow(
      /release build of LUME has no licence keys/,
    );
    // A development build may run with none (it's dev unless told otherwise).
    expect(resolveLicence({ env: {}, release: false, version: "dev", keys: {} }).mode).toBe("dev");
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

describe("the version an installation reports", () => {
  it("a release's own (baked into its image), else LUME's version from the root package.json", async () => {
    const root = (await import("../../../../package.json", { with: { type: "json" } })).default.version;
    expect(appVersion({ LUME_VERSION: "1.4.2" })).toBe("1.4.2");
    expect(appVersion({})).toBe(root);
    expect(root).toMatch(/^\d+\.\d+\.\d+$/);
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

describe("From LUME's team (spec 2026-10-16 fleet §4)", () => {
  const A = "0190e0c0-0000-7000-8000-0000000000a1";
  const B = "0190e0c0-0000-7000-8000-0000000000b2";
  const claim = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: id === A ? "LUME will be updated on Saturday night" : "Snooze by an hour",
    body: "Plain words.",
    kind: "update" as const,
    audience: "everyone" as const,
    windowStart: null,
    windowEnd: null,
    endsAt: new Date(h.clock.now.getTime() + 3 * D).toISOString(),
    ...over,
  });
  const people = async (c: AuthedClient) =>
    ((await me(c)).licence.announcements as { id: string; gotIt: boolean }[]).map((a) => [a.id, a.gotIt]);

  it("shows each person the ones meant for them: admins-only never to a rep", async () => {
    answer = ok(token({ announcements: [claim(A, { audience: "admins" }), claim(B)] }));
    await check();
    expect(await people(await h.signIn(adminUser))).toEqual([
      [A, false],
      [B, false],
    ]);
    expect(await people(await h.signIn(repUser))).toEqual([[B, false]]);
  });

  it("Got it is per person, kept on the server, and its count goes back with the next check", async () => {
    answer = ok(token({ announcements: [claim(A), claim(B)] }));
    await check();
    const r = await (
      await h.signIn(repUser)
    ).inject({ method: "POST", url: `/api/v1/licence/announcements/${A}/got-it` });
    expect(r.statusCode).toBe(200);
    expect(await people(await h.signIn(repUser))).toEqual([
      [A, true],
      [B, false],
    ]);
    expect(await people(await h.signIn(adminUser))).toEqual([
      [A, false],
      [B, false],
    ]);
    // Twice is still once.
    await (
      await h.signIn(repUser)
    ).inject({ method: "POST", url: `/api/v1/licence/announcements/${A}/got-it` });
    sent.length = 0;
    await check();
    expect(sent[0]!.body.seen).toEqual([
      { id: A, people: 1 },
      { id: B, people: 0 },
    ]);
  });

  it("an admins-only one can't be marked by a rep, and an unknown id is 404", async () => {
    answer = ok(token({ announcements: [claim(A, { audience: "admins" })] }));
    await check();
    const rp = await h.signIn(repUser);
    expect(
      (await rp.inject({ method: "POST", url: `/api/v1/licence/announcements/${A}/got-it` })).statusCode,
    ).toBe(404);
    expect(
      (await rp.inject({ method: "POST", url: `/api/v1/licence/announcements/${B}/got-it` })).statusCode,
    ).toBe(404);
  });

  it("an announcement past its end goes, even from the answer LUME keeps", async () => {
    answer = ok(
      token({ announcements: [claim(A, { endsAt: new Date(h.clock.now.getTime() + H).toISOString() })] }),
    );
    await check();
    expect(await people(await h.signIn(adminUser))).toEqual([[A, false]]);
    h.clock.advance(2 * H);
    await h.app.licence.refresh();
    expect(await people(await h.signIn(adminUser))).toEqual([]);
  });

  it("Got it works while LUME is read-only", async () => {
    answer = ok(token({ state: "read_only", reason: "overdue", announcements: [claim(B)] }));
    await check();
    const r = await (
      await h.signIn(repUser)
    ).inject({ method: "POST", url: `/api/v1/licence/announcements/${B}/got-it` });
    expect(r.statusCode).toBe(200);
  });
});

describe("an older licence server (spec 2026-10-16 fleet §1.3)", () => {
  it("refuses a body with health in it: LUME asks again the old way, once, and keeps its licence", async () => {
    answer = () => {
      const last = sent.at(-1)!.body;
      return "accepts" in last || "health" in last
        ? new Response(JSON.stringify({ error: { code: "BAD_REQUEST", message: "Not a licence check." } }), {
            status: 400,
          })
        : new Response(JSON.stringify({ token: token() }), { status: 200 });
    };
    const r = (await check()).json();
    expect(sent).toHaveLength(2);
    expect(Object.keys(sent[1]!.body)).not.toContain("accepts");
    expect(Object.keys(sent[1]!.body)).not.toContain("health");
    expect(r.state).toBe("active");
    expect(r.lastError).toBeNull();
  });
});

describe("health never holds a check-in up (spec 2026-10-16 fleet §1.1; final review)", () => {
  it("a health read that hangs is given up after a few seconds, and the check goes without it", async () => {
    h.app.licence.reportHealth(() => new Promise(() => undefined));
    answer = ok(token());
    const started = Date.now();
    const r = (await check()).json();
    expect(r.state).toBe("active");
    expect(sent[0]!.body).not.toHaveProperty("health");
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);
});
