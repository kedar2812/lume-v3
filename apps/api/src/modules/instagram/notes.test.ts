import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALL_GRANTS } from "@lume/core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IG_ACCOUNT, IGSID, igComment, igDm } from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliverIg, IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { takeRelayNotes } from "./notes";

/** What the relay keeps for a LUME: gaps to catch up on, Meta's deauthorize and deletion requests (plan 1A Task 7). */
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
let relay: http.Server;
let relayUp = true;
let notes: Record<string, unknown>[] = [];
let cleared: string[][] = [];

const run = () => takeRelayNotes({ ...h.deps, sleep: async () => undefined });
const acts = () =>
  h.queryAll<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM activities WHERE type = 'instagram_received' ORDER BY occurred_at",
  );

beforeAll(async () => {
  ig = await startInstagramFake();
  relay = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (!relayUp || req.headers.authorization !== `Bearer ${IG_RELAY_TOKEN}`) {
        res.writeHead(relayUp ? 401 : 503);
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/ig/notes") return res.end(JSON.stringify({ notes }));
      if (req.url === "/ig/notes/clear") {
        const ids = (JSON.parse(Buffer.concat(chunks).toString()) as { ids: string[] }).ids;
        cleared.push(ids);
        notes = notes.filter((n) => !ids.includes(String(n.id)));
        return res.end(JSON.stringify({ cleared: ids.length }));
      }
      res.end("{}");
    });
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  h = await createHarness({
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
  });
  h.setRelayUrl(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`);
  h.clock.now = new Date("2026-11-22T08:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
  await ig.close();
  relay.close();
});
beforeEach(async () => {
  h.clock.advance(3_600_000);
  await h.ownerPool.query(
    "TRUNCATE leads, activities, instagram_threads, instagram_events, instagram_comments, instagram_inbox CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  await h.ownerPool.query("TRUNCATE notifications");
  h.instagramQueued.length = 0;
  relayUp = true;
  notes = [];
  cleared = [];
  ig.conversations.clear();
  ig.conversationPageSize = 100;
  ig.failPaths.clear();
  ig.calls.length = 0;
  ig.tokens.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  ig.profiles.set(IGSID, { name: "Priya Shah", username: "priya.fit" });
  await seedIgAccount(h, { runAs: admin.id });
});

describe("a gap the relay noted", () => {
  it("brings in what people wrote meanwhile, once, and never the business's own messages", async () => {
    const from = Date.parse("2026-11-22T06:00:00Z");
    ig.conversations.set(IG_ACCOUNT, [
      {
        id: "conv1",
        igsid: IGSID,
        messages: [
          { id: "old", from: IGSID, text: "before the gap", created: "2026-11-22T05:00:00Z" },
          { id: "g1", from: IGSID, text: "anyone there?", created: "2026-11-22T06:10:00Z" },
          { id: "biz", from: IG_ACCOUNT, text: "Yes!", created: "2026-11-22T06:20:00Z" },
          { id: "g2", from: IGSID, text: "price?", created: "2026-11-22T06:30:00Z" },
        ],
      },
    ]);
    notes = [{ id: "n1", kind: "gap", accountIds: [IG_ACCOUNT], from, to: from + 3_600_000 }];
    expect(await run()).toBe(1);
    await h.runInstagram();
    expect((await acts()).map((a) => a.payload.text)).toEqual(["anyone there?", "price?"]);
    expect(cleared).toEqual([["n1"]]);
    // Asked again (a note not cleared, or a message Meta also delivered late): nothing twice.
    notes = [{ id: "n2", kind: "gap", accountIds: [IG_ACCOUNT], from, to: from + 3_600_000 }];
    await run();
    await deliverIg(h, igDm({ mid: "g1", text: "anyone there?", at: "2026-11-22T06:10:00Z" }));
    await h.runInstagram();
    expect(await acts()).toHaveLength(2);
  });

  it("Meta failing midway: the note stays at the relay, and the next run brings the messages in", async () => {
    const from = Date.parse("2026-11-22T06:00:00Z");
    ig.conversations.set(IG_ACCOUNT, [
      {
        id: "conv1",
        igsid: IGSID,
        messages: [{ id: "g1", from: IGSID, text: "hello?", created: "2026-11-22T06:10:00Z" }],
      },
    ]);
    notes = [{ id: "n1", kind: "gap", accountIds: [IG_ACCOUNT], from, to: from + 3_600_000 }];
    ig.failPaths.add("/conv1");
    expect(await run()).toBe(0);
    expect(cleared).toEqual([]);
    ig.failPaths.clear();
    expect(await run()).toBe(1);
    await h.runInstagram();
    expect((await acts()).map((a) => a.payload.text)).toEqual(["hello?"]);
  });

  it("Meta failing on the list of conversations itself: the note stays too, and the next run brings them in", async () => {
    const from = Date.parse("2026-11-22T06:00:00Z");
    ig.conversations.set(IG_ACCOUNT, [
      {
        id: "conv1",
        igsid: IGSID,
        messages: [{ id: "g1", from: IGSID, text: "hello?", created: "2026-11-22T06:10:00Z" }],
      },
    ]);
    notes = [{ id: "n1", kind: "gap", accountIds: [IG_ACCOUNT], from, to: from + 3_600_000 }];
    ig.failPaths.add("/conversations");
    expect(await run()).toBe(0);
    expect(cleared).toEqual([]);
    ig.failPaths.clear();
    expect(await run()).toBe(1);
    expect(cleared).toEqual([["n1"]]);
    await h.runInstagram();
    expect((await acts()).map((a) => a.payload.text)).toEqual(["hello?"]);
  });

  it("reads every page of conversations, with the account's token on each", async () => {
    const from = Date.parse("2026-11-22T06:00:00Z");
    ig.conversationPageSize = 1;
    ig.conversations.set(
      IG_ACCOUNT,
      ["6512000000000031", "6512000000000032", "6512000000000033"].map((who, i) => ({
        id: `conv${i}`,
        igsid: who,
        messages: [{ id: `p${i}`, from: who, text: `page ${i}`, created: `2026-11-22T06:1${i}:00Z` }],
      })),
    );
    for (const who of ["6512000000000031", "6512000000000032", "6512000000000033"])
      ig.profiles.set(who, { name: `P ${who.slice(-2)}`, username: `p${who.slice(-2)}` });
    notes = [{ id: "n1", kind: "gap", accountIds: [IG_ACCOUNT], from, to: from + 3_600_000 }];
    expect(await run()).toBe(1);
    await h.runInstagram();
    expect((await acts()).map((a) => a.payload.text).sort()).toEqual(["page 0", "page 1", "page 2"]);
  });

  it("an account that isn't connected, or needs connecting again: the note is simply done", async () => {
    // Still holding its old token: only its state keeps LUME from asking Meta with it.
    await h.ownerPool.query("UPDATE instagram_accounts SET status = 'needs_attention'");
    notes = [{ id: "n1", kind: "gap", accountIds: [IG_ACCOUNT], from: 0, to: 1 }];
    expect(await run()).toBe(1);
    expect(ig.calls.filter((c) => c.path.includes("conversations"))).toHaveLength(0);
  });
});

describe("Meta's requests", () => {
  it("deauthorize: the account is disconnected, admins hear, its leads and words stay", async () => {
    await deliverIg(h, igDm());
    await h.runInstagram();
    notes = [{ id: "d1", kind: "deauthorize", userId: IG_ACCOUNT, at: 1 }];
    await run();
    const [a] = await h.queryAll<{ status: string; token_enc: Buffer | null }>(
      "SELECT status, token_enc FROM instagram_accounts",
    );
    expect(a).toEqual({ status: "disconnected", token_enc: null });
    expect((await acts())[0]!.payload.text).toBe("Hi, is the course still open?");
    const reader = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
    await reader.connect();
    const n = await reader
      .query<{ title: string }>("SELECT title FROM notifications WHERE kind = 'system_alert'")
      .finally(() => reader.end());
    expect(n.rows.map((r) => r.title)).toEqual(["Instagram @harbour.studio was disconnected on Instagram"]);
  });

  it("data deletion: disconnected, and what Instagram sent about it is gone; the leads stay", async () => {
    await deliverIg(h, igDm());
    await deliverIg(h, igComment());
    await h.runInstagram();
    await h.ownerPool.query("UPDATE instagram_accounts SET new_dm_creates_lead = false");
    await deliverIg(h, igDm({ mid: "w1", from: "6512000000000077", text: "waiting words" }));
    ig.profiles.set("6512000000000077", { name: "Waiting Person", username: "waiting.one" });
    await h.runInstagram();
    notes = [{ id: "x1", kind: "delete", userId: IG_ACCOUNT, at: 1 }];
    await run();
    const p = (await acts())[0]!.payload;
    expect(p.text).toBeUndefined();
    expect(p.forgotten).toBe(true);
    expect(await h.queryAll("SELECT 1 FROM instagram_inbox")).toHaveLength(0);
    expect(await h.queryAll("SELECT 1 FROM instagram_comments")).toHaveLength(0);
    expect(
      await h.queryAll("SELECT 1 FROM instagram_threads WHERE username IS NOT NULL OR name IS NOT NULL"),
    ).toHaveLength(0);
    expect(await h.queryAll("SELECT 1 FROM leads WHERE deleted_at IS NULL")).toHaveLength(1);
    expect(cleared).toEqual([["x1"]]);
  });

  it("a request for an account this LUME doesn't have is cleared and changes nothing", async () => {
    notes = [{ id: "z1", kind: "delete", userId: "17841499999999999", at: 1 }];
    expect(await run()).toBe(1);
    const [a] = await h.queryAll<{ status: string }>("SELECT status FROM instagram_accounts");
    expect(a!.status).toBe("active");
  });
});

describe("the relay", () => {
  it("down: nothing happens, and the notes wait there for the next run", async () => {
    relayUp = false;
    notes = [{ id: "n1", kind: "deauthorize", userId: IG_ACCOUNT, at: 1 }];
    expect(await run()).toBe(0);
    const [a] = await h.queryAll<{ status: string }>("SELECT status FROM instagram_accounts");
    expect(a!.status).toBe("active");
  });

  it("its ping to fetch the notes must be signed", async () => {
    const r = await h.app.inject({ method: "POST", url: "/instagram/notes", payload: {} });
    expect(r.statusCode).toBe(401);
  });
});
