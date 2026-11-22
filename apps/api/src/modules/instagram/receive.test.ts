import { generateKeyPairSync } from "node:crypto";
import pg from "pg";
import {
  ALL_GRANTS,
  maskInstagram,
  rawPublicKey,
  relaySign,
  signLicence,
  type LicencePayload,
  type PlanClaim,
} from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  COMMENT_ID,
  IG_ACCOUNT,
  IG_ACCOUNT_B,
  IGSID,
  igAdDm,
  igComment,
  igDm,
  igEcho,
  igPhoto,
  igPostback,
  igReaction,
  igSeen,
  igStoryMention,
  igStoryReply,
  igUnsend,
} from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliverIg, IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";

/** Receiving Instagram (NEW_FEATURES_PLAN §4.3; plan 1A Task 5). */
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
let h: Harness;
let ig: InstagramFake;
let plan: PlanClaim | undefined;
let state: LicencePayload["state"] = "active";
let admin: { id: string; email: string; password: string };
let rep: { id: string; email: string; password: string };
let masked: { id: string; email: string; password: string };
let account: { id: string; sourceId: string };

const token = () =>
  signLicence(
    {
      v: 1,
      kid: "t1",
      instanceId: "LUME-TEST-IGR",
      state,
      licenseType: "subscription",
      issuedAt: h.clock.now.toISOString(),
      validUntil: new Date(h.clock.now.getTime() + 8 * 86_400_000).toISOString(),
      paidUntil: "2027-12-31",
      trialEndsAt: null,
      reason: state === "active" ? "paid" : "expired",
      notice: null,
      ...(plan ? { plan } : {}),
    } satisfies LicencePayload,
    server.privateKey,
  );
const check = async () => (await h.signIn(admin)).inject({ method: "POST", url: "/api/v1/licence/check" });
/** Deliver and process, as the relay and the queue would. */
const take = async (body: unknown) => {
  const r = await deliverIg(h, body);
  expect(r.statusCode).toBe(200);
  await h.runInstagram();
};
const leads = () =>
  h.queryAll<{
    id: string;
    name: string;
    instagram_handle: string | null;
    owner_id: string | null;
    source_id: string | null;
    ad_id: string | null;
    dnc_at: Date | null;
  }>(
    "SELECT id, name, instagram_handle, owner_id, source_id, ad_id, dnc_at FROM leads WHERE deleted_at IS NULL ORDER BY created_at",
  );
const acts = (type = "instagram_received") =>
  h.queryAll<{ lead_id: string; payload: Record<string, unknown>; occurred_at: Date }>(
    "SELECT lead_id, payload, occurred_at FROM activities WHERE type = $1 ORDER BY occurred_at, id",
    [type],
  );
const thread = async () =>
  (
    await h.queryAll<{
      id: string;
      lead_id: string | null;
      username: string | null;
      last_in_at: Date | null;
      ad_window_until: Date | null;
      taken_over_by: string | null;
      source: Record<string, unknown>;
    }>("SELECT * FROM instagram_threads WHERE igsid = $1", [IGSID])
  )[0];

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
    licence: {
      mode: "enforce",
      instanceId: "LUME-TEST-IGR",
      licenseKey: "LUME-KEY-SECRET-IGR",
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.8.0",
      fetch: (async () => new Response(JSON.stringify({ token: token() }), { status: 200 })) as typeof fetch,
    },
  });
  h.setRelayUrl("https://relay.test");
  h.clock.now = new Date("2026-11-22T06:10:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "leads.contact.full", scope: "own" },
    ],
  });
  masked = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  // Forward only: the same delivery signed at the same second is a replay, and LUME refuses those.
  h.clock.advance(3_600_000);
  state = "active";
  plan = { places: null, modules: all };
  await check();
  // Leads are never deleted by LUME (soft delete) and activities are insert-only: the table owner empties them.
  await h.ownerPool.query(
    "TRUNCATE leads, activities, instagram_threads, instagram_events, instagram_comments, instagram_inbox CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  await h.ownerPool.query("TRUNCATE notifications");
  h.instagramQueued.length = 0;
  h.instagramMediaQueued.length = 0;
  h.instagramProfileQueued.length = 0;
  ig.profiles.clear();
  ig.failPaths.clear();
  ig.files.clear();
  ig.tokens.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  ig.profiles.set(IGSID, { name: "Priya Shah", username: "priya.fit" });
  account = await seedIgAccount(h, { runAs: admin.id });
});

describe("the door (POST /instagram/in)", () => {
  it("refuses anything the relay didn't sign, and the same signed body twice", async () => {
    const raw = JSON.stringify(igDm());
    const unsigned = await h.app.inject({
      method: "POST",
      url: "/instagram/in",
      headers: { "content-type": "application/json" },
      payload: raw,
    });
    expect(unsigned.statusCode).toBe(401);
    const body = Buffer.from(raw);
    const ts = String(Math.floor(h.clock.now.getTime() / 1000));
    const signed = {
      method: "POST" as const,
      url: "/instagram/in",
      headers: {
        "content-type": "application/json",
        "x-lume-timestamp": ts,
        "x-lume-signature": relaySign(IG_RELAY_TOKEN, ts, body),
      },
      payload: body,
    };
    expect((await h.app.inject(signed)).statusCode).toBe(200);
    expect((await h.app.inject(signed)).statusCode).toBe(401);
    // Signed with another LUME's token: refused.
    const other = {
      ...signed,
      headers: { ...signed.headers, "x-lume-signature": relaySign("o".repeat(40), ts, body) },
    };
    expect((await h.app.inject(other)).statusCode).toBe(401);
  });

  it("keeps each delivery once, encrypted, and queues it", async () => {
    await deliverIg(h, igDm());
    await deliverIg(h, igDm());
    const rows = await h.queryAll<{ event_enc: Buffer; event_key: string }>(
      "SELECT event_enc, event_key FROM instagram_events",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_key).toBe("m:aWdfMID1");
    expect(rows[0]!.event_enc.toString("latin1")).not.toContain("course");
    expect(h.instagramQueued).toHaveLength(1);
  });

  it("keeps nothing (and still says 200) when Instagram is off, out of the plan, or the account isn't here", async () => {
    await h.ownerPool.query(`UPDATE settings SET integrations = integrations - 'instagram' WHERE id = 1`);
    expect((await deliverIg(h, igDm())).statusCode).toBe(200);
    await h.ownerPool.query(
      `UPDATE settings SET integrations = jsonb_set(integrations, '{instagram}', '{"enabled": true}'::jsonb) WHERE id = 1`,
    );
    plan = { places: null, modules: { ...all, instagram: false } };
    await check();
    expect((await deliverIg(h, igDm({ mid: "m2" }))).statusCode).toBe(200);
    plan = { places: null, modules: all };
    await check();
    expect((await deliverIg(h, igDm({ mid: "m3", account: IG_ACCOUNT_B }))).statusCode).toBe(200);
    expect(await h.queryAll("SELECT 1 FROM instagram_events")).toHaveLength(0);
  });

  it("keeps nothing while the plan leaves Instagram out", async () => {
    // A licence answer counts only when it's newer than the last one.
    h.clock.advance(60_000);
    plan = { places: null, modules: { ...all, instagram: false } };
    expect((await check()).statusCode).toBe(200);
    // The plan switches Instagram off; switched back on behind its back, the door still keeps nothing.
    await h.ownerPool.query(
      `UPDATE settings SET integrations = jsonb_set(integrations, '{instagram}', '{"enabled": true}'::jsonb) WHERE id = 1`,
    );
    expect((await deliverIg(h, igDm())).statusCode).toBe(200);
    expect(await h.queryAll("SELECT 1 FROM instagram_events")).toHaveLength(0);
  });

  it("of a batch, keeps only the entries for accounts this LUME holds", async () => {
    const batch = {
      object: "instagram",
      entry: [
        igDm().entry[0],
        igDm({ mid: "theirs", account: IG_ACCOUNT_B, from: "6512000000000002" }).entry[0],
      ],
    };
    expect((await deliverIg(h, batch)).statusCode).toBe(200);
    const kept = await h.queryAll<{ account_ig_id: string }>("SELECT account_ig_id FROM instagram_events");
    expect(kept).toEqual([{ account_ig_id: IG_ACCOUNT }]);
  });

  it("keeps nothing while this LUME is read-only", async () => {
    state = "read_only";
    await check();
    expect((await deliverIg(h, igDm())).statusCode).toBe(200);
    expect(await h.queryAll("SELECT 1 FROM instagram_events")).toHaveLength(0);
  });

  it("an account disconnected after the delivery was kept: nothing reaches a lead", async () => {
    await deliverIg(h, igDm());
    await h.ownerPool.query("UPDATE instagram_accounts SET status = 'disconnected', token_enc = NULL");
    await h.runInstagram();
    expect(await leads()).toHaveLength(0);
    expect((await h.queryAll<{ status: string }>("SELECT status FROM instagram_events"))[0]!.status).toBe(
      "done",
    );
  });
});

describe("a person's first DM", () => {
  it("becomes a lead under the account's source, named as they are on Instagram, with the message on it", async () => {
    await take(igDm());
    const [l] = await leads();
    expect(l).toMatchObject({
      name: "Priya Shah",
      instagram_handle: "priya.fit",
      source_id: account.sourceId,
    });
    const [a] = await acts();
    expect(a).toMatchObject({
      lead_id: l!.id,
      payload: { mid: "aWdfMID1", text: "Hi, is the course still open?" },
    });
    expect(a!.occurred_at.toISOString()).toBe("2026-11-22T06:00:00.000Z");
    const t = await thread();
    expect(t).toMatchObject({ lead_id: l!.id, username: "priya.fit" });
    expect(t!.last_in_at!.toISOString()).toBe("2026-11-22T06:00:00.000Z");
  });

  it("finds the lead that came from ManyChat with the same handle (any case, with an @) instead of making another", async () => {
    const id = await h.seedLead({ ownerId: rep.id, name: "Priya from ManyChat" });
    await h.queryAll("UPDATE leads SET instagram_handle = 'priya.fit' WHERE id = $1", [id]);
    ig.profiles.set(IGSID, { name: "Priya Shah", username: "Priya.Fit" });
    await take(igDm());
    expect((await leads()).map((l) => l.id)).toEqual([id]);
    expect((await acts())[0]!.lead_id).toBe(id);
  });

  it("with two leads on that handle: the account owner's first, then the most recently active", async () => {
    const older = await h.seedLead({ ownerId: rep.id, name: "A" });
    const mine = await h.seedLead({ ownerId: admin.id, name: "B" });
    await h.queryAll(
      "UPDATE leads SET instagram_handle = 'priya.fit', last_activity_at = now() WHERE id = $1",
      [older],
    );
    await h.queryAll(
      "UPDATE leads SET instagram_handle = 'priya.fit', last_activity_at = now() - interval '1 day' WHERE id = $1",
      [mine],
    );
    await h.ownerPool.query("UPDATE instagram_accounts SET owner_user_id = $1", [admin.id]);
    await take(igDm());
    expect((await acts())[0]!.lead_id).toBe(mine);
  });

  it("the source's owner rule: a chosen person, or turns over a team", async () => {
    const cfg = await h.config();
    const rules = (owner: unknown) =>
      JSON.stringify({
        matchOn: ["instagram"],
        onMatch: "merge",
        pipelineId: cfg.pipelineId,
        stageId: cfg.stages.New,
        owner,
      });
    await h.ownerPool.query("UPDATE lead_sources SET rules = $2 WHERE id = $1", [
      account.sourceId,
      rules({ mode: "user", userId: rep.id }),
    ]);
    await take(igDm());
    expect((await leads())[0]!.owner_id).toBe(rep.id);
    await h.ownerPool.query("UPDATE lead_sources SET rules = $2 WHERE id = $1", [
      account.sourceId,
      rules({ mode: "round_robin", userIds: [rep.id, admin.id] }),
    ]);
    for (const n of [2, 3, 4]) {
      ig.profiles.set(`651200000000000${n}`, { name: `P${n}`, username: `p${n}` });
      await take(igDm({ mid: `m${n}`, from: `651200000000000${n}` }));
    }
    const owners = (await leads()).slice(1).map((l) => l.owner_id);
    expect(new Set(owners).size).toBe(2);
    expect(owners[0]).not.toBe(owners[1]);
    expect(owners[0]).toBe(owners[2]);
  });

  it("no name on Instagram: the handle; no profile at all: 'Instagram lead', and the profile is read later", async () => {
    ig.profiles.set(IGSID, { name: "", username: "priya.fit" });
    await take(igDm());
    expect((await leads())[0]!.name).toBe("@priya.fit");
    await h.ownerPool.query("TRUNCATE leads, activities, instagram_threads CASCADE");
    ig.failPaths.add(`/${IGSID}`);
    await take(igDm({ mid: "m2" }));
    expect((await leads())[0]).toMatchObject({ name: "Instagram lead", instagram_handle: null });
    expect(h.instagramProfileQueued).toHaveLength(1);
    ig.failPaths.clear();
    await h.runInstagramProfile();
    expect((await leads())[0]!.instagram_handle).toBe("priya.fit");
  });

  it("two first messages at once make one lead", async () => {
    await deliverIg(h, igDm({ mid: "a1" }));
    await deliverIg(h, igDm({ mid: "a2", text: "hello?" }));
    const ids = h.instagramQueued.splice(0);
    const { processInstagramEvent } = await import("./process");
    await Promise.all(ids.map((id) => processInstagramEvent({ app: h.app, d: h.deps }, id)));
    expect(await leads()).toHaveLength(1);
    expect(await acts()).toHaveLength(2);
  });

  it("the same message twice is on the lead once", async () => {
    await take(igDm());
    await h.ownerPool.query("DELETE FROM instagram_events");
    await take(igDm());
    expect(await acts()).toHaveLength(1);
  });

  it("a lead deleted since: the person is new again", async () => {
    await take(igDm());
    await h.queryAll("UPDATE leads SET deleted_at = now()");
    await take(igDm({ mid: "m2" }));
    expect(await leads()).toHaveLength(1);
    expect((await leads())[0]!.name).toBe("Priya Shah");
  });

  it("tells the lead's owner once for a burst, never with more than the words", async () => {
    await h.ownerPool.query("UPDATE lead_sources SET rules = rules || $2::jsonb WHERE id = $1", [
      account.sourceId,
      JSON.stringify({ owner: { mode: "user", userId: rep.id } }),
    ]);
    await take(igDm());
    await take(igDm({ mid: "m2", text: "anyone?" }));
    const reader = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
    await reader.connect();
    const n = (
      await reader
        .query<{ user_id: string; title: string; body: string }>(
          "SELECT user_id, title, body FROM notifications WHERE kind = 'lead_replied'",
        )
        .finally(() => reader.end())
    ).rows;
    expect(n).toEqual([
      { user_id: rep.id, title: "Priya replied on Instagram", body: "Hi, is the course still open?" },
    ]);
  });
});

describe("stop means stop", () => {
  it.each([["STOP"], ["band karo"], ["please don't message me again"]])(
    "'%s' makes the lead do not contact",
    async (text) => {
      await take(igDm({ text }));
      expect((await leads())[0]!.dnc_at).not.toBeNull();
    },
  );
  it("words that only contain 'stop' don't", async () => {
    await take(igDm({ text: "what's the nearest bus stop to the studio?" }));
    expect((await leads())[0]!.dnc_at).toBeNull();
  });
});

describe("Not a lead yet", () => {
  beforeEach(async () => {
    await h.ownerPool.query("UPDATE instagram_accounts SET new_dm_creates_lead = false, owner_user_id = $1", [
      rep.id,
    ]);
  });
  const inbox = async (u = rep) =>
    (await (await h.signIn(u)).inject({ method: "GET", url: "/api/v1/instagram/inbox" })).json();

  it("waits for a person when the account says so; its owner sees it, nobody else with own scope", async () => {
    await take(igDm());
    expect(await leads()).toHaveLength(0);
    const r = await inbox();
    expect(r.people).toEqual([
      expect.objectContaining({ username: "priya.fit", count: 1, lastText: "Hi, is the course still open?" }),
    ]);
    const other = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    expect((await inbox(other)).people).toEqual([]);
  });

  it("make a lead: their messages move onto it in order, a stop said while waiting holds", async () => {
    await take(igDm());
    // The same second as the first: they keep the order they came in.
    await take(igDm({ mid: "m2", text: "stop" }));
    const t = (await thread())!;
    const r = await (
      await h.signIn(admin)
    ).inject({ method: "POST", url: `/api/v1/instagram/inbox/${t.id}/lead` });
    expect(r.statusCode).toBe(201);
    const [l] = await leads();
    expect(l!.dnc_at).not.toBeNull();
    expect((await acts()).map((a) => a.payload.text)).toEqual(["Hi, is the course still open?", "stop"]);
    expect(await h.queryAll("SELECT 1 FROM instagram_inbox")).toHaveLength(0);
    // New messages go straight to the lead now.
    await take(igDm({ mid: "m3", text: "ok sorry, tell me more" }));
    expect(await acts()).toHaveLength(3);
  });

  it("not a lead: their messages go and they never show up here again", async () => {
    await take(igDm());
    const t = (await thread())!;
    await (await h.signIn(rep)).inject({ method: "POST", url: `/api/v1/instagram/inbox/${t.id}/ignore` });
    await take(igDm({ mid: "m2" }));
    expect((await inbox()).people).toEqual([]);
  });

  it("found later by their handle: a lead that came in from a sheet takes the conversation and its messages", async () => {
    ig.failPaths.add(`/${IGSID}`);
    await take(igDm());
    const id = await h.seedLead({ ownerId: rep.id, name: "From a sheet" });
    await h.queryAll("UPDATE leads SET instagram_handle = 'priya.fit' WHERE id = $1", [id]);
    ig.failPaths.clear();
    await h.runInstagramProfile();
    expect((await thread())!.lead_id).toBe(id);
    expect((await acts()).map((a) => a.lead_id)).toEqual([id]);
  });

  it("a stranger's echo (the business answering from the app) keeps nothing", async () => {
    await take(igEcho());
    expect(await h.queryAll("SELECT 1 FROM instagram_inbox")).toHaveLength(0);
  });
});

describe("the conversation", () => {
  it("story replies, mentions and photos keep what they are; the photo is fetched", async () => {
    await take(igStoryReply());
    await take(igStoryMention());
    await take(igPhoto());
    const p = (await acts()).map((a) => a.payload);
    expect(p[0]).toMatchObject({ text: "Love this!", story: { id: "17900000000000001" } });
    expect(p[1]).toMatchObject({ mention: true, attachments: ["story_mention"] });
    expect(p[2]).toMatchObject({ attachments: ["image"] });
    expect(JSON.stringify(p)).not.toContain("lookaside");
    expect(h.instagramMediaQueued).toHaveLength(1);
  });

  it("an ad click: the lead and the conversation remember the ad, and the window lasts 7 days", async () => {
    await take(igAdDm());
    expect((await leads())[0]!.ad_id).toBe("120200000000000001");
    const t = (await thread())!;
    expect(t.source).toMatchObject({ trigger: "ad", adId: "120200000000000001", ref: "spring" });
    expect(t.ad_window_until!.toISOString()).toBe("2026-11-29T06:00:00.000Z");
  });

  it("a tap that arrives before the message it answers: both kept, in Meta's order", async () => {
    await take(igDm({ at: "2026-11-22T06:00:00Z" }));
    await take(igPostback());
    await take(igDm({ mid: "early", text: "earlier words", at: "2026-11-22T05:59:00Z" }));
    expect((await acts()).map((a) => a.payload.text)).toEqual([
      "earlier words",
      "Hi, is the course still open?",
      "Book a call",
    ]);
    expect((await thread())!.last_in_at!.toISOString()).toBe("2026-11-22T06:01:00.000Z");
  });

  it("an echo from Instagram itself goes on the lead and hands the conversation to a person", async () => {
    await take(igDm());
    await take(igEcho());
    const [s] = await acts("instagram_sent");
    expect(s!.payload).toMatchObject({ via: "echo", text: "Yes it is!" });
    expect((await thread())!.taken_over_by).not.toBeNull();
  });

  it("an echo while LUME's own send to them is in flight waits, then is the same message, not two", async () => {
    await take(igDm());
    const t = (await thread())!;
    const [l] = await leads();
    const outId = "0190e0c0-0000-7000-8000-00000000ab01";
    await h.queryAll(
      `INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, text, status)
       VALUES ($1, $2, $3, $4, $5, gen_random_uuid(), 'dm', 'Yes it is!', 'sending')`,
      [outId, t.id, l!.id, account.id, admin.id],
    );
    await deliverIg(h, igEcho());
    await h.runInstagram();
    expect(h.instagramQueued).toHaveLength(1);
    await h.queryAll("UPDATE instagram_outbox SET status = 'sent', mid = 'aWdfECHO1' WHERE id = $1", [outId]);
    await h.runInstagram();
    expect(await acts("instagram_sent")).toHaveLength(0);
  });

  it("a reaction opens the window and shows on LUME's message; a read marks LUME's messages read", async () => {
    await take(igDm());
    const t = (await thread())!;
    const [l] = await leads();
    await h.queryAll(
      `INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, text, status, mid, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), 'dm', 'Yes it is!', 'sent', 'aWdfECHO1', now() - interval '1 minute'),
              (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), 'dm', 'later one', 'sent', 'aWdfLATER', now())`,
      [t.id, l!.id, account.id, admin.id],
    );
    await take(igReaction("react"));
    await take(igSeen());
    const rows = await h.queryAll<{ mid: string; status: string; reaction: string | null }>(
      "SELECT mid, status, reaction FROM instagram_outbox ORDER BY created_at",
    );
    expect(rows).toEqual([
      { mid: "aWdfECHO1", status: "read", reaction: "❤️" },
      { mid: "aWdfLATER", status: "sent", reaction: null },
    ]);
    await take(igReaction("unreact"));
    expect(
      (
        await h.queryAll<{ reaction: string | null }>(
          "SELECT reaction FROM instagram_outbox WHERE mid = 'aWdfECHO1'",
        )
      )[0]!.reaction,
    ).toBeNull();
  });

  it("a message the person took back loses its words, everywhere", async () => {
    await take(igDm());
    await take(igUnsend());
    const view = await (
      await h.signIn(admin)
    ).inject({ method: "GET", url: `/api/v1/leads/${(await leads())[0]!.id}/instagram` });
    const msg = view.json().threads[0].messages[0];
    expect(msg).toMatchObject({ unsent: true, text: null });
    expect(view.body).not.toContain("course");
  });
});

describe("who sees the conversation", () => {
  it("someone without full contact details sees the handle masked; someone without the lead gets 404", async () => {
    await h.ownerPool.query("UPDATE lead_sources SET rules = rules || $2::jsonb WHERE id = $1", [
      account.sourceId,
      JSON.stringify({ owner: { mode: "user", userId: rep.id } }),
    ]);
    await take(igDm());
    const id = (await leads())[0]!.id;
    const get = async (u: typeof rep) =>
      (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/leads/${id}/instagram` });
    expect((await get(rep)).json().threads[0].person.username).toBe("@priya.fit");
    const m = await get(masked);
    expect(m.json().threads[0].person.username).toBe(maskInstagram("priya.fit"));
    expect(m.body).not.toContain("priya.fit");
    const stranger = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    expect((await get(stranger)).statusCode).toBe(404);
  });

  it("shows Meta's window: open, then only a person, then closed", async () => {
    const at = new Date(h.clock.now.getTime() - 60_000);
    const iso = (ms: number) => new Date(at.getTime() + ms).toISOString();
    await take(igDm({ at: at.toISOString() }));
    const id = (await leads())[0]!.id;
    const win = async () =>
      (await (await h.signIn(admin)).inject({ method: "GET", url: `/api/v1/leads/${id}/instagram` })).json()
        .threads[0].window;
    expect(await win()).toEqual({ state: "open", until: iso(86_400_000) });
    h.clock.now = new Date(at.getTime() + 2 * 86_400_000);
    expect(await win()).toEqual({ state: "human", until: iso(7 * 86_400_000) });
    h.clock.now = new Date(at.getTime() + 8 * 86_400_000);
    expect(await win()).toEqual({ state: "closed", since: iso(7 * 86_400_000) });
  });
});

describe("comments", () => {
  it("are kept with their post and author; the account's own are ignored", async () => {
    await take(igComment());
    await take(igComment({ id: "17990000000000077", from: IG_ACCOUNT, username: "harbour.studio" }));
    const rows = await h.queryAll<{
      comment_id: string;
      from_username: string;
      media_id: string;
      private_reply: string;
    }>("SELECT comment_id, from_username, media_id, private_reply FROM instagram_comments");
    expect(rows).toEqual([
      {
        comment_id: COMMENT_ID,
        from_username: "priya.fit",
        media_id: "17980000000000001",
        private_reply: "none",
      },
    ]);
    expect(await leads()).toHaveLength(0);
  });

  it("a comment from someone already in a conversation is tied to it", async () => {
    await take(igDm());
    await take(igComment());
    const [c] = await h.queryAll<{ thread_id: string }>("SELECT thread_id FROM instagram_comments");
    expect(c!.thread_id).toBe((await thread())!.id);
  });
});

describe("files people send", () => {
  it("only from Meta's hosts (or the test's own Graph), kept once, over 25 MB refused", async () => {
    const { fetchInstagramMedia } = await import("./media");
    const run = (id: string) => fetchInstagramMedia({ app: h.app, d: h.deps }, id);
    ig.files.set("a.jpg", { type: "image/jpeg", bytes: Buffer.from("not-really-a-jpeg") });
    await take(
      igDm({ text: undefined, attachments: [{ type: "image", payload: { url: `${ig.url}/cdn/a.jpg` } }] }),
    );
    await take(
      igDm({
        mid: "m2",
        text: undefined,
        attachments: [{ type: "image", payload: { url: "https://evil.test/x.jpg" } }],
      }),
    );
    for (const id of h.instagramMediaQueued.splice(0)) await run(id);
    const rows = await h.queryAll<{
      mid: string;
      status: string;
      sha256: string | null;
      mime: string | null;
    }>("SELECT mid, status, sha256, mime FROM instagram_media ORDER BY mid");
    expect(rows[0]).toMatchObject({ mid: "aWdfMID1", status: "ready", mime: "image/jpeg" });
    expect(rows[1]).toMatchObject({ mid: "m2", status: "failed", sha256: null });
    ig.files.set("big.mp4", { type: "video/mp4", bytes: Buffer.alloc(25 * 1024 * 1024 + 1) });
    await take(
      igDm({
        mid: "m3",
        text: undefined,
        attachments: [{ type: "video", payload: { url: `${ig.url}/cdn/big.mp4` } }],
      }),
    );
    for (const id of h.instagramMediaQueued.splice(0)) await run(id);
    const [big] = await h.queryAll<{ status: string }>("SELECT status FROM instagram_media WHERE mid = 'm3'");
    expect(big!.status).toBe("too_large");
  });
});

describe("at volume", () => {
  it("500 people writing at once: 500 leads, each message once, in under a minute", async () => {
    const t0 = Date.now();
    for (let i = 0; i < 500; i++) {
      const id = String(7000000000000000 + i);
      ig.profiles.set(id, { name: `Person ${i}`, username: `person.${i}` });
      await deliverIg(h, igDm({ mid: `bulk-${i}`, from: id }));
    }
    await h.runInstagram();
    expect(await leads()).toHaveLength(500);
    expect(await acts()).toHaveLength(500);
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);
});
