import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import pg from "pg";
import type { AddressInfo } from "node:net";
import {
  ALL_GRANTS,
  instanceIdOf,
  rawPublicKey,
  relaySign,
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
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { IG_TOKEN_REFRESH_MS, sweepInstagramTokens } from "./token-refresh";

/** Connecting an Instagram account, whose it is, and its token (NEW_FEATURES_PLAN §4.2; plan 1A Task 4). */
const RELAY_TOKEN = "r".repeat(40);
const server = generateKeyPairSync("ed25519");
const all = {
  googleSheets: true,
  webhooks: true,
  googleCalendar: true,
  calendly: true,
  ai: true,
  whatsapp: true,
  instagram: true,
};
const ACCT = "17841400000000001";
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
let admin2: { id: string; email: string; password: string };
let rep: { id: string; email: string; password: string };
let plan: PlanClaim | undefined;
// The relay, as this LUME sees it: what it was asked to forget.
let relay: http.Server;
let forgot: { auth: string | undefined; body: unknown }[] = [];

const token = () =>
  signLicence(
    {
      v: 1,
      kid: "t1",
      instanceId: "LUME-TEST-IG",
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
  (await as(u)).inject({ method: "PUT", url: "/api/v1/integrations/instagram", payload: { enabled } });

function handBack(
  nonce: string,
  over: Partial<NonNullable<Handoff["instagram"]>> = {},
  exp = Date.now() + 60_000,
) {
  const ho: Handoff = {
    nonce,
    kind: "instagram",
    instagram: {
      token: "IGQlong-account-token",
      expiresIn: 5_184_000,
      userId: ACCT,
      username: "harbour.studio",
      name: "Harbour Studio",
      accountType: "BUSINESS",
      ...over,
    },
    exp,
  };
  const p = seal(RELAY_TOKEN, ho);
  return { p, s: sign(RELAY_TOKEN, p) };
}
async function startNonce(u = admin): Promise<string> {
  const r = await (await as(u)).inject({ method: "POST", url: "/api/v1/instagram/connect" });
  expect(r.statusCode).toBe(200);
  const url = new URL(r.json().url as string);
  expect(url.pathname).toBe("/ig/start");
  expect(url.searchParams.get("i")).toBe(instanceIdOf(RELAY_TOKEN));
  const n = url.searchParams.get("n")!;
  expect(verify(RELAY_TOKEN, `${n}.instagram`, url.searchParams.get("s")!)).toBe(true);
  return n;
}
const complete = async (body: { p: string; s: string }, u = admin) =>
  (await as(u)).inject({ method: "POST", url: "/api/v1/instagram/connect/complete", payload: body });
const connect = async (over: Partial<NonNullable<Handoff["instagram"]>> = {}) => {
  const r = await complete(handBack(await startNonce(), over));
  expect(r.statusCode).toBe(200);
  return r.json().accounts as { id: string; username: string; sourceId: string; status: string }[];
};
/** A call as the relay makes it: signed with this instance's token, at the harness's time. */
const fromRelay = (method: "GET" | "POST", url: string, body?: unknown) => {
  h.clock.advance(1000);
  const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const ts = String(Math.floor(h.clock.now.getTime() / 1000));
  return h.app.inject({
    method,
    url,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-lume-timestamp": ts,
      "x-lume-signature": relaySign(RELAY_TOKEN, ts, raw),
    },
    ...(body === undefined ? {} : { payload: raw }),
  });
};

beforeAll(async () => {
  ig = await startInstagramFake();
  relay = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      forgot.push({
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString() || "null"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ dropped: true }));
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
    licence: {
      mode: "enforce",
      instanceId: "LUME-TEST-IG",
      licenseKey: "LUME-KEY-SECRET-IG",
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.8.0",
      fetch: (async () => new Response(JSON.stringify({ token: token() }), { status: 200 })) as typeof fetch,
    },
  });
  h.setRelayUrl(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  admin2 = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
});
afterAll(async () => {
  await h.close();
  await ig.close();
  relay.close();
});
beforeEach(async () => {
  // Row-level security is forced on these, so they're cleared with every lead in scope.
  await h.queryAll("DELETE FROM instagram_threads");
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  // Each person's own (row-level security): emptied by the table's owner, read back as the backup role.
  await h.ownerPool.query("TRUNCATE notifications");
  await h.ownerPool.query(`UPDATE settings SET integrations = integrations - 'instagram' WHERE id = 1`);
  await withPlan({ places: null, modules: all });
  ig.calls.length = 0;
  ig.tokens.clear();
  ig.revoked.clear();
  ig.subscriptions.clear();
  ig.failPaths.clear();
  forgot = [];
});
async function systemAlerts(): Promise<{ user_id: string; title: string }[]> {
  const reader = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
  await reader.connect();
  return (
    await reader
      .query<{ user_id: string; title: string }>(
        "SELECT user_id, title FROM notifications WHERE kind = 'system_alert' ORDER BY id",
      )
      .finally(() => reader.end())
  ).rows;
}

describe("the switch", () => {
  it("off by default; an admin switches it on, in the audit log", async () => {
    const before = await (await as(admin)).inject({ method: "GET", url: "/api/v1/integrations" });
    expect(before.json().instagram).toEqual({ enabled: false, available: true, inPlan: true });
    const r = await switchTo(true);
    expect(r.statusCode).toBe(200);
    expect(r.json().instagram.enabled).toBe(true);
    const audit = await h.queryAll<{ action: string; diff: unknown }>(
      "SELECT action, diff FROM audit_log ORDER BY id DESC LIMIT 1",
    );
    expect(audit[0]).toEqual({ action: "integration.enabled", diff: { module: "instagram" } });
  });

  it("can't be switched on when the plan leaves Instagram out", async () => {
    await withPlan({ places: null, modules: { ...all, instagram: false } });
    const r = await switchTo(true);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("PLAN_MODULE");
  });

  it("is for admins only", async () => {
    expect((await switchTo(true, rep)).statusCode).toBe(403);
    expect(
      (await (await as(rep)).inject({ method: "POST", url: "/api/v1/instagram/connect" })).statusCode,
    ).toBe(403);
  });

  it("connecting needs the switch on", async () => {
    const r = await (await as(admin)).inject({ method: "POST", url: "/api/v1/instagram/connect" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("INSTAGRAM_OFF");
  });
});

describe("connecting an account", () => {
  beforeEach(async () => void (await switchTo(true)));

  it("keeps the account with its token encrypted, makes its lead source, and audits it", async () => {
    const [a] = await connect();
    expect(a).toMatchObject({ username: "harbour.studio", status: "active" });
    const [row] = await h.queryAll<{ token_enc: Buffer; ig_user_id: string; run_as: string }>(
      "SELECT token_enc, ig_user_id, run_as FROM instagram_accounts",
    );
    expect(row!.ig_user_id).toBe(ACCT);
    expect(row!.run_as).toBe(admin.id);
    expect(row!.token_enc.toString("latin1")).not.toContain("IGQlong");
    const [src] = await h.queryAll<{ type: string; name: string; status: string; rules: { owner: unknown } }>(
      "SELECT type, name, status, rules FROM lead_sources WHERE id = $1",
      [a!.sourceId],
    );
    expect(src).toMatchObject({ type: "instagram", name: "Instagram @harbour.studio", status: "active" });
    expect(src!.rules.owner).toEqual({ mode: "unassigned" });
    const view = await (await as(admin)).inject({ method: "GET", url: "/api/v1/instagram/accounts" });
    expect(JSON.stringify(view.json())).not.toContain("IGQlong");
    const audit = await h.queryAll<{ action: string }>(
      "SELECT action FROM audit_log ORDER BY id DESC LIMIT 1",
    );
    expect(audit[0]!.action).toBe("instagram.connected");
  });

  it("refuses a tampered hand-back, an expired one, another admin's, and one used twice", async () => {
    const n = await startNonce();
    const good = handBack(n);
    expect((await complete({ p: good.p, s: "forged" })).statusCode).toBe(400);
    expect((await complete(handBack(n, {}, Date.now() - 1))).json().error.code).toBe("CONNECT_EXPIRED");
    expect((await complete(good, admin2)).statusCode).toBe(404);
    expect((await complete(good)).statusCode).toBe(200);
    expect((await complete(good)).statusCode).toBe(404);
  });

  it("refuses a WhatsApp hand-back sealed for this LUME", async () => {
    const n = await startNonce();
    const p = seal(RELAY_TOKEN, { nonce: n, kind: "whatsapp", exp: Date.now() + 60_000 } satisfies Handoff);
    expect((await complete({ p, s: sign(RELAY_TOKEN, p) })).statusCode).toBe(400);
  });

  it("refuses an account id that isn't Meta's", async () => {
    expect((await complete(handBack(await startNonce(), { userId: "../../x" }))).statusCode).toBe(400);
  });

  it("connecting the same account again keeps its id, its conversations and its lead source", async () => {
    const [a] = await connect();
    await h.queryAll(
      "INSERT INTO instagram_threads (id, account_id, igsid) VALUES (gen_random_uuid(), $1, '6512000000000001')",
      [a!.id],
    );
    const [b] = await connect({ username: "harbour.studio.new" });
    expect(b!.id).toBe(a!.id);
    expect(b!.sourceId).toBe(a!.sourceId);
    expect((await h.queryAll("SELECT 1 FROM instagram_threads")).length).toBe(1);
    const [src] = await h.queryAll<{ name: string }>("SELECT name FROM lead_sources WHERE id = $1", [
      a!.sourceId,
    ]);
    expect(src!.name).toBe("Instagram @harbour.studio.new");
  });

  it("says when there's no pipeline with an open stage for its leads", async () => {
    await h.ownerPool.query("UPDATE pipelines SET is_default = false");
    const r = await complete(handBack(await startNonce()));
    await h.ownerPool.query(
      "UPDATE pipelines SET is_default = true WHERE id = (SELECT id FROM pipelines ORDER BY position, created_at LIMIT 1)",
    );
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("NO_PIPELINE");
    expect((await h.queryAll("SELECT 1 FROM instagram_accounts")).length).toBe(0);
  });
});

describe("whose account it is", () => {
  beforeEach(async () => void (await switchTo(true)));

  it("an admin sets the owner and whether new people become leads", async () => {
    const [a] = await connect();
    const r = await (
      await as(admin)
    ).inject({
      method: "PATCH",
      url: `/api/v1/instagram/accounts/${a!.id}`,
      payload: { ownerId: rep.id, newDmCreatesLead: false },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().accounts[0]).toMatchObject({ owner: { id: rep.id }, newDmCreatesLead: false });
  });

  it("never someone who doesn't use LUME now", async () => {
    const [a] = await connect();
    const gone = await h.seedUser({ status: "disabled" });
    const r = await (
      await as(admin)
    ).inject({
      method: "PATCH",
      url: `/api/v1/instagram/accounts/${a!.id}`,
      payload: { ownerId: gone.id },
    });
    expect(r.json().error.code).toBe("OWNER_INVALID");
  });
});

describe("disconnecting", () => {
  beforeEach(async () => void (await switchTo(true)));

  it("unsubscribes at Meta, tells the relay, drops the token and Not a lead yet, keeps leads' history", async () => {
    ig.tokens.set("IGQlong-account-token", fakeAccount());
    ig.subscriptions.set(ACCT, ["messages"]);
    const [a] = await connect();
    await h.queryAll(
      "INSERT INTO instagram_threads (id, account_id, igsid) VALUES (gen_random_uuid(), $1, '6512000000000009')",
      [a!.id],
    );
    const lead = await h.seedLead({ ownerId: admin.id });
    await h.queryAll(
      "INSERT INTO instagram_threads (id, account_id, igsid, lead_id) VALUES (gen_random_uuid(), $1, '6512000000000008', $2)",
      [a!.id, lead],
    );
    const r = await (
      await as(admin)
    ).inject({ method: "DELETE", url: `/api/v1/instagram/accounts/${a!.id}` });
    expect(r.statusCode).toBe(200);
    expect(r.json().accounts).toEqual([]);
    expect(ig.subscriptions.has(ACCT)).toBe(false);
    expect(forgot).toEqual([{ auth: `Bearer ${RELAY_TOKEN}`, body: { accountId: ACCT } }]);
    const left = await h.queryAll<{ lead_id: string | null }>("SELECT lead_id FROM instagram_threads");
    expect(left).toEqual([{ lead_id: lead }]);
    const [row] = await h.queryAll<{ status: string; token_enc: Buffer | null }>(
      "SELECT status, token_enc FROM instagram_accounts",
    );
    expect(row).toEqual({ status: "disconnected", token_enc: null });
    const [src] = await h.queryAll<{ status: string }>("SELECT status FROM lead_sources WHERE id = $1", [
      a!.sourceId,
    ]);
    expect(src!.status).toBe("paused");
  });

  it("still disconnects when Meta refuses the token", async () => {
    const [a] = await connect();
    // The fake doesn't know this token: Meta answers 190.
    const r = await (
      await as(admin)
    ).inject({ method: "DELETE", url: `/api/v1/instagram/accounts/${a!.id}` });
    expect(r.statusCode).toBe(200);
    expect(r.json().accounts).toEqual([]);
  });

  it("an account that isn't connected answers 404", async () => {
    const r = await (
      await as(admin)
    ).inject({
      method: "DELETE",
      url: "/api/v1/instagram/accounts/0190e0c0-0000-7000-8000-000000000999",
    });
    expect(r.statusCode).toBe(404);
  });
});

describe("what the relay asks", () => {
  beforeEach(async () => void (await switchTo(true)));

  it("the accounts this LUME holds, only to the relay", async () => {
    await connect();
    const r = await fromRelay("GET", "/instagram/accounts");
    expect(r.json()).toEqual({ accountIds: [ACCT] });
    expect((await h.app.inject({ method: "GET", url: "/instagram/accounts" })).statusCode).toBe(401);
  });

  it("an account connected to another LUME stops here, and admins hear once", async () => {
    await connect();
    const r = await fromRelay("POST", "/instagram/moved", { accountId: ACCT });
    expect(r.json()).toEqual({ moved: true });
    expect((await fromRelay("POST", "/instagram/moved", { accountId: ACCT })).json()).toEqual({
      moved: false,
    });
    const [row] = await h.queryAll<{ status: string; token_enc: Buffer | null; problem: string }>(
      "SELECT status, token_enc, problem FROM instagram_accounts",
    );
    expect(row).toEqual({ status: "disconnected", token_enc: null, problem: "Connected to another LUME" });
    const notes = await systemAlerts();
    expect(notes.map((n) => n.user_id).sort()).toEqual([admin.id, admin2.id].sort());
    expect(notes[0]!.title).toBe("Instagram @harbour.studio was connected to another LUME");
  });

  it("refuses an unsigned or badly formed move", async () => {
    expect(
      (await h.app.inject({ method: "POST", url: "/instagram/moved", payload: { accountId: ACCT } }))
        .statusCode,
    ).toBe(401);
    expect((await fromRelay("POST", "/instagram/moved", { accountId: "nope" })).statusCode).toBe(400);
  });
});

describe("the token's refresh", () => {
  beforeEach(async () => void (await switchTo(true)));
  const sweep = () =>
    sweepInstagramTokens(h.ownerPool, {
      keyring: h.keyring,
      clock: () => h.clock.now,
      graph: { graphUrl: ig.graphUrl, version: ig.version },
    });
  const age = (ms: number) =>
    h.ownerPool.query("UPDATE instagram_accounts SET token_at = $1", [new Date(h.clock.now.getTime() - ms)]);

  it("leaves a token under 30 days old alone", async () => {
    ig.tokens.set("IGQlong-account-token", fakeAccount());
    await connect();
    await age(IG_TOKEN_REFRESH_MS - 60_000);
    expect(await sweep()).toEqual({ refreshed: 0, revoked: 0 });
    expect(ig.calls.filter((c) => c.path === "/refresh_access_token")).toHaveLength(0);
  });

  it("refreshes one at 30 days and keeps the new token", async () => {
    ig.tokens.set("IGQlong-account-token", fakeAccount());
    await connect();
    await age(IG_TOKEN_REFRESH_MS);
    const before = (await h.queryAll<{ token_enc: Buffer }>("SELECT token_enc FROM instagram_accounts"))[0]!;
    expect(await sweep()).toEqual({ refreshed: 1, revoked: 0 });
    const after = (
      await h.queryAll<{ token_enc: Buffer; token_at: Date }>(
        "SELECT token_enc, token_at FROM instagram_accounts",
      )
    )[0]!;
    expect(after.token_enc.equals(before.token_enc)).toBe(false);
    expect(after.token_at.getTime()).toBe(h.clock.now.getTime());
  });

  it("a token Meta refuses: needs attention, and admins hear once however often it runs", async () => {
    await connect();
    await age(IG_TOKEN_REFRESH_MS);
    expect(await sweep()).toEqual({ refreshed: 0, revoked: 1 });
    expect(await sweep()).toEqual({ refreshed: 0, revoked: 0 });
    const [row] = await h.queryAll<{ status: string }>("SELECT status FROM instagram_accounts");
    expect(row!.status).toBe("needs_attention");
    const notes = await systemAlerts();
    expect(notes).toHaveLength(2);
    expect(notes[0]!.title).toBe("Instagram @harbour.studio needs connecting again");
  });

  it("Meta down leaves the token for the next run", async () => {
    ig.tokens.set("IGQlong-account-token", fakeAccount());
    await connect();
    await age(IG_TOKEN_REFRESH_MS);
    ig.failPaths.add("/refresh_access_token");
    expect(await sweep()).toEqual({ refreshed: 0, revoked: 0 });
    ig.failPaths.clear();
    const [row] = await h.queryAll<{ status: string }>("SELECT status FROM instagram_accounts");
    expect(row!.status).toBe("active");
  });
});
