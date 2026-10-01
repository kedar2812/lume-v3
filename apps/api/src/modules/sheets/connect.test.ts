import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALL_GRANTS, instanceIdOf, newId, seal, sign, verify } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelay } from "../../../../connect/src/relay";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { openConfig } from "./config";

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

  it("a sheet's hand-back can't finish a calendar's connect (5A)", async () => {
    await call(admin, "PUT", "/api/v1/integrations/google-calendar", { enabled: true });
    const { url } = (await call(admin, "POST", "/api/v1/calendar/connect")).json();
    const p = seal(RELAY_TOKEN, {
      nonce: new URL(url).searchParams.get("n")!,
      refreshToken: "rt-good",
      file: { id: "any-file", name: "Any" },
      exp: Date.now() + 60_000,
    });
    expect(
      (
        await call(admin, "POST", "/api/v1/integrations/google/complete", { p, s: sign(RELAY_TOKEN, p) })
      ).json().error.code,
    ).toBe("CONNECT_NOT_FOUND");
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

  /** A fresh hand-back for a new connect of the admin's, and its picked spreadsheet. */
  async function handBack() {
    const { url } = (await call(admin, "POST", "/api/v1/integrations/google/connect")).json();
    const nonce = new URL(url).searchParams.get("n")!;
    const spreadsheetId = `picked-${newId()}`;
    h.fake!.put(spreadsheetId, {
      title: "Picked",
      sharedWith: [],
      tabs: [{ sheetId: 3, title: "Leads", rows: [["Name", "Phone"]] }],
    });
    const p = seal(RELAY_TOKEN, {
      nonce,
      refreshToken: "rt-good",
      file: { id: spreadsheetId, name: "Picked" },
      exp: Date.now() + 60_000,
    });
    return { p, s: sign(RELAY_TOKEN, p) };
  }

  it("two tabs completing the same hand-back at once: exactly one wins", async () => {
    const b = await handBack();
    const [x, y] = await Promise.all([
      call(admin, "POST", "/api/v1/integrations/google/complete", b),
      call(admin, "POST", "/api/v1/integrations/google/complete", b),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 404]);
  });

  it("a removed sheet connected with Google keeps no grant", async () => {
    const done = (await call(admin, "POST", "/api/v1/integrations/google/complete", await handBack())).json();
    const d = (
      await call(admin, "POST", "/api/v1/sheets/drafts", { connectId: done.connectId, sheetId: 3 })
    ).json();
    const saved = (
      await call(admin, "POST", "/api/v1/sheets/sources", {
        importId: d.draft.id,
        name: "Picked to remove",
        pollSeconds: 120,
        startFrom: "all",
      })
    ).json();
    const sealed = async () =>
      openConfig(
        h.keyring,
        saved.id,
        (
          await h.queryAll<{ config_enc: Buffer }>("SELECT config_enc FROM lead_sources WHERE id = $1", [
            saved.id,
          ])
        )[0]!.config_enc,
      );
    expect((await sealed()).grant).toBe("rt-good");
    await admin.inject({ method: "DELETE", url: `/api/v1/sheets/sources/${saved.id}` });
    expect((await sealed()).grant).toBeUndefined();
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

  describe("after connecting (final review)", () => {
    /** Start a connect (optionally for an existing sheet) and complete it with a hand-back for this file. */
    async function connectFile(fileId: string, body?: { sourceId: string }) {
      const { url } = (await call(admin, "POST", "/api/v1/integrations/google/connect", body)).json();
      const nonce = new URL(url).searchParams.get("n")!;
      const p = seal(RELAY_TOKEN, {
        nonce,
        refreshToken: "rt-good",
        file: { id: fileId, name: "Picked" },
        exp: Date.now() + 60_000,
      });
      return call(admin, "POST", "/api/v1/integrations/google/complete", { p, s: sign(RELAY_TOKEN, p) });
    }
    const pickable = () => {
      const id = `picked-${newId()}`;
      h.fake!.put(id, {
        title: "Picked",
        sharedWith: [],
        tabs: [
          {
            sheetId: 3,
            title: "Leads",
            rows: [
              ["Name", "Phone"],
              ["Picked Again", "0507123888"],
            ],
          },
          { sheetId: 4, title: "Other", rows: [["Name"]] },
        ],
      });
      return id;
    };

    it("a picked file can be drafted again after going back a step (Important 2)", async () => {
      const done = (await connectFile(pickable())).json();
      expect(
        (await call(admin, "POST", "/api/v1/sheets/drafts", { connectId: done.connectId, sheetId: 4 }))
          .statusCode,
      ).toBe(201);
      const d = await call(admin, "POST", "/api/v1/sheets/drafts", { connectId: done.connectId, sheetId: 3 });
      expect(d.statusCode).toBe(201);
      await call(admin, "POST", "/api/v1/sheets/sources", {
        importId: d.json().draft.id,
        name: "Picked again",
        pollSeconds: 120,
        startFrom: "all",
      });
      expect(await h.queryAll("SELECT 1 FROM oauth_connects WHERE id = $1", [done.connectId])).toHaveLength(
        0,
      );
    });

    it("Connect again gives a sheet whose access was removed a new grant, for the same file only (Important 1)", async () => {
      const fileId = pickable();
      const done = (await connectFile(fileId)).json();
      const d = (
        await call(admin, "POST", "/api/v1/sheets/drafts", { connectId: done.connectId, sheetId: 3 })
      ).json();
      const s = (
        await call(admin, "POST", "/api/v1/sheets/sources", {
          importId: d.draft.id,
          name: "Reconnect me",
          pollSeconds: 120,
          startFrom: "all",
        })
      ).json();
      await h.runSyncs();
      h.fake!.revokeGrant();
      await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`);
      await h.runSyncs();
      const paused = (await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json();
      expect(paused).toMatchObject({
        status: "needs_attention",
        auth: "oauth",
        attention: { code: "ACCESS_LOST" },
      });
      h.fake!.restoreGrant();
      const wrong = await connectFile(pickable(), { sourceId: s.id });
      expect(wrong.json().error.code).toBe("CONNECT_WRONG_FILE");
      const again = await connectFile(fileId, { sourceId: s.id });
      expect(again.json()).toMatchObject({ reconnected: s.id });
      expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({
        status: "active",
        attention: null,
      });
    });
  });
});
