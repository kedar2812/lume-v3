import { randomUUID } from "node:crypto";
import pg from "pg";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  IG_ACCOUNT,
  IGSID,
  igDm,
  igEcho,
  igEnvelope,
} from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliverIg, IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";
import { IG_MAYBE_SENT } from "./sender";

/**
 * Who answers an Instagram DM (spec 2026-11-22 §2; plan 2026-11-27-instagram-lume-ai, Task 3): a person who took it
 * over; else the LUME AI run working this conversation; else a flow; else, for a DM no flow claims, LUME AI when the
 * account says so and its 24 hours are open; else the team. Each row wins over the ones below it.
 */
const MIN = 60_000;
const H = 60 * MIN;
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
let account: { id: string; sourceId: string };
const licence = testLicence({ instanceId: "LUME-TEST-IG-ROUTE", now: () => h.clock.now });
const provider = fakeProvider();
const as = () => h.signIn(admin);
let n = 0;

/** A DM from the one person, now. */
const dm = async (text: string) => {
  await deliverIg(h, igDm({ mid: `aWdfR${++n}`, text, at: h.clock.now.toISOString() }));
  await h.runInstagram();
};
const standing = () =>
  h.queryAll<{ id: string; name: string; status: string; standing: boolean; channel: string }>(
    "SELECT id, name, status, standing, channel FROM autopilot_runs WHERE instagram_account_id = $1",
    [account.id],
  );
const aiLeads = () =>
  h.queryAll<{ run_id: string; lead_id: string; state: string; active: boolean; goal: unknown }>(
    "SELECT run_id, lead_id, state, active, goal FROM autopilot_leads ORDER BY updated_at",
  );
const leadOf = async () =>
  (
    await h.queryAll<{ lead_id: string; id: string }>(
      "SELECT id, lead_id FROM instagram_threads WHERE igsid = $1",
      [IGSID],
    )
  )[0]!;
const flowRuns = () => h.queryAll<{ status: string }>("SELECT status FROM instagram_flow_runs");

/** A live flow started by a keyword DM, published straight in the tables (the API is tested on its own). */
async function liveFlow(steps: unknown[], keywords: string[]) {
  const id = randomUUID();
  const vid = randomUUID();
  await h.ownerPool.query(
    "INSERT INTO instagram_flows (id, name, status, priority, draft_steps, created_by) VALUES ($1, 'Prices', 'draft', 0, $2, $3)",
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
     VALUES ($1, $2, 'dm', $3, 'word', '{}', '{}', 24)`,
    [randomUUID(), id, keywords],
  );
  return id;
}
const setNewDms = (to: "team" | "ai") =>
  h.ownerPool.query("UPDATE instagram_accounts SET new_dms = $2 WHERE id = $1", [account.id, to]);

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
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query(
    "TRUNCATE leads, activities, instagram_threads, instagram_events, instagram_comments, instagram_outbox, instagram_flows, notifications CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices");
  h.instagramQueued.length = 0;
  h.instagramSendQueued.length = 0;
  ig.sent.length = 0;
  ig.tokens.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await (await as()).inject({ method: "POST", url: "/api/v1/licence/check" });
  account = await seedIgAccount(h, { runAs: admin.id, owner: admin.id });
  await (await as()).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
});

describe("who answers a new DM", () => {
  it("Your team (the default): nothing automated, LUME AI reads what it means", async () => {
    await dm("Hi, how much is the course?");
    expect(await standing()).toHaveLength(0);
    expect(await aiLeads()).toHaveLength(0);
  });

  it("LUME AI: the account's standing run, made on first need, takes it; a second DM is the same conversation", async () => {
    await setNewDms("ai");
    await dm("Hi, how much is the course?");
    const [run] = await standing();
    expect(run).toMatchObject({
      name: "New DMs on @harbour.studio",
      status: "running",
      standing: true,
      channel: "instagram",
    });
    const t = await leadOf();
    expect(await aiLeads()).toEqual([
      expect.objectContaining({ run_id: run!.id, lead_id: t.lead_id, state: "replied" }),
    ]);
    await dm("And is there a weekend batch?");
    expect(await standing()).toHaveLength(1);
    expect(await aiLeads()).toHaveLength(1);
  });

  it("LUME AI switched off: the team, as if it were never chosen", async () => {
    await setNewDms("ai");
    await (await as()).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: false } });
    await dm("Hi, how much is the course?");
    expect(await aiLeads()).toHaveLength(0);
  });

  it("the standing run paused: new DMs go to the team, never parked unanswered", async () => {
    await setNewDms("ai");
    await dm("Hi");
    const [run] = await standing();
    await h.queryAll("UPDATE autopilot_runs SET status = 'paused', pause_reason = 'person' WHERE id = $1", [
      run!.id,
    ]);
    await h.queryAll("DELETE FROM autopilot_leads");
    await dm("Hello again");
    expect(await aiLeads()).toHaveLength(0);
  });

  it("paused because the account wasn't connected: the next DM, once it is, carries it on (review M4)", async () => {
    await setNewDms("ai");
    await dm("Hi");
    const [run] = await standing();
    await h.queryAll("UPDATE autopilot_runs SET status = 'paused', pause_reason = 'number' WHERE id = $1", [
      run!.id,
    ]);
    await h.queryAll("DELETE FROM autopilot_leads");
    await dm("Hello again");
    expect((await standing())[0]).toMatchObject({ id: run!.id, status: "running" });
    expect(await aiLeads()).toEqual([expect.objectContaining({ run_id: run!.id, state: "replied" })]);
    const said = await h.queryAll<{ kind: string }>(
      "SELECT kind FROM autopilot_events WHERE run_id = $1 AND lead_id IS NULL AND kind = 'resumed'",
      [run!.id],
    );
    expect(said).toHaveLength(1);
    // Paused again with the lead it holds: their next message carries it on too, and LUME AI answers them.
    await h.queryAll("UPDATE autopilot_runs SET status = 'paused', pause_reason = 'number' WHERE id = $1", [
      run!.id,
    ]);
    await h.queryAll("UPDATE autopilot_leads SET state = 'talking', next_at = NULL WHERE run_id = $1", [
      run!.id,
    ]);
    await dm("Are you there?");
    expect((await standing())[0]).toMatchObject({ id: run!.id, status: "running" });
    expect(await aiLeads()).toEqual([
      expect.objectContaining({ run_id: run!.id, state: "replied", active: true }),
    ]);
  });

  it("paused for the account, which still needs attention: a DM never carries it on (it would only pause again)", async () => {
    await setNewDms("ai");
    await dm("Hi");
    const [run] = await standing();
    await h.queryAll("UPDATE autopilot_runs SET status = 'paused', pause_reason = 'number' WHERE id = $1", [
      run!.id,
    ]);
    await h.queryAll("DELETE FROM autopilot_leads");
    await h.ownerPool.query("UPDATE instagram_accounts SET status = 'needs_attention' WHERE id = $1", [
      account.id,
    ]);
    await dm("Hello again");
    expect((await standing())[0]).toMatchObject({ status: "paused" });
    expect(await aiLeads()).toHaveLength(0);
  });

  it("a tap on a button while LUME AI holds the conversation reaches LUME AI, never a flow (review M6)", async () => {
    await setNewDms("ai");
    await dm("Hi");
    const [run] = await standing();
    // LUME AI answered: the lead waits for them.
    await h.queryAll("UPDATE autopilot_leads SET state = 'talking', next_at = NULL WHERE run_id = $1", [
      run!.id,
    ]);
    await liveFlow([{ id: "m", type: "send", text: "From the flow" }], ["book"]);
    await deliverIg(
      h,
      igEnvelope([
        {
          sender: { id: IGSID },
          recipient: { id: IG_ACCOUNT },
          timestamp: h.clock.now.getTime(),
          postback: { mid: `aWdfPB${++n}`, title: "Book a call", payload: "step:3:book" },
        },
      ]),
    );
    await h.runInstagram();
    expect(await aiLeads()).toEqual([
      expect.objectContaining({ run_id: run!.id, state: "replied", active: true }),
    ]);
    expect(await flowRuns()).toHaveLength(0);
    // A button's words are never read as a stop, whatever they say.
    await deliverIg(
      h,
      igEnvelope([
        {
          sender: { id: IGSID },
          recipient: { id: IG_ACCOUNT },
          timestamp: h.clock.now.getTime(),
          postback: { mid: `aWdfPB${++n}`, title: "Not interested", payload: "step:3:no" },
        },
      ]),
    );
    await h.runInstagram();
    const t = await leadOf();
    const [lead] = await h.queryAll<{ dnc_at: Date | null }>("SELECT dnc_at FROM leads WHERE id = $1", [
      t.lead_id,
    ]);
    expect(lead!.dnc_at).toBeNull();
    expect((await aiLeads())[0]).toMatchObject({ state: "replied", active: true });
  });

  it("paused by a person, or for its speaker: a DM never carries it on (their choice stands)", async () => {
    await setNewDms("ai");
    await dm("Hi");
    const [run] = await standing();
    for (const reason of ["person", "speaker", "month"]) {
      await h.queryAll("UPDATE autopilot_runs SET status = 'paused', pause_reason = $2 WHERE id = $1", [
        run!.id,
        reason,
      ]);
      await h.queryAll("DELETE FROM autopilot_leads");
      await dm(`Hello (${reason})`);
      expect((await standing())[0]).toMatchObject({ status: "paused" });
      expect(await aiLeads()).toHaveLength(0);
    }
  });

  it("a flow's keyword wins over LUME AI for a new DM; LUME AI holding the lead wins over the flow", async () => {
    await liveFlow([{ id: "p", type: "send", text: "Prices are in the guide." }], ["price"]);
    await setNewDms("ai");
    await dm("price");
    expect(await flowRuns()).toHaveLength(1);
    expect(await aiLeads()).toHaveLength(0);
    // Now held by LUME AI (the team handed it over): the keyword again is LUME AI's, no flow starts.
    await h.queryAll("TRUNCATE instagram_flow_runs CASCADE");
    await dm("hi there");
    expect(await aiLeads()).toHaveLength(1);
    await dm("price");
    expect(await flowRuns()).toHaveLength(0);
    expect((await aiLeads())[0]!.state).toBe("replied");
  });

  it("taken over by a person: nothing automated, LUME AI's run keeps it with that person", async () => {
    await setNewDms("ai");
    await dm("Hi");
    const t = await leadOf();
    const take = await (
      await as()
    ).inject({ method: "POST", url: `/api/v1/instagram/threads/${t.id}/take-over` });
    expect(take.statusCode, take.body).toBe(200);
    expect((await aiLeads())[0]!.state).toBe("with_you");
    await dm("Still there?");
    expect((await aiLeads())[0]!.state).toBe("with_you");
    // Handed back inside the 24 hours, unanswered: LUME AI answers it again.
    await (await as()).inject({ method: "POST", url: `/api/v1/instagram/threads/${t.id}/hand-back` });
    expect((await aiLeads())[0]!.state).toBe("replied");
  });

  it("a person's reply from LUME takes it from LUME AI at once", async () => {
    await setNewDms("ai");
    await dm("Hi");
    const t = await leadOf();
    const r = await (
      await as()
    ).inject({
      method: "POST",
      url: `/api/v1/leads/${t.lead_id}/instagram/messages`,
      payload: { clientKey: randomUUID(), threadId: t.id, text: "Hi! I can help." },
    });
    expect(r.statusCode, r.body).toBe(202);
    expect((await aiLeads())[0]!.state).toBe("with_you");
  });

  it("the business answering from the Instagram app takes it from LUME AI too", async () => {
    await setNewDms("ai");
    await dm("Hi");
    await deliverIg(
      h,
      igEcho({ mid: "aWdfECHO9", text: "Hi! Answering from the app.", at: h.clock.now.toISOString() }),
    );
    await h.runInstagram();
    expect((await aiLeads())[0]!.state).toBe("with_you");
  });

  it("the echo of LUME AI's own message whose answer was lost is that message, never a person's reply (review M7)", async () => {
    await setNewDms("ai");
    await dm("Hi");
    const [run] = await standing();
    const t = await leadOf();
    const lost = randomUUID();
    await h.queryAll(
      `INSERT INTO instagram_outbox (id, client_key, account_id, thread_id, lead_id, user_id, kind, text, status, problem,
                                     autopilot_run_id)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 'dm', 'Yes, there is room this week.', 'failed', $6, $7)`,
      [lost, account.id, t.id, t.lead_id, admin.id, IG_MAYBE_SENT, run!.id],
    );
    await deliverIg(
      h,
      igEcho({ mid: "aWdfLOST1", text: "Yes, there is room this week.", at: h.clock.now.toISOString() }),
    );
    await h.runInstagram();
    expect((await aiLeads())[0]!.state).not.toBe("with_you");
    const [th] = await h.queryAll<{ taken_over_by: string | null }>(
      "SELECT taken_over_by FROM instagram_threads WHERE id = $1",
      [t.id],
    );
    expect(th!.taken_over_by).toBeNull();
    expect(
      await h.queryAll("SELECT status, mid, problem FROM instagram_outbox WHERE id = $1", [lost]),
    ).toEqual([{ status: "sent", mid: "aWdfLOST1", problem: null }]);
    // Not matched, so a person's reply as ever: a lost one of LUME AI's with other words, one older than a day, and
    // a person's own lost one from LUME (no run).
    const lostRow = async (text: string, o: { ai: boolean; ago?: string }) => {
      const id = randomUUID();
      await h.queryAll(
        `INSERT INTO instagram_outbox (id, client_key, account_id, thread_id, lead_id, user_id, kind, text, status,
                                       problem, autopilot_run_id, created_at)
         VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, 'dm', $6, 'failed', $7, $8, now() - $9::interval)`,
        [id, account.id, t.id, t.lead_id, admin.id, text, IG_MAYBE_SENT, o.ai ? run!.id : null, o.ago ?? "0"],
      );
      return id;
    };
    const rows = [
      await lostRow("Friday works too.", { ai: true }),
      await lostRow("Old words.", { ai: true, ago: "2 days" }),
      await lostRow("Old words.", { ai: false }),
    ];
    await deliverIg(h, igEcho({ mid: "aWdfLOST2", text: "Old words.", at: h.clock.now.toISOString() }));
    await h.runInstagram();
    expect((await aiLeads())[0]!.state).toBe("with_you");
    expect(await h.queryAll("SELECT status FROM instagram_outbox WHERE id = ANY($1)", [rows])).toEqual([
      { status: "failed" },
      { status: "failed" },
      { status: "failed" },
    ]);
  });

  it("handed back after the person answered: LUME AI waits for them, never answering what was answered", async () => {
    await setNewDms("ai");
    await dm("Hi");
    const t = await leadOf();
    const r = await (
      await as()
    ).inject({
      method: "POST",
      url: `/api/v1/leads/${t.lead_id}/instagram/messages`,
      payload: { clientKey: randomUUID(), threadId: t.id, text: "Hi! I can help." },
    });
    expect(r.statusCode, r.body).toBe(202);
    await h.runInstagramSend();
    await (await as()).inject({ method: "POST", url: `/api/v1/instagram/threads/${t.id}/hand-back` });
    expect((await aiLeads())[0]!.state).toBe("talking");
    // Then they write while it's taken over, and it's handed back unanswered: LUME AI answers it.
    await (await as()).inject({ method: "POST", url: `/api/v1/instagram/threads/${t.id}/take-over` });
    h.clock.advance(MIN);
    await dm("And the price?");
    await (await as()).inject({ method: "POST", url: `/api/v1/instagram/threads/${t.id}/hand-back` });
    expect((await aiLeads())[0]!.state).toBe("replied");
  });

  it("an account whose person can't message the lead: the team answers, LUME AI never holds what it can't reach", async () => {
    const rep = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "own" },
        { key: "messages.send", scope: "own" },
      ],
    });
    await h.ownerPool.query("UPDATE instagram_accounts SET owner_user_id = $2 WHERE id = $1", [
      account.id,
      rep.id,
    ]);
    // The source gives its leads to someone else.
    await h.ownerPool.query("UPDATE lead_sources SET rules = rules || $2::jsonb WHERE id = $1", [
      account.sourceId,
      JSON.stringify({ owner: { mode: "user", userId: admin.id } }),
    ]);
    await setNewDms("ai");
    await dm("Hi");
    // The lead is the admin's, so the rep (who LUME AI speaks as) can't message it: the team's.
    expect(await aiLeads()).toHaveLength(0);
  });

  it("this month's AI leads used up: new DMs go to the team", async () => {
    licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiLeadsMonthly: 0 });
    await (await as()).inject({ method: "POST", url: "/api/v1/licence/check" });
    await setNewDms("ai");
    await dm("Hi");
    expect(await aiLeads()).toHaveLength(0);
  });

  it("handed back after the 24 hours: to the team, never LUME AI (it can't answer)", async () => {
    await setNewDms("ai");
    await dm("Hi");
    const t = await leadOf();
    await (await as()).inject({ method: "POST", url: `/api/v1/instagram/threads/${t.id}/take-over` });
    h.clock.advance(25 * H);
    await (await as()).inject({ method: "POST", url: `/api/v1/instagram/threads/${t.id}/hand-back` });
    await h.runAutopilot();
    const [l] = await aiLeads();
    expect(l!.state).toBe("needs_you");
    expect(ig.sent).toHaveLength(0);
  });

  it("a lead a WhatsApp run holds: LUME AI never answers their Instagram DM from WhatsApp", async () => {
    await setNewDms("ai");
    await dm("Hi");
    const t = await leadOf();
    // The lead in a WhatsApp run instead: one run per lead, so the standing run can't take them.
    await h.queryAll("DELETE FROM autopilot_leads");
    const numberId = await seedNumber(h, { runAs: admin.id });
    const wa = randomUUID();
    await h.queryAll(
      `INSERT INTO autopilot_runs (id, name, started_by, speaker_id, channel, number_id, goal, permissions, follow_up_days,
                                   outside_hours)
       VALUES ($1, 'Spring', $2, $2, 'whatsapp', $3, '{"kind":"stage","stageId":"00000000-0000-0000-0000-000000000000"}',
               '{}', '{}', 'wait')`,
      [wa, admin.id, numberId],
    );
    await h.queryAll(
      "INSERT INTO autopilot_leads (run_id, lead_id, state, next_at) VALUES ($1, $2, 'sent', $3)",
      [wa, t.lead_id, new Date(h.clock.now.getTime() + 24 * H)],
    );
    await dm("Hello?");
    // Untouched: not "replied" (LUME AI would answer on WhatsApp), and no second run took them.
    expect(await aiLeads()).toEqual([expect.objectContaining({ run_id: wa, state: "sent", active: true })]);
    // A person answering them on Instagram doesn't take them from the WhatsApp run either.
    const r = await (
      await as()
    ).inject({
      method: "POST",
      url: `/api/v1/leads/${t.lead_id}/instagram/messages`,
      payload: { clientKey: randomUUID(), threadId: t.id, text: "Hi! On it." },
    });
    expect(r.statusCode, r.body).toBe(202);
    expect((await aiLeads())[0]!.state).toBe("sent");
  });
});

describe("Who replied: Let LUME AI handle these, on Instagram", () => {
  const handle = async (leadIds: string[]) =>
    (await as()).inject({ method: "POST", url: "/api/v1/instagram/ai/handle", payload: { leadIds } });

  it("inside the 24 hours: LUME AI's standing run takes them and answers; after them: skipped, and why", async () => {
    await dm("Hi, how much is the course?");
    const t = await leadOf();
    const r = await handle([t.lead_id]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ given: 1, skipped: [] });
    expect(await aiLeads()).toEqual([expect.objectContaining({ lead_id: t.lead_id, state: "replied" })]);
    // Again: already LUME AI's, one lead row.
    expect((await handle([t.lead_id])).json().given).toBe(1);
    expect(await aiLeads()).toHaveLength(1);
    h.clock.advance(25 * H);
    await h.queryAll("DELETE FROM autopilot_leads");
    expect((await handle([t.lead_id])).json()).toEqual({
      given: 0,
      skipped: [{ leadId: t.lead_id, why: "Instagram's 24 hours to answer are over." }],
    });
  });

  it("LUME AI off: refused with why", async () => {
    await dm("Hi");
    const t = await leadOf();
    await (await as()).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: false } });
    const r = await handle([t.lead_id]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("AI_UNAVAILABLE");
  });
});

describe("a flow's Hand to LUME AI", () => {
  const handoff = [
    { id: "hi", type: "send", text: "Thanks! LUME AI will take it from here." },
    { id: "ai", type: "handoff", to: "ai", goal: { kind: "brief", text: "Book a trial class" } },
  ];
  it("ends the flow and starts LUME AI on the lead with the step's goal, once, even replayed", async () => {
    // Ahead of the server's own clock: only the flow's word that it answered, never clocks, decides.
    h.clock.now = new Date(Math.max(h.clock.now.getTime(), Date.now()) + 2 * 24 * H);
    await liveFlow(handoff, ["trial"]);
    await dm("trial");
    const [l] = await aiLeads();
    // The flow answered last ("LUME AI will take it from here"): LUME AI waits for them to write, never a second answer.
    expect(l).toMatchObject({ state: "talking", goal: { kind: "brief", text: "Book a trial class" } });
    await dm("Is Saturday possible?");
    expect((await aiLeads())[0]!.state).toBe("replied");
    // The same delivery again (Meta resends): one lead row, one run.
    await deliverIg(h, igDm({ mid: `aWdfR${n}`, text: "trial", at: h.clock.now.toISOString() }));
    await h.runInstagram();
    expect(await aiLeads()).toHaveLength(1);
    expect(await standing()).toHaveLength(1);
  });

  it("LUME AI off: the hand-off goes to a person instead, as Hand to a person does", async () => {
    await liveFlow(handoff, ["trial"]);
    await (await as()).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: false } });
    await dm("trial");
    expect(await aiLeads()).toHaveLength(0);
    // Notifications are their recipient's alone: read as the backup does.
    const reader = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
    await reader.connect();
    const { rows: notes } = await reader
      .query<{ title: string }>("SELECT title FROM notifications WHERE user_id = $1", [admin.id])
      .finally(() => reader.end());
    expect(notes.map((x) => x.title)).toEqual(
      expect.arrayContaining([expect.stringMatching(/needs you on Instagram$/)]),
    );
  });
});
