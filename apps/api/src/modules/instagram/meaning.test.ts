import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  IG_ACCOUNT,
  IGSID,
  igDm,
  igEnvelope,
  igPhoto,
  igPostback,
} from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliverIg, IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { fakeProvider } from "../../ai/fake";

/**
 * What an Instagram reply means (plan 2026-11-25-instagram-screens D6a): a lead's DM with words is read once by LUME AI,
 * as whoever connected the account, with Instagram's messages around it; never what was said to a flow still talking
 * to them (the flow answers it), a tap on a button, a reply with no words, or anything while LUME AI is off.
 */
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
const licence = testLicence({ instanceId: "LUME-TEST-IGMEANING", now: () => h.clock.now });
const provider = fakeProvider();

const as = (u: typeof admin) => h.signIn(u);
const aiOn = async (enabled: boolean) =>
  (await as(admin)).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled } });
let n = 0;
/** They write (each message its own id, a minute apart), and the delivery is processed. */
const says = async (text: string | undefined) => {
  h.clock.advance(60_000);
  const body = igDm({ mid: `aWdfM${++n}`, at: h.clock.now.toISOString(), text });
  expect((await deliverIg(h, body)).statusCode).toBe(200);
  await h.runInstagram();
};
const received = () =>
  h.queryAll<{ id: string; lead_id: string; payload: { text?: string; inFlow?: string } }>(
    "SELECT id, lead_id, payload FROM activities WHERE type = 'instagram_received' ORDER BY occurred_at, id",
  );
const reads = () =>
  h.queryAll<{ status: string; result: { meaning: string } | null; source_activity_id: string }>(
    "SELECT status, result, source_activity_id FROM ai_reads WHERE task = 'reply_meaning' ORDER BY created_at",
  );

/** A live DM-keyword flow that asks a question (so the person's answer is said to it). */
async function askingFlow() {
  const id = randomUUID();
  const vid = randomUUID();
  const steps = [
    {
      id: "ask",
      type: "ask",
      text: "What's your email?",
      save: { field: "email", kind: "email" },
      fallback: "Again?",
    },
    { id: "bye", type: "send", text: "Thanks!" },
  ];
  await h.ownerPool.query(
    "INSERT INTO instagram_flows (id, name, status, priority, draft_steps, created_by) VALUES ($1, 'Guide', 'draft', 0, $2, $3)",
    [id, JSON.stringify(steps), admin.id],
  );
  await h.ownerPool.query(
    "INSERT INTO instagram_flow_versions (id, flow_id, version, steps, created_by) VALUES ($1, $2, 1, $3, $4)",
    [vid, id, JSON.stringify(steps), admin.id],
  );
  await h.ownerPool.query("UPDATE instagram_flows SET status = 'live', live_version_id = $2 WHERE id = $1", [
    id,
    vid,
  ]);
  await h.ownerPool.query(
    `INSERT INTO instagram_triggers (id, flow_id, kind, keywords, mode, media_ids, public_replies, cooldown_hours)
     VALUES ($1, $2, 'dm', '{guide}', 'word', '{}', '{}', 24)`,
    [randomUUID(), id],
  );
}

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    licence: licence.options,
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
  });
  h.setRelayUrl("https://relay.test");
  h.clock.now = new Date("2026-11-25T06:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await (await as(admin)).inject({ method: "POST", url: "/api/v1/licence/check" });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  h.clock.advance(3_600_000);
  await h.ownerPool.query(
    "TRUNCATE leads, activities, ai_reads, instagram_threads, instagram_events, instagram_outbox, instagram_flows, notifications CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  h.instagramQueued.length = 0;
  h.whatsappMeaningQueued.length = 0;
  provider.calls.length = 0;
  ig.tokens.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  ig.profiles.set(IGSID, { name: "Priya Shah", username: "priya.fit" });
  await seedIgAccount(h, { runAs: admin.id });
  await aiOn(true);
});

describe("what an Instagram reply means", () => {
  it("a lead's DM is read once, with Instagram's messages and never WhatsApp's", async () => {
    await says("Hi, is the course still open?");
    const [first] = await received();
    // Something said on WhatsApp the same day: not part of what Instagram's reply is read with.
    await h.queryAll(
      `INSERT INTO activities (id, lead_id, type, occurred_at, payload)
       VALUES (gen_random_uuid(), $1, 'whatsapp_received', $2, '{"text":"Only on WhatsApp"}'::jsonb)`,
      [first!.lead_id, h.clock.now],
    );
    // What the business sent from LUME (its words kept in the outbox), between the two.
    h.clock.advance(60_000);
    const [t] = await h.queryAll<{ id: string; account_id: string }>(
      "SELECT id, account_id FROM instagram_threads",
    );
    const ob = randomUUID();
    await h.queryAll(
      `INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, text, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'dm', 'Morning or evening batch?', 'sent')`,
      [ob, t!.id, first!.lead_id, t!.account_id, admin.id, randomUUID()],
    );
    await h.queryAll(
      `INSERT INTO activities (id, lead_id, type, occurred_at, payload)
       VALUES (gen_random_uuid(), $1, 'instagram_confirmed_sent', $2, $3::jsonb)`,
      [first!.lead_id, h.clock.now, JSON.stringify({ via: "lume", outboxId: ob, threadId: t!.id })],
    );
    h.whatsappMeaningQueued.length = 0;
    await says("How much is the 12-week plan?");
    expect(h.whatsappMeaningQueued).toHaveLength(1);
    await h.runWhatsAppMeaning();
    const [r] = await reads();
    expect(r).toMatchObject({ status: "ok", result: { meaning: "price" } });
    const input = provider.calls.at(-1)!.input;
    expect(input).toContain('"instagram":[');
    expect(input).toContain("Hi, is the course still open?");
    expect(input).toContain("Morning or evening batch?");
    expect(input).not.toContain("Only on WhatsApp");
    // A retried job: never a second read.
    h.whatsappMeaningQueued.push(r!.source_activity_id);
    await h.runWhatsAppMeaning();
    expect(await reads()).toHaveLength(1);
  });

  it("a stop only LUME AI hears marks the lead do not contact, said as Instagram's", async () => {
    provider.script("reply_meaning", [
      {
        meaning: "stop",
        summary: "Asks not to be written to.",
        stop: true,
        stageId: null,
        followUp: null,
        lostReasonId: null,
      },
    ]);
    // Words LUME's own list of stops doesn't hear: only LUME AI's read can tell.
    await says("Please don't write to me here again");
    expect(h.whatsappMeaningQueued).toHaveLength(1);
    await h.runWhatsAppMeaning();
    const [l] = await h.queryAll<{ dnc_reason: string | null }>("SELECT dnc_reason FROM leads");
    expect(l!.dnc_reason).toBe("Said stop on Instagram");
  });

  it("what is said to a flow still talking to them is the flow's: marked, and never read", async () => {
    await askingFlow();
    await says("guide");
    // A tap on a button while it asks: the flow's too.
    h.clock.advance(60_000);
    const tap = igEnvelope([
      {
        sender: { id: IGSID },
        recipient: { id: IG_ACCOUNT },
        timestamp: h.clock.now.getTime(),
        postback: { mid: "aWdfPBM1", title: "Book a call", payload: "BOOK" },
      },
    ]);
    expect((await deliverIg(h, tap)).statusCode).toBe(200);
    await h.runInstagram();
    await says("priya@example.com");
    const all = await received();
    expect(all).toHaveLength(3);
    const [run] = await h.queryAll<{ id: string }>("SELECT id FROM instagram_flow_runs");
    // The keyword that started it, the tap and the answer to its question.
    expect(all.map((a) => a.payload.inFlow)).toEqual([run!.id, run!.id, run!.id]);
    expect(h.whatsappMeaningQueued).toEqual([]);
    // Queued before the mark (an older LUME): the read still leaves it be.
    h.whatsappMeaningQueued.push(all[2]!.id);
    await h.runWhatsAppMeaning();
    expect(await reads()).toEqual([]);
    // The flow is done: what they say next is theirs again.
    await says("Thanks! Do you also do diet plans?");
    expect(h.whatsappMeaningQueued).toHaveLength(1);
  });

  it("not read: LUME AI off, a photo with no words, a tap on a button", async () => {
    await aiOn(false);
    await says("Sounds good");
    await aiOn(true);
    h.clock.advance(60_000);
    expect((await deliverIg(h, igPhoto())).statusCode).toBe(200);
    await h.runInstagram();
    expect((await deliverIg(h, igPostback())).statusCode).toBe(200);
    await h.runInstagram();
    // A quick reply tapped with no flow waiting on it (an old message's): the button's words, never read.
    h.clock.advance(60_000);
    const tap = igDm({
      mid: "aWdfTAP1",
      at: h.clock.now.toISOString(),
      text: "Evening batch",
      quick_reply: { payload: "EVENING" },
    });
    expect((await deliverIg(h, tap)).statusCode).toBe(200);
    await h.runInstagram();
    expect(h.whatsappMeaningQueued).toEqual([]);
    expect((await received()).length).toBeGreaterThanOrEqual(2);
    // A stop LUME's own list hears is settled at once: nothing for LUME AI to read.
    await says("stop");
    expect(h.whatsappMeaningQueued).toEqual([]);
  });
});
