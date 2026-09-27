import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALL_GRANTS, instanceIdOf, newId, seal, sign, verify } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelay } from "../../../../connect/src/relay";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

const RELAY_TOKEN = "c".repeat(40);
let h: Harness;
let bare: Harness;
let relay: http.Server;
let relayOrigin: string;
let admin: AuthedClient;
let otherAdmin: AuthedClient;
let bareAdmin: AuthedClient;

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true, oauth: { relayToken: RELAY_TOKEN } });
  bare = await createHarness({ preset: "general" });
  relay = http.createServer(
    createRelay({
      publicUrl: "http://relay.test",
      clientId: "cid",
      clientSecret: "cs",
      pickerKey: "pk",
      appId: "1",
      secret: "s".repeat(40),
      instances: [{ url: "https://lume.test", token: RELAY_TOKEN }],
      googleTokenUrl: `${h.fake!.url}/token`,
    }),
  );
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  relayOrigin = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  h.setRelayUrl(relayOrigin);
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  otherAdmin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  bareAdmin = await bare.signIn(await bare.seedUser({ grants: ALL_GRANTS, totp: true }));
  await call(admin, "PUT", "/api/v1/integrations/google-sheets", { enabled: true });
});
afterAll(async () => {
  relay.close();
  await h.close();
  await bare.close();
});

const call = (c: AuthedClient, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  c.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

describe("Connect with Google (Review Focus 1)", () => {
  it("is offered only where the relay is configured", async () => {
    expect((await call(admin, "GET", "/api/v1/integrations")).json().googleSheets).toMatchObject({
      connectWithGoogle: true,
      available: true,
    });
    // the bare harness (no oauth, no key) offers nothing
    expect((await call(bareAdmin, "GET", "/api/v1/integrations")).json().googleSheets).toMatchObject({
      connectWithGoogle: false,
      available: false,
    });
  });

  it("start gives a relay link signed for this instance; the relay accepts it", async () => {
    const { url } = (await call(admin, "POST", "/api/v1/integrations/google/connect")).json();
    const u = new URL(url);
    expect(u.origin).toBe(relayOrigin);
    expect(u.searchParams.get("i")).toBe(instanceIdOf(RELAY_TOKEN));
    expect(verify(RELAY_TOKEN, u.searchParams.get("n")!, u.searchParams.get("s")!)).toBe(true);
  });

  it("complete takes a genuine hand-back once, for the person who started it, then makes a sheet from the picked file", async () => {
    const { url } = (await call(admin, "POST", "/api/v1/integrations/google/connect")).json();
    const nonce = new URL(url).searchParams.get("n")!;
    const spreadsheetId = `picked-${newId()}`;
    h.fake!.put(spreadsheetId, {
      title: "Picked",
      sharedWith: [],
      tabs: [
        {
          sheetId: 3,
          title: "Leads",
          rows: [
            ["Name", "Phone"],
            ["Picked One", "0507123999"],
          ],
        },
      ],
    });
    const p = seal(RELAY_TOKEN, {
      nonce,
      refreshToken: "rt-good",
      file: { id: spreadsheetId, name: "Picked" },
      exp: Date.now() + 60_000,
    });
    const s = sign(RELAY_TOKEN, p);
    // someone else can't complete it
    expect(
      (await call(otherAdmin, "POST", "/api/v1/integrations/google/complete", { p, s })).json().error.code,
    ).toBe("CONNECT_NOT_FOUND");
    const done = (await call(admin, "POST", "/api/v1/integrations/google/complete", { p, s })).json();
    expect(done).toMatchObject({ file: { id: spreadsheetId, name: "Picked" } });
    // not twice
    expect(
      (await call(admin, "POST", "/api/v1/integrations/google/complete", { p, s })).json().error.code,
    ).toBe("CONNECT_NOT_FOUND");
    const tabs = (await call(admin, "POST", "/api/v1/sheets/inspect", { connectId: done.connectId })).json();
    expect(tabs).toMatchObject({ title: "Picked", tabs: [{ sheetId: 3, title: "Leads" }] });
    const d = (
      await call(admin, "POST", "/api/v1/sheets/drafts", { connectId: done.connectId, sheetId: 3 })
    ).json();
    const saved = (
      await call(admin, "POST", "/api/v1/sheets/sources", {
        importId: d.draft.id,
        name: "Picked",
        pollSeconds: 120,
        startFrom: "all",
      })
    ).json();
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${saved.id}`)).json()).toMatchObject({
      newAllTime: 1,
    });
    expect(await h.queryAll("SELECT 1 FROM oauth_connects WHERE id = $1", [done.connectId])).toHaveLength(0);
  });

  it("refuses a tampered, foreign or expired hand-back", async () => {
    const { url } = (await call(admin, "POST", "/api/v1/integrations/google/connect")).json();
    const nonce = new URL(url).searchParams.get("n")!;
    const good = seal(RELAY_TOKEN, {
      nonce,
      refreshToken: "rt-good",
      file: { id: "x".repeat(20), name: "X" },
      exp: Date.now() + 60_000,
    });
    expect(
      (await call(admin, "POST", "/api/v1/integrations/google/complete", { p: good, s: "bad" })).json().error
        .code,
    ).toBe("CONNECT_INVALID");
    const foreign = seal("f".repeat(40), {
      nonce,
      refreshToken: "rt",
      file: { id: "x".repeat(20), name: "X" },
      exp: Date.now() + 60_000,
    });
    expect(
      (
        await call(admin, "POST", "/api/v1/integrations/google/complete", {
          p: foreign,
          s: sign("f".repeat(40), foreign),
        })
      ).json().error.code,
    ).toBe("CONNECT_INVALID");
    const old = seal(RELAY_TOKEN, {
      nonce,
      refreshToken: "rt",
      file: { id: "x".repeat(20), name: "X" },
      exp: Date.now() - 1,
    });
    expect(
      (
        await call(admin, "POST", "/api/v1/integrations/google/complete", {
          p: old,
          s: sign(RELAY_TOKEN, old),
        })
      ).json().error.code,
    ).toBe("CONNECT_EXPIRED");
  });
});
