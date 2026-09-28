import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALL_GRANTS, DEFAULT_RULES, newId } from "@lume/core";
import { schema } from "@lume/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelay } from "../../../../connect/src/relay";
import { createHarness, type Harness } from "../../../test/harness";
import { sealConfig } from "./config";
import { requestSync } from "./requests";

const RELAY_TOKEN = "r".repeat(40);
let h: Harness;
let relay: http.Server;
let adminId: string;
let refreshes = 0;

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true, oauth: { relayToken: RELAY_TOKEN } });
  const listener = createRelay({
    publicUrl: "http://relay.test",
    clientId: "cid",
    clientSecret: "cs",
    pickerKey: "pk",
    appId: "1",
    secret: "s".repeat(40),
    instances: [{ url: "https://lume.test", token: RELAY_TOKEN }],
    googleTokenUrl: `${h.fake!.url}/token`,
  });
  relay = http.createServer((req, res) => {
    if (req.url === "/refresh") refreshes++;
    listener(req, res);
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  h.setRelayUrl(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);
  adminId = (await h.seedUser({ grants: ALL_GRANTS, totp: true })).id;
});
afterAll(async () => {
  relay.close();
  await h.close();
});

async function source(auth: "service_account" | "oauth", shared: boolean) {
  const spreadsheetId = `ss-${newId()}`;
  h.fake!.put(spreadsheetId, {
    title: "S",
    sharedWith: shared ? [h.fake!.email] : [],
    tabs: [
      {
        sheetId: 0,
        title: "T",
        rows: [
          ["Name", "Phone"],
          ["OAuth Lead " + auth, "0507123" + (auth === "oauth" ? "001" : "002")],
        ],
      },
    ],
  });
  const pipelineId = (await h.queryAll<{ id: string }>("SELECT id FROM pipelines WHERE is_default"))[0]!.id;
  const stageId = (
    await h.queryAll<{ id: string }>(
      "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position LIMIT 1",
      [pipelineId],
    )
  )[0]!.id;
  const id = newId();
  await h.pool.query(
    `INSERT INTO lead_sources (id, type, name, status, config_enc, mapping, rules, headers, run_as)
     VALUES ($1, 'google_sheet', 'S', 'active', $2, $3, $4, '["Name","Phone"]', $5)`,
    [
      id,
      sealConfig(h.keyring, id, {
        spreadsheetId,
        sheetId: 0,
        tabTitle: "T",
        headerRow: 1,
        auth,
        ...(auth === "oauth" ? { grant: "rt-good" } : {}),
      }),
      {
        columns: [
          { column: 0, to: "field", field: "name" },
          { column: 1, to: "field", field: "phone" },
        ],
        createMissingTags: false,
      },
      DEFAULT_RULES({ pipelineId, stageId, country: "AE" }),
      adminId,
    ],
  );
  return id;
}
const sync = async (sourceId: string) => {
  const r = await drizzle(h.pool, { schema }).transaction((tx) =>
    requestSync(tx, { sourceId, trigger: "manual", requestedBy: null }),
  );
  await h.runSyncs([r!.syncId]);
  return (await h.pool.query("SELECT status, attention_code FROM lead_sources WHERE id = $1", [sourceId]))
    .rows[0];
};

describe("reading with either credential (Review Focus 4)", () => {
  it("each source reads with its own credentials", async () => {
    const oauth = await source("oauth", false); // not shared with the service account: only the grant can read it
    const sa = await source("service_account", true);
    expect(await sync(oauth)).toMatchObject({ status: "active" });
    expect(await sync(sa)).toMatchObject({ status: "active" });
    expect(await h.queryAll("SELECT 1 FROM leads WHERE name LIKE 'OAuth Lead %'")).toHaveLength(2);
  });

  it("Review Focus 3: a revoked grant pauses the sheet with a way back", async () => {
    const id = await source("oauth", false);
    h.fake!.revokeGrant();
    expect(await sync(id)).toMatchObject({ status: "needs_attention", attention_code: "ACCESS_LOST" });
    h.fake!.restoreGrant();
  });

  it("Review Focus 5: the relay unreachable is a passing failure", async () => {
    const id = await source("oauth", false);
    h.setRelayUrl("http://127.0.0.1:1"); // nothing listens there
    expect(await sync(id)).toMatchObject({ status: "active" });
    const [s] = (await h.pool.query("SELECT failures FROM lead_sources WHERE id = $1", [id])).rows;
    expect(s.failures).toBe(1);
    h.setRelayUrl(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);
  });

  describe("the relay under real use (final review)", () => {
    it('a revoked grant says what happened and what to do — not "share it with" (Important 1)', async () => {
      const id = await source("oauth", false);
      h.fake!.revokeGrant();
      await sync(id);
      const [s] = (await h.pool.query("SELECT last_error FROM lead_sources WHERE id = $1", [id])).rows;
      expect(s.last_error).toMatch(/Connect it again/);
      expect(s.last_error).not.toMatch(/Share it with/);
      h.fake!.restoreGrant();
    });

    it("access tokens are reused between syncs, so the relay isn't asked every time (Important 3)", async () => {
      const id = await source("oauth", false);
      await sync(id);
      const before = refreshes;
      await h.pool.query("UPDATE lead_sources SET last_modified = NULL WHERE id = $1", [id]);
      await sync(id);
      expect(refreshes).toBe(before);
    });

    it("an instance the relay doesn't know is a setup problem, not a passing failure (Important 4)", async () => {
      const stranger = http.createServer(
        createRelay({
          publicUrl: "http://relay.test",
          clientId: "cid",
          clientSecret: "cs",
          pickerKey: "pk",
          appId: "1",
          secret: "s".repeat(40),
          instances: [{ url: "https://someone-else.test", token: "z".repeat(40) }],
          googleTokenUrl: `${h.fake!.url}/token`,
        }),
      );
      await new Promise<void>((r) => stranger.listen(0, "127.0.0.1", r));
      h.setRelayUrl(`http://127.0.0.1:${(stranger.address() as AddressInfo).port}`);
      const id = await source("oauth", false);
      expect(await sync(id)).toMatchObject({ status: "needs_attention", attention_code: "GOOGLE_SETUP" });
      stranger.close();
      h.setRelayUrl(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);
    });
  });
});
