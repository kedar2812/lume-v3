import { ALL_GRANTS, instanceIdOf, seal, sign, verify } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

/** Live sheets (2026-11-14): connecting a Google account through the relay, for live sheets only. */
const RELAY_TOKEN = "k".repeat(40);
let h: Harness;
let me: SeededUser;
let admin: AuthedClient;
let other: AuthedClient;
let noLive: AuthedClient;

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true, oauth: { relayToken: RELAY_TOKEN } });
  h.setRelayUrl("http://relay.test");
  me = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  admin = await h.signIn(me);
  other = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  noLive = await h.signIn(
    await h.seedUser({ grants: ALL_GRANTS.filter((g) => g.key !== "leads.live_sheets"), totp: true }),
  );
  expect((await call(admin, "PUT", "/api/v1/integrations/google-sheets", { enabled: true })).statusCode).toBe(
    200,
  );
});
afterAll(async () => h.close());

const call = (c: AuthedClient, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  c.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

async function handBack(
  c: AuthedClient,
  o: { kind?: "live_sheet" | "calendar"; exp?: number; email?: string; token?: string } = {},
) {
  const r = await call(c, "POST", "/api/v1/live-sheets/connect");
  expect(r.statusCode, r.body).toBe(200);
  const nonce = new URL(r.json().url).searchParams.get("n")!;
  const p = seal(RELAY_TOKEN, {
    nonce,
    refreshToken: o.token ?? "rt-ok-live",
    kind: o.kind ?? "live_sheet",
    email: o.email ?? "maya@business.test",
    exp: o.exp ?? Date.now() + 60_000,
  });
  return { p, s: sign(RELAY_TOKEN, p) };
}

describe("connecting Google for live sheets", () => {
  it("starts at the relay with a signed live_sheet link", async () => {
    const { url } = (await call(admin, "POST", "/api/v1/live-sheets/connect")).json();
    const u = new URL(url);
    expect(u.pathname).toBe("/start");
    expect(u.searchParams.get("i")).toBe(instanceIdOf(RELAY_TOKEN));
    expect(u.searchParams.get("k")).toBe("live_sheet");
    const n = u.searchParams.get("n")!;
    expect(verify(RELAY_TOKEN, `${n}.live_sheet`, u.searchParams.get("s")!)).toBe(true);
  });

  it("completes once into the person's own Google account; the second time is refused in words", async () => {
    const back = await handBack(admin);
    const r = await call(admin, "POST", "/api/v1/live-sheets/connect/complete", back);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().grant).toMatchObject({ email: "maya@business.test" });
    const again = await call(admin, "POST", "/api/v1/live-sheets/connect/complete", back);
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("CONNECT_NOT_FOUND");
    // The sealed refresh token is kept, never the plain one.
    const c = await h.ownerPool.connect();
    let rows: { grant_enc: Buffer }[];
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('lume.live_sheets_sweep', 'on', true)");
      rows = (await c.query("SELECT grant_enc FROM live_sheet_grants")).rows;
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => !String(x.grant_enc).includes("rt-ok-live"))).toBe(true);
  });

  it("the same Google account again is one account, its grant renewed", async () => {
    const before = (await call(admin, "GET", "/api/v1/live-sheets/grants")).json().grants.length;
    await call(
      admin,
      "POST",
      "/api/v1/live-sheets/connect/complete",
      await handBack(admin, { token: "rt-ok-live2" }),
    );
    const after = (await call(admin, "GET", "/api/v1/live-sheets/grants")).json().grants;
    expect(after).toHaveLength(before);
    expect(after.map((g: { email: string }) => g.email)).toContain("maya@business.test");
  });

  it("someone else's hand-back, an expired one, and a calendar's are each refused", async () => {
    const mine = await handBack(admin);
    expect((await call(other, "POST", "/api/v1/live-sheets/connect/complete", mine)).json().error.code).toBe(
      "CONNECT_NOT_FOUND",
    );
    const old = await handBack(admin, { exp: Date.now() - 1 });
    expect((await call(admin, "POST", "/api/v1/live-sheets/connect/complete", old)).json().error.code).toBe(
      "CONNECT_EXPIRED",
    );
    const cal = await handBack(admin, { kind: "calendar" });
    expect((await call(admin, "POST", "/api/v1/live-sheets/connect/complete", cal)).json().error.code).toBe(
      "CONNECT_INVALID",
    );
    const forged = { ...(await handBack(admin)), s: "nope" };
    expect(
      (await call(admin, "POST", "/api/v1/live-sheets/connect/complete", forged)).json().error.code,
    ).toBe("CONNECT_INVALID");
  });

  it("each person sees only their own Google accounts", async () => {
    expect((await call(other, "GET", "/api/v1/live-sheets/grants")).json().grants).toEqual([]);
    expect((await call(admin, "GET", "/api/v1/live-sheets/grants")).json().grants.length).toBeGreaterThan(0);
  });

  it("only for people who may make live sheets", async () => {
    expect((await call(noLive, "POST", "/api/v1/live-sheets/connect")).statusCode).toBe(403);
  });
});
