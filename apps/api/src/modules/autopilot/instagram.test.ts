import { randomUUID } from "node:crypto";
import { ALL_GRANTS, AUTOPILOT_PRESETS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IGSID } from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { fakeProvider } from "../../ai/fake";
import { dueRuns, IG_LET_GO, IG_NO_AI_LEADS } from "./engine";

/**
 * LUME AI on Instagram, the engine's branch (plan 2026-11-27-instagram-lume-ai, Task 2): it only answers, inside
 * Instagram's 24 hours, never with the human agent tag, never over 1,000 bytes; once the 24 hours end unanswered a person
 * gets the lead with the day and time they can still answer until.
 */
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
let account: { id: string; sourceId: string };
const licence = testLicence({ instanceId: "LUME-TEST-IG-AI", now: () => h.clock.now });
const provider = fakeProvider();
const as = () => h.signIn(admin);

const reply = (message: string) => ({
  kind: "reply",
  message,
  reason: "Answering the question.",
  evidence: null,
  fileIds: [],
  stageId: null,
  fields: [],
  followUp: null,
  lostReasonId: null,
});

/** A lead who wrote on Instagram `ago` ms ago, held by a LUME AI run on the account (its standing one). */
async function setUp(o: { ago?: number; text?: string; goal?: object; leadGoal?: object } = {}) {
  const at = new Date(h.clock.now.getTime() - (o.ago ?? 10 * MIN));
  const leadId = await h.seedLead({ ownerId: admin.id, name: "Maya Iyer" });
  const threadId = randomUUID();
  await h.queryAll(
    `INSERT INTO instagram_threads (id, account_id, igsid, lead_id, username, last_in_at, last_message_at)
     VALUES ($1, $2, $3, $4, 'maya.iyer', $5, $5)`,
    [threadId, account.id, IGSID, leadId, at],
  );
  await h.queryAll(
    `INSERT INTO activities (id, lead_id, type, occurred_at, payload)
     VALUES ($1, $2, 'instagram_received', $3, $4)`,
    [
      randomUUID(),
      leadId,
      at,
      JSON.stringify({
        mid: `m-${randomUUID()}`,
        accountId: account.id,
        threadId,
        text: o.text ?? "Any slots Monday?",
      }),
    ],
  );
  const runId = randomUUID();
  await h.queryAll(
    `INSERT INTO autopilot_runs (id, name, started_by, speaker_id, channel, instagram_account_id, standing, goal,
                                 permissions, follow_up_days, outside_hours)
     VALUES ($1, 'New DMs on @harbour.studio', $2, $2, 'instagram', $3, true, $4, $5, '{}', 'reply_any_time')`,
    [
      runId,
      admin.id,
      account.id,
      JSON.stringify(o.goal ?? { kind: "brief", text: "Book a trial class" }),
      JSON.stringify(AUTOPILOT_PRESETS.hands_off),
    ],
  );
  await h.queryAll(
    `INSERT INTO autopilot_leads (run_id, lead_id, state, last_inbound_at, next_at, goal)
     VALUES ($1, $2, 'replied', $3, $3, $4)`,
    [runId, leadId, at, o.leadGoal ? JSON.stringify(o.leadGoal) : null],
  );
  return { leadId, threadId, runId };
}
const leadIn = async (runId: string) =>
  (
    await h.queryAll<{ state: string; reason: string | null; active: boolean; draft: string | null }>(
      "SELECT state, reason, active, draft FROM autopilot_leads WHERE run_id = $1",
      [runId],
    )
  )[0]!;
const outbox = () =>
  h.queryAll<{
    id: string;
    status: string;
    tag: string | null;
    autopilot_run_id: string | null;
    text: string;
  }>("SELECT id, status, tag, autopilot_run_id, text, problem FROM instagram_outbox ORDER BY created_at");
/** LUME AI until it has nothing due; then what it wrote has been revealed and goes. */
const tick = async (ms = 0) => {
  if (ms) h.clock.advance(ms);
  await h.runAutopilot();
};

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    licence: licence.options,
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
    ai: { read: (r) => provider.read(r), name: "fake", model: "fake-1" },
  });
  h.setRelayUrl("https://relay.test");
  h.clock.now = new Date("2026-11-23T08:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  h.clock.advance(3 * 24 * H);
  await h.queryAll("DELETE FROM autopilot_runs");
  await h.ownerPool.query(
    "TRUNCATE activities, instagram_threads, instagram_events, instagram_comments, instagram_outbox CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices");
  h.instagramSendQueued.length = 0;
  ig.sent.length = 0;
  ig.tokens.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await (await as()).inject({ method: "POST", url: "/api/v1/licence/check" });
  account = await seedIgAccount(h, { runAs: admin.id });
  await (await as()).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
});

describe("LUME AI on Instagram (plan 2026-11-27-instagram-lume-ai, Task 2)", () => {
  it("answers inside the 24 hours: one Instagram message, LUME AI's, never the human agent tag", async () => {
    const { runId, threadId, leadId } = await setUp();
    provider.script("autopilot_reply", [reply("Yes, there is room this week. Would you like the details?")]);
    await tick();
    expect((await leadIn(runId)).state).toBe("writing");
    // The model was told it writes on Instagram, at most 1,000 bytes.
    const read = provider.calls.at(-1)!;
    expect(read.instructions).toContain("on Instagram");
    expect(read.instructions).not.toContain("WhatsApp");
    // It reads the Instagram conversation.
    expect(JSON.parse(read.input).thread).toEqual([
      expect.objectContaining({ from: "lead", text: "Any slots Monday?" }),
    ]);
    await tick(2 * MIN);
    const [m] = await outbox();
    expect(m).toMatchObject({ autopilot_run_id: runId, tag: null, status: "queued" });
    expect((await leadIn(runId)).state).toBe("talking");
    // Answered, it waits for them to write: the run isn't stepped again for nothing.
    expect(await dueRuns(h.ownerPool, h.clock.now)).not.toContain(runId);
    // LUME AI's message is no person's: the conversation isn't taken over by it.
    const [t] = await h.queryAll<{ taken_over_by: string | null }>(
      "SELECT taken_over_by FROM instagram_threads WHERE id = $1",
      [threadId],
    );
    expect(t!.taken_over_by).toBeNull();
    await h.runInstagramSend();
    expect(ig.sent).toHaveLength(1);
    expect(ig.sent[0]!.body).not.toHaveProperty("tag");
    expect((await outbox())[0]!.status).toBe("sent");
    // The lead's Instagram tab: LUME AI has the conversation, and its message says it's LUME AI's.
    const tab = (
      await (await as()).inject({ method: "GET", url: `/api/v1/leads/${leadId}/instagram` })
    ).json();
    expect(tab.threads[0].ai).toEqual({ runId, paused: false });
    expect(tab.threads[0].messages.at(-1)).toMatchObject({ direction: "out", ai: true });
    // The LUME AI page says where it answers from: the account.
    const list = (await (await as()).inject({ method: "GET", url: "/api/v1/autopilot/runs" })).json();
    expect(list.runs.find((r: { id: string }) => r.id === runId)).toMatchObject({
      name: "New DMs on @harbour.studio",
      number: "@harbour.studio",
    });
  });

  it("answered, then quiet: when Instagram's 24 hours end the lead is let go, free for flows and other runs", async () => {
    const { runId } = await setUp();
    provider.script("autopilot_reply", [reply("Yes, there is room this week.")]);
    await tick();
    await tick(2 * MIN);
    expect((await leadIn(runId)).state).toBe("talking");
    // Woken when the 24 hours end, not before.
    await tick(12 * H);
    expect((await leadIn(runId)).active).toBe(true);
    await tick(13 * H);
    expect(await leadIn(runId)).toMatchObject({ active: false, reason: IG_LET_GO });
  });

  it("this month's AI leads used up: a person answers now, never left waiting past the 24 hours", async () => {
    licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiLeadsMonthly: 0 });
    await (await as()).inject({ method: "POST", url: "/api/v1/licence/check" });
    const { runId } = await setUp();
    await tick();
    expect(await leadIn(runId)).toMatchObject({ state: "needs_you", reason: IG_NO_AI_LEADS });
    expect(await outbox()).toHaveLength(0);
  });

  it("the 24 hours ran out unanswered: a person's, with the day and time they can still answer until", async () => {
    const before = provider.calls.length;
    const { runId } = await setUp({ ago: 25 * H });
    await tick();
    const l = await leadIn(runId);
    expect(l.state).toBe("needs_you");
    expect(l.reason).toMatch(
      /^Instagram's 24 hours ran out\. A person can still answer until \w+day, \w+ \d+, \d+:\d\d [ap]m\.$/,
    );
    expect(await outbox()).toHaveLength(0);
    // Nothing read for it: no AI lead spent on a conversation LUME AI can't answer.
    expect(provider.calls.length).toBe(before);
  });

  it("the 24 hours close while LUME AI is writing: the draft is dropped and a person gets the lead", async () => {
    const { runId } = await setUp({ ago: 24 * H - 30 * S });
    provider.script("autopilot_reply", [reply("Yes, there is room this week.")]);
    await tick();
    expect((await leadIn(runId)).state).toBe("writing");
    await tick(2 * MIN);
    const l = await leadIn(runId);
    expect(l.state).toBe("needs_you");
    expect(l.draft).toBeNull();
    expect(l.reason).toMatch(/^Instagram's 24 hours ran out\. A person can still answer until /);
    expect(await outbox()).toHaveLength(0);
  });

  it("a queued message of LUME AI's after the 24 hours is never sent, and never with the human agent tag", async () => {
    const { runId } = await setUp();
    provider.script("autopilot_reply", [reply("Yes, there is room this week.")]);
    await tick();
    await tick(2 * MIN);
    expect(await outbox()).toHaveLength(1);
    h.clock.advance(25 * H);
    await h.runInstagramSend();
    expect(ig.sent).toHaveLength(0);
    expect((await outbox())[0]).toMatchObject({ status: "failed", tag: null, autopilot_run_id: runId });
  });

  it("a person took the conversation over: LUME AI's queued message never goes", async () => {
    const { runId, threadId } = await setUp();
    provider.script("autopilot_reply", [reply("Yes, there is room this week.")]);
    await tick();
    await tick(2 * MIN);
    await h.queryAll("UPDATE instagram_threads SET taken_over_by = $2, taken_over_at = now() WHERE id = $1", [
      threadId,
      admin.id,
    ]);
    await h.runInstagramSend();
    expect(ig.sent).toHaveLength(0);
    expect((await outbox())[0]!.status).not.toBe("sent");
    expect(runId).toBeTruthy();
  });

  it("a person took the conversation over while LUME AI wrote: its draft never goes", async () => {
    const { runId, threadId } = await setUp();
    provider.script("autopilot_reply", [reply("Yes, there is room this week.")]);
    await tick();
    await h.queryAll("UPDATE instagram_threads SET taken_over_by = $2, taken_over_at = now() WHERE id = $1", [
      threadId,
      admin.id,
    ]);
    await tick(2 * MIN);
    expect(await outbox()).toHaveLength(0);
    expect(await leadIn(runId)).toMatchObject({
      state: "needs_you",
      reason: "A person took this conversation over, so LUME AI leaves it to them.",
    });
  });

  it("paused after its message was queued: it never goes", async () => {
    const { runId } = await setUp();
    provider.script("autopilot_reply", [reply("Yes, there is room this week.")]);
    await tick();
    await tick(2 * MIN);
    await h.queryAll("UPDATE autopilot_runs SET status = 'paused', pause_reason = 'person' WHERE id = $1", [
      runId,
    ]);
    await h.runInstagramSend();
    expect(ig.sent).toHaveLength(0);
    expect((await outbox())[0]!.status).toBe("cancelled");
  });

  it("a reply over Instagram's 1,000 bytes is never cut or sent: a person gets the lead", async () => {
    const { runId } = await setUp();
    // 400 characters, 1,200 bytes (each letter three bytes): under WhatsApp's limit, over Instagram's.
    provider.script("autopilot_reply", [reply("क".repeat(400))]);
    await tick();
    await tick(2 * MIN);
    const l = await leadIn(runId);
    expect(l.state).toBe("needs_you");
    expect(l.reason).toBe("LUME AI's reply was too long for Instagram.");
    expect(await outbox()).toHaveLength(0);
  });

  it("stop: do not contact, out of the run, and the one apology goes on Instagram", async () => {
    const { runId, leadId } = await setUp({ text: "stop" });
    await tick();
    const l = await leadIn(runId);
    expect(l).toMatchObject({ state: "stopped", active: false });
    const [lead] = await h.queryAll<{ dnc_at: Date | null; dnc_reason: string | null }>(
      "SELECT dnc_at, dnc_reason FROM leads WHERE id = $1",
      [leadId],
    );
    expect(lead!.dnc_at).not.toBeNull();
    expect(lead!.dnc_reason).toBe("Said stop on Instagram");
    const sent = await outbox();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/^Sorry for the messages\./);
    await h.runInstagramSend();
    expect(ig.sent).toHaveLength(1);
  });

  it("the account needs connecting again: the run pauses, nothing read or sent", async () => {
    const before = provider.calls.length;
    const { runId } = await setUp();
    await h.ownerPool.query("UPDATE instagram_accounts SET status = 'needs_attention' WHERE id = $1", [
      account.id,
    ]);
    await tick();
    const [r] = await h.queryAll<{ status: string; pause_reason: string | null }>(
      "SELECT status, pause_reason FROM autopilot_runs WHERE id = $1",
      [runId],
    );
    expect(r).toMatchObject({ status: "paused", pause_reason: "number" });
    expect(provider.calls.length).toBe(before);
    expect(await outbox()).toHaveLength(0);
  });

  it("a lead's own goal (a flow's hand-off) decides over the run's: reached when the lead moves into its stage", async () => {
    const cfg = await h.config();
    const [goal] = await h.queryAll<{ id: string; name: string }>(
      "SELECT id, name FROM stages WHERE pipeline_id = $1 AND kind = 'open' AND id <> $2 AND archived_at IS NULL LIMIT 1",
      [cfg.pipelineId, cfg.stages.New],
    );
    const { id: stageId, name } = goal!;
    const { runId, leadId } = await setUp({ leadGoal: { kind: "stage", stageId } });
    await h.queryAll("UPDATE leads SET stage_id = $2, stage_entered_at = now() WHERE id = $1", [
      leadId,
      stageId,
    ]);
    await tick();
    const l = await leadIn(runId);
    expect(l.state).toBe("ready");
    expect(l.reason).toBe(`Reached ${name}`);
  });
});
