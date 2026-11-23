import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { instanceIdOf, relayCheck, sign, unseal, verify, type Handoff } from "@lume/core";
import { igComment, igDm } from "../../../packages/core/src/instagram/fixtures";
import {
  ALL_PERMISSIONS,
  fakeAccount,
  startInstagramFake,
  type InstagramFake,
} from "../../api/test/instagram-fake";
import { READING_MAX } from "./body";
import { HOLD_MS, IG_FIELDS } from "./instagram";
import { createRelay, type Relay } from "./relay";
import { createRouteStore, type RouteStore } from "./routes-store";

/** Instagram through the relay (NEW_FEATURES_PLAN §4.2; plan 1A Task 2). Two client LUMEs, A and B. */
const TOKEN_A = "a".repeat(40);
const TOKEN_B = "b".repeat(40);
const A = instanceIdOf(TOKEN_A);
const B = instanceIdOf(TOKEN_B);
const ACCT_A = "17841400000000001";
const ACCT_B = "17841400000000002";

type Got = { path: string; headers: http.IncomingHttpHeaders; raw: Buffer };
type Fake = {
  server: http.Server;
  url: string;
  got: Got[];
  status: number;
  accounts: { id: string; grant: string }[] | null;
};
/** What the relay signs at connect for an account on a LUME (its secret is the test's). */
const grantFor = (accountId: string, instanceId: string) =>
  sign("s".repeat(40), `instagram-grant.${accountId}.${instanceId}`);
const listen = async (s: http.Server) => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
async function fakeInstance(): Promise<Fake> {
  const f = { got: [], status: 200, accounts: [] } as unknown as Fake;
  f.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      f.got.push({ path: req.url ?? "", headers: req.headers, raw: Buffer.concat(chunks) });
      if (req.url === "/instagram/accounts") {
        if (f.accounts === null) {
          res.writeHead(503);
          return res.end();
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ accounts: f.accounts }));
      }
      res.writeHead(f.status);
      res.end();
    });
  });
  f.url = await listen(f.server);
  return f;
}

let ig: InstagramFake;
let a: Fake;
let b: Fake;
let dir: string;
let routes: RouteStore;
let relay: Relay;
let server: http.Server;
let base: string;
let clock = Date.parse("2026-11-22T06:00:00Z");

beforeAll(async () => {
  ig = await startInstagramFake();
  a = await fakeInstance();
  b = await fakeInstance();
});
afterAll(async () => {
  await ig.close();
  a.server.close();
  b.server.close();
});
beforeEach(async () => {
  clock = Date.parse("2026-11-22T06:00:00Z");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-relay-"));
  routes = createRouteStore(path.join(dir, "routes.json"), () => clock);
  relay = createRelay({
    publicUrl: "http://relay.test",
    clientId: "cid",
    clientSecret: "csecret",
    pickerKey: "pkey",
    appId: "123",
    secret: "s".repeat(40),
    instances: [
      { url: a.url, token: TOKEN_A },
      { url: b.url, token: TOKEN_B },
    ],
    instagram: {
      appId: ig.appId,
      appSecret: ig.appSecret,
      verifyToken: ig.verifyToken,
      oauthUrl: ig.oauthUrl,
      tokenUrl: ig.tokenUrl,
      graphUrl: ig.graphUrl,
      version: ig.version,
    },
    instagramRoutes: routes,
    now: () => clock,
  });
  server = http.createServer(relay);
  base = await listen(server);
  for (const f of [a, b]) {
    f.got = [];
    f.status = 200;
    f.accounts = [];
  }
  ig.failPaths.clear();
  ig.subscriptions.clear();
});
afterEach(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const startUrl = (token: string, nonce = "nonce-1", kind = "instagram") =>
  `${base}/ig/start?${new URLSearchParams({ i: instanceIdOf(token), n: nonce, s: sign(token, `${nonce}.${kind}`) })}`;

/** Sign in as the person would: start, then come back from Instagram with a code. */
async function connect(
  token: string,
  o: { account?: ReturnType<typeof fakeAccount>; permissions?: string[] } = {},
) {
  const r = await fetch(startUrl(token), { redirect: "manual" });
  expect(r.status).toBe(302);
  const to = new URL(r.headers.get("location")!);
  const code = `code-${Math.random().toString(36).slice(2)}`;
  ig.codes.set(code, { account: o.account ?? fakeAccount(), permissions: o.permissions ?? ALL_PERMISSIONS });
  return fetch(`${base}/ig/callback?${new URLSearchParams({ code, state: to.searchParams.get("state")! })}`, {
    redirect: "manual",
    headers: { cookie: browserOf(r) },
  });
}
/** The cookie the start set, as the same browser sends it back. */
const browserOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;
const handoffOf = (r: Response, token: string) => {
  const to = new URL(r.headers.get("location")!);
  const p = to.searchParams.get("p")!;
  expect(verify(token, p, to.searchParams.get("s")!)).toBe(true);
  return { path: to.pathname, origin: to.origin, h: unseal<Handoff>(token, p) };
};

describe("connecting an account", () => {
  it("start sends the person to Instagram with LUME's app, scopes and a state", async () => {
    const r = await fetch(startUrl(TOKEN_A), { redirect: "manual" });
    const to = new URL(r.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(ig.oauthUrl);
    expect(to.searchParams.get("client_id")).toBe(ig.appId);
    expect(to.searchParams.get("redirect_uri")).toBe("http://relay.test/ig/callback");
    expect(to.searchParams.get("scope")).toBe(ALL_PERMISSIONS.join(","));
    expect(to.searchParams.get("response_type")).toBe("code");
  });

  it("start refuses a bad signature, another kind's signature and an unknown instance", async () => {
    const bad = startUrl(TOKEN_A).replace(/s=[^&]+/, "s=forged");
    expect((await fetch(bad, { redirect: "manual" })).status).toBe(400);
    expect((await fetch(startUrl(TOKEN_A, "n1", "whatsapp"), { redirect: "manual" })).status).toBe(400);
    expect((await fetch(startUrl("z".repeat(40)), { redirect: "manual" })).status).toBe(400);
  });

  it("the callback hands A its account sealed for A only, subscribed to exactly LUME's fields", async () => {
    const r = await connect(TOKEN_A);
    expect(r.status).toBe(302);
    const { path: p, origin, h } = handoffOf(r, TOKEN_A);
    expect(origin).toBe(a.url);
    expect(p).toBe("/settings/integrations/instagram/connected");
    expect(h).toMatchObject({
      kind: "instagram",
      nonce: "nonce-1",
      instagram: {
        userId: ACCT_A,
        username: "harbour.studio",
        name: "Harbour Studio",
        accountType: "BUSINESS",
      },
    });
    expect(h!.instagram!.token).toMatch(/^IGQlong/);
    expect(unseal(TOKEN_B, new URL(r.headers.get("location")!).searchParams.get("p")!)).toBeNull();
    expect(ig.subscriptions.get(ACCT_A)).toEqual(IG_FIELDS);
    expect(routes.get(ACCT_A)).toBe(A);
  });

  it("a cancelled sign-in, an expired state or no code says so in words and routes nothing", async () => {
    const r = await fetch(startUrl(TOKEN_A), { redirect: "manual" });
    const state = new URL(r.headers.get("location")!).searchParams.get("state")!;
    const cookie = { headers: { cookie: browserOf(r) } };
    const denied = await fetch(
      `${base}/ig/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      cookie,
    );
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("cancelled");
    expect((await fetch(`${base}/ig/callback?state=${encodeURIComponent(state)}`, cookie)).status).toBe(400);
    clock += 11 * 60_000;
    expect(
      (await fetch(`${base}/ig/callback?code=x&state=${encodeURIComponent(state)}`, cookie)).status,
    ).toBe(400);
    expect(routes.size()).toBe(0);
  });

  it("only the browser that started can finish: a state taken elsewhere routes nothing and hands back nothing", async () => {
    const r = await fetch(startUrl(TOKEN_A), { redirect: "manual" });
    expect(r.headers.get("set-cookie")).toMatch(
      /^lume_ig_[\w-]{16}=[\w-]+; Path=\/ig\/; Max-Age=600; HttpOnly; SameSite=Lax$/,
    );
    const state = new URL(r.headers.get("location")!).searchParams.get("state")!;
    const code = "code-elsewhere";
    ig.codes.set(code, { account: fakeAccount(), permissions: ALL_PERMISSIONS });
    const url = `${base}/ig/callback?${new URLSearchParams({ code, state })}`;
    const others: Record<string, string>[] = [
      {},
      { cookie: `${browserOf(r).split("=")[0]}=someone-elses` },
      { cookie: browserOf(r).replace(/.$/, "x") },
    ];
    for (const headers of others) {
      const elsewhere = await fetch(url, { redirect: "manual", headers });
      expect(elsewhere.status).toBe(400);
      expect(await elsewhere.text()).toContain("another browser");
    }
    expect(routes.size()).toBe(0);
    expect(ig.subscriptions.size).toBe(0);
  });

  it.each([["/oauth/access_token"], ["/access_token"], ["/me"], ["/subscribed_apps"]])(
    "Instagram failing at %s: words, no route, no hand-back",
    async (step) => {
      ig.failPaths.add(step);
      const r = await connect(TOKEN_A);
      expect(r.status).toBe(400);
      expect(r.headers.get("location")).toBeNull();
      expect(await r.text()).toContain("Connect again");
      expect(routes.size()).toBe(0);
    },
  );

  it("a permission left off is refused with what LUME needs", async () => {
    const r = await connect(TOKEN_A, { permissions: ["instagram_business_basic"] });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("leave them all on");
    expect(ig.subscriptions.size).toBe(0);
  });

  it("a personal account is refused in words", async () => {
    const r = await connect(TOKEN_A, { account: fakeAccount({ accountType: "PERSONAL" }) });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("professional account");
  });

  it("connecting on B an account A holds moves it, and A is told", async () => {
    await connect(TOKEN_A);
    a.got = [];
    const r = await connect(TOKEN_B);
    expect(handoffOf(r, TOKEN_B).origin).toBe(b.url);
    expect(routes.get(ACCT_A)).toBe(B);
    await new Promise((res) => setTimeout(res, 100));
    const moved = a.got.find((g) => g.path === "/instagram/moved");
    expect(moved).toBeTruthy();
    expect(JSON.parse(moved!.raw.toString())).toEqual({ accountId: ACCT_A });
  });
});

describe("passing Meta's deliveries on", () => {
  beforeEach(() => {
    routes.set(ACCT_A, A);
    routes.set(ACCT_B, B);
  });
  const batch = () => ({
    object: "instagram",
    entry: [igDm().entry[0], igDm({ account: ACCT_B, mid: "aWdfB1" }).entry[0], igComment().entry[0]],
  });

  it("each LUME gets only its own accounts' entries, signed with its own token", async () => {
    const r = await ig.deliver(`${base}/ig/in`, batch());
    expect(r.status).toBe(200);
    const [ga] = a.got;
    const [gb] = b.got;
    expect(a.got).toHaveLength(1);
    expect(b.got).toHaveLength(1);
    const ts = (g: Got) => String(g.headers["x-lume-timestamp"]);
    const sig = (g: Got) => String(g.headers["x-lume-signature"]);
    expect(relayCheck(TOKEN_A, ts(ga!), sig(ga!), ga!.raw, clock)).toBe("ok");
    expect(relayCheck(TOKEN_B, ts(gb!), sig(gb!), gb!.raw, clock)).toBe("ok");
    expect(relayCheck(TOKEN_B, ts(ga!), sig(ga!), ga!.raw, clock)).toBe("bad");
    const ids = (g: Got) =>
      (JSON.parse(g.raw.toString()) as { entry: { id: string }[] }).entry.map((e) => e.id);
    expect(ids(ga!)).toEqual([ACCT_A, ACCT_A]);
    expect(ids(gb!)).toEqual([ACCT_B]);
    expect(ga!.path).toBe("/instagram/in");
  });

  it("an account no LUME holds is dropped, and Meta still hears 200", async () => {
    const r = await ig.deliver(`${base}/ig/in`, igDm({ account: "17841499999999999" }));
    expect(r.status).toBe(200);
    expect(a.got.length + b.got.length).toBe(0);
  });

  it("a delivery Meta didn't sign is refused and goes nowhere", async () => {
    const r = await ig.deliver(`${base}/ig/in`, batch(), { secret: "not-the-secret-at-all" });
    expect(r.status).toBe(401);
    expect(a.got.length + b.got.length).toBe(0);
  });

  it("anything that isn't Instagram's, or isn't JSON, is answered and dropped", async () => {
    expect((await ig.deliver(`${base}/ig/in`, { object: "page", entry: [] })).status).toBe(200);
    expect(a.got.length + b.got.length).toBe(0);
  });

  it("two Connects in one browser (two tabs, two accounts): each finishes, and each cookie goes once used", async () => {
    const one = await fetch(startUrl(TOKEN_A, "nonce-one"), { redirect: "manual" });
    const two = await fetch(startUrl(TOKEN_A, "nonce-two"), { redirect: "manual" });
    const jar = [browserOf(one), browserOf(two)].join("; ");
    for (const [r, account] of [
      [one, fakeAccount()],
      [two, fakeAccount({ userId: "17841400000000777", username: "second.account" })],
    ] as const) {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      ig.codes.set(code, { account, permissions: ALL_PERMISSIONS });
      const state = new URL(r.headers.get("location")!).searchParams.get("state")!;
      const back = await fetch(`${base}/ig/callback?${new URLSearchParams({ code, state })}`, {
        redirect: "manual",
        headers: { cookie: jar },
      });
      expect(back.status).toBe(302);
      expect(back.headers.get("set-cookie")).toContain(
        `${browserOf(r).split("=")[0]}=; Path=/ig/; Max-Age=0`,
      );
    }
    expect(routes.get(ACCT_A)).toBe(A);
    expect(routes.get("17841400000000777")).toBe(A);
  });

  it("too many deliveries arriving at once: the next is told to try again (Meta does), never held", async () => {
    const held = Array.from({ length: READING_MAX }, () => {
      const req = http.request(`${base}/ig/in`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "100" },
      });
      req.on("error", () => undefined);
      req.write("{");
      return req;
    });
    await new Promise((r) => setTimeout(r, 150));
    const r = await ig.deliver(`${base}/ig/in`, batch());
    expect(r.status).toBe(503);
    for (const req of held) req.destroy();
  });

  it("a body over 3 MB is refused", async () => {
    const r = await ig.deliver(`${base}/ig/in`, { object: "instagram", pad: "x".repeat(3 * 1024 * 1024) });
    expect(r.status).toBe(413);
  });

  it("B down for less than 15 minutes: Meta is asked to retry, A still gets its part", async () => {
    b.status = 503;
    const r = await ig.deliver(`${base}/ig/in`, batch());
    expect(r.status).toBe(503);
    expect(a.got).toHaveLength(1);
    expect(routes.notesFor(B)).toEqual([]);
  });

  it("B down for 15 minutes or more: Meta hears 200 and B gets a gap note, never A's", async () => {
    b.status = 503;
    await ig.deliver(`${base}/ig/in`, batch());
    clock += HOLD_MS;
    const r = await ig.deliver(`${base}/ig/in`, batch());
    expect(r.status).toBe(200);
    expect(routes.notesFor(B)).toEqual([
      expect.objectContaining({ kind: "gap", accountIds: [ACCT_B], to: clock }),
    ]);
    expect(routes.notesFor(A)).toEqual([]);
  });

  it("B back after a short outage: its streak ends", async () => {
    b.status = 503;
    await ig.deliver(`${base}/ig/in`, batch());
    b.status = 200;
    clock += 60_000;
    expect((await ig.deliver(`${base}/ig/in`, batch())).status).toBe(200);
    b.status = 503;
    clock += HOLD_MS - 1;
    // A new streak started now: still held for Meta's retry, no gap.
    expect((await ig.deliver(`${base}/ig/in`, batch())).status).toBe(503);
    expect(routes.notesFor(B)).toEqual([]);
  });

  it("answers Meta's handshake only with the verify token", async () => {
    const ok = await fetch(
      `${base}/ig/in?hub.mode=subscribe&hub.verify_token=${ig.verifyToken}&hub.challenge=12345`,
    );
    expect(await ok.text()).toBe("12345");
    const bad = await fetch(`${base}/ig/in?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
    expect(bad.status).toBe(403);
  });
});

describe("an instance's own calls", () => {
  const as = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  it("forget drops only the asking instance's own account", async () => {
    routes.set(ACCT_A, A);
    const byB = await fetch(`${base}/ig/forget`, {
      method: "POST",
      headers: as(TOKEN_B),
      body: JSON.stringify({ accountId: ACCT_A }),
    });
    expect(await byB.json()).toEqual({ dropped: false });
    expect(routes.get(ACCT_A)).toBe(A);
    const byA = await fetch(`${base}/ig/forget`, {
      method: "POST",
      headers: as(TOKEN_A),
      body: JSON.stringify({ accountId: ACCT_A }),
    });
    expect(await byA.json()).toEqual({ dropped: true });
    const stranger = await fetch(`${base}/ig/forget`, {
      method: "POST",
      headers: as("z".repeat(40)),
      body: JSON.stringify({ accountId: ACCT_A }),
    });
    expect(stranger.status).toBe(401);
  });

  it("notes: each instance reads and clears only its own", async () => {
    routes.gap(A, [ACCT_A], 1, 2);
    routes.note(B, { kind: "delete", userId: ACCT_B });
    const listA = (await (await fetch(`${base}/ig/notes`, { headers: as(TOKEN_A) })).json()) as {
      notes: { id: string; kind: string }[];
    };
    expect(listA.notes.map((n) => n.kind)).toEqual(["gap"]);
    const bId = routes.notesFor(B)[0]!.id;
    const clearByA = await fetch(`${base}/ig/notes/clear`, {
      method: "POST",
      headers: as(TOKEN_A),
      body: JSON.stringify({ ids: [bId] }),
    });
    expect(await clearByA.json()).toEqual({ cleared: 0 });
    expect(routes.notesFor(B)).toHaveLength(1);
    expect((await fetch(`${base}/ig/notes`, { headers: as("z".repeat(40)) })).status).toBe(401);
  });
});

describe("Meta's deauthorize and data deletion requests", () => {
  beforeEach(() => routes.set(ACCT_A, A));
  const post = (p: string, sr: string) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ signed_request: sr }),
    });

  it("a deletion request becomes a note for the account's LUME, and Meta gets a confirmation", async () => {
    const r = await post("/ig/delete", ig.signedRequest(ACCT_A));
    const body = (await r.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toMatch(/^[\w-]{8,}$/);
    expect(body.url).toContain(body.confirmation_code);
    expect(routes.notesFor(A)).toEqual([expect.objectContaining({ kind: "delete", userId: ACCT_A })]);
    expect(routes.notesFor(B)).toEqual([]);
    expect((await fetch(body.url.replace("http://relay.test", base))).status).toBe(200);
  });

  it("a deauthorize becomes a note too", async () => {
    expect((await post("/ig/deauthorize", ig.signedRequest(ACCT_A))).status).toBe(200);
    expect(routes.notesFor(A)[0]).toMatchObject({ kind: "deauthorize", userId: ACCT_A });
  });

  it("a request after the account was disconnected still reaches the LUME that held it", async () => {
    routes.drop(ACCT_A, A);
    await post("/ig/delete", ig.signedRequest(ACCT_A));
    expect(routes.notesFor(A)).toEqual([expect.objectContaining({ kind: "delete", userId: ACCT_A })]);
  });

  it("after a move, both the old and the new LUME get it", async () => {
    routes.set(ACCT_A, B);
    await post("/ig/delete", ig.signedRequest(ACCT_A));
    expect(routes.notesFor(A)).toHaveLength(1);
    expect(routes.notesFor(B)).toHaveLength(1);
  });

  it("a forged signed_request is refused and noted nowhere", async () => {
    expect((await post("/ig/delete", ig.signedRequest(ACCT_A, { secret: "forged-secret-xyz" }))).status).toBe(
      400,
    );
    expect((await post("/ig/delete", "garbage")).status).toBe(400);
    expect(routes.notesFor(A)).toEqual([]);
  });
});

describe("rebuilding the routing table on start", () => {
  it("a LUME can't claim an account the relay never granted it, even when nobody holds it", async () => {
    a.accounts = [
      { id: ACCT_B, grant: grantFor(ACCT_B, B) }, // B's grant, shown by A
      { id: "17841400000000055", grant: "forged" },
    ];
    b.accounts = [];
    await relay.rebuildInstagram();
    expect(routes.get(ACCT_B)).toBeUndefined();
    expect(routes.get("17841400000000055")).toBeUndefined();
  });

  it("the hand-back carries the grant the rebuild accepts", async () => {
    const r = await connect(TOKEN_A);
    const { h } = handoffOf(r, TOKEN_A);
    routes.drop(ACCT_A, A);
    a.accounts = [{ id: ACCT_A, grant: h!.instagram!.grant }];
    await relay.rebuildInstagram();
    expect(routes.get(ACCT_A)).toBe(A);
  });

  it("takes each LUME's own list, keeps the routes of one that doesn't answer", async () => {
    routes.set("17841400000000077", A);
    routes.set(ACCT_B, B);
    a.accounts = [{ id: ACCT_A, grant: grantFor(ACCT_A, A) }];
    b.accounts = null;
    await relay.rebuildInstagram();
    expect(routes.get(ACCT_A)).toBe(A);
    expect(routes.get("17841400000000077")).toBeUndefined();
    expect(routes.get(ACCT_B)).toBe(B);
    const req = a.got.find((g) => g.path === "/instagram/accounts")!;
    expect(
      relayCheck(
        TOKEN_A,
        String(req.headers["x-lume-timestamp"]),
        String(req.headers["x-lume-signature"]),
        Buffer.alloc(0),
        clock,
      ),
    ).toBe("ok");
  });

  it("never takes an account another LUME already holds", async () => {
    routes.set(ACCT_B, B);
    a.accounts = [
      { id: ACCT_A, grant: grantFor(ACCT_A, A) },
      { id: ACCT_B, grant: grantFor(ACCT_B, A) },
      { id: "not-an-id", grant: "x" },
    ];
    b.accounts = [{ id: ACCT_B, grant: grantFor(ACCT_B, B) }];
    await relay.rebuildInstagram();
    expect(routes.get(ACCT_B)).toBe(B);
    expect(routes.accountsOf(A)).toEqual([ACCT_A]);
  });
});
