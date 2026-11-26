import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IGSID, igDm } from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliverIg, IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { fakeProvider } from "../../ai/fake";

/**
 * Who replied with Instagram (plan 2026-11-25-instagram-screens D6a): each lead once, under its newest reply on either
 * channel; the channel filter; each row's window in words; a flow's hand-offs first, until a person answers or takes
 * over, and never once a person can't answer any more; what was said to a flow still talking to them is the flow's.
 */
const H = 3_600_000;
let h: Harness;
let ig: InstagramFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
const licence = testLicence({ instanceId: "LUME-TEST-IGREPLIES", now: () => h.clock.now });
const provider = fakeProvider();

type Lead = {
  leadId: string;
  name: string;
  at: string;
  text: string | null;
  channel: string;
  window: { state: string; until: string | null };
  ownerName: string | null;
  flow?: { name: string; note: string | null };
};
type Board = { channel: string; groups: { group: string; count: number; leads: Lead[] }[] };
const board = async (u: U, channel?: string) =>
  (
    await (
      await h.signIn(u)
    ).inject({
      method: "GET",
      url: `/api/v1/whatsapp/replies${channel ? `?channel=${channel}` : ""}`,
    })
  ).json() as Board;
const listed = (b: Board) => b.groups.flatMap((g) => g.leads.map((l) => ({ group: g.group, ...l })));

let n = 0;
const says = async (text: string) => {
  h.clock.advance(60_000);
  const r = await deliverIg(h, igDm({ mid: `aWdfR${++n}`, at: h.clock.now.toISOString(), text }));
  expect(r.statusCode).toBe(200);
  await h.runInstagram();
};
const theLead = async () =>
  (await h.queryAll<{ id: string }>("SELECT id FROM leads WHERE deleted_at IS NULL"))[0]!.id;
const theThread = async () => (await h.queryAll<{ id: string }>("SELECT id FROM instagram_threads"))[0]!.id;

/** A live DM-keyword flow with these steps. */
async function liveFlow(name: string, keyword: string, steps: unknown[]) {
  const id = randomUUID();
  const vid = randomUUID();
  await h.ownerPool.query(
    "INSERT INTO instagram_flows (id, name, status, priority, draft_steps, created_by) VALUES ($1, $2, 'draft', 0, $3, $4)",
    [id, name, JSON.stringify(steps), admin.id],
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
    [randomUUID(), id, `{${keyword}}`],
  );
}
/** A flow that passes the conversation to a person at once. */
const passes = () =>
  liveFlow("Qualify and book", "plan", [
    { id: "pass", type: "handoff", to: "person", note: "wants a custom plan" },
  ]);

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
  admin = await h.seedUser({ owner: true, name: "Maya Kapoor", grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ name: "Rahul Mehta", grants: [{ key: "leads.view", scope: "own" }], totp: false });
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await (await h.signIn(admin)).inject({ method: "POST", url: "/api/v1/licence/check" });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  h.clock.advance(H);
  await h.ownerPool.query(
    "TRUNCATE leads, activities, ai_reads, instagram_threads, instagram_events, instagram_outbox, instagram_flows, notifications CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  h.instagramQueued.length = 0;
  h.whatsappMeaningQueued.length = 0;
  ig.tokens.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  ig.profiles.set(IGSID, { name: "Priya Shah", username: "priya.fit" });
  await seedIgAccount(h, { runAs: admin.id, owner: admin.id });
});

describe("Who replied with Instagram", () => {
  it("a lead who wrote on both is listed once, under the newest; each channel on its own when asked", async () => {
    await says("Is the evening batch the same price?");
    // When they wrote (delivery itself takes the harness's clock a moment on).
    const [first] = await h.queryAll<{ at: Date }>(
      "SELECT occurred_at AS at FROM activities WHERE type = 'instagram_received'",
    );
    const wrote = first!.at.getTime();
    const lead = await theLead();
    await h.queryAll("UPDATE leads SET owner_id = $2 WHERE id = $1", [lead, admin.id]);
    // Earlier the same hour, on WhatsApp.
    await h.queryAll(
      `INSERT INTO activities (id, lead_id, type, occurred_at, payload)
       VALUES (gen_random_uuid(), $1, 'whatsapp_received', $2, '{"text":"Hi from WhatsApp"}'::jsonb)`,
      [lead, new Date(wrote - 30 * 60_000)],
    );
    const all = listed(await board(admin));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      group: "not_sure",
      leadId: lead,
      channel: "instagram",
      text: "Is the evening batch the same price?",
      ownerName: "Maya Kapoor",
      window: { state: "open", until: new Date(wrote + 24 * H).toISOString() },
    });
    expect(listed(await board(admin, "whatsapp"))).toMatchObject([
      { leadId: lead, channel: "whatsapp", text: "Hi from WhatsApp", window: { state: "open" } },
    ]);
    expect(listed(await board(admin, "instagram"))).toMatchObject([{ leadId: lead, channel: "instagram" }]);
    // After Instagram's 24 hours a person may still answer (7 days); after WhatsApp's, nobody but a template.
    h.clock.advance(25 * H);
    const later = await (
      await h.signIn(admin)
    ).inject({
      method: "GET",
      url: `/api/v1/whatsapp/replies?since=${encodeURIComponent(new Date(h.clock.now.getTime() - 3 * 24 * H).toISOString())}`,
    });
    expect(listed(later.json())[0]!.window.state).toBe("human");
    // Someone who can see only their own leads sees nothing of another's.
    expect(listed(await board(rep))).toEqual([]);
  });

  it("an unknown channel is refused", async () => {
    const r = await (
      await h.signIn(admin)
    ).inject({ method: "GET", url: "/api/v1/whatsapp/replies?channel=sms" });
    expect(r.statusCode).toBe(400);
  });

  it("what was said to a flow still talking to them is the flow's, not the board's", async () => {
    await liveFlow("Guide", "guide", [
      {
        id: "ask",
        type: "ask",
        text: "What's your email?",
        save: { field: "email", kind: "email" },
        fallback: "Again?",
      },
      { id: "bye", type: "send", text: "Thanks!" },
    ]);
    await says("guide");
    expect(listed(await board(admin))).toEqual([]);
  });

  describe("A flow passed these to you", () => {
    it("listed first, with the flow's name and why, and nowhere else", async () => {
      await passes();
      await says("Can you help with my knee injury?");
      // A keyword-less first message starts nothing: the flow starts on its keyword.
      await says("plan please");
      const b = await board(admin);
      expect(b.groups[0]!.group).toBe("flow_passed");
      expect(listed(b)).toMatchObject([
        {
          group: "flow_passed",
          leadId: await theLead(),
          channel: "instagram",
          text: "plan please",
          window: { state: "open" },
          flow: { name: "Qualify and book", note: "wants a custom plan" },
        },
      ]);
      // They write again before anyone answers: still the team's, with their newest words.
      await says("Also, do you do online sessions?");
      expect(listed(await board(admin))).toMatchObject([
        { group: "flow_passed", text: "Also, do you do online sessions?" },
      ]);
      // Someone who can't see the lead doesn't see its hand-off either.
      expect(listed(await board(rep))).toEqual([]);
    });

    it("out once a person answers", async () => {
      await passes();
      await says("plan please");
      const r = await (
        await h.signIn(admin)
      ).inject({
        method: "POST",
        url: `/api/v1/leads/${await theLead()}/instagram/messages`,
        payload: {
          clientKey: randomUUID(),
          threadId: await theThread(),
          text: "Sure, tell me more about the knee",
        },
      });
      expect(r.statusCode, r.body).toBeLessThan(300);
      expect(listed(await board(admin)).filter((l) => l.group === "flow_passed")).toEqual([]);
      // Handed back to the flows afterwards: answered is answered, it never comes back.
      h.clock.advance(60_000);
      const back = await (
        await h.signIn(admin)
      ).inject({ method: "POST", url: `/api/v1/instagram/threads/${await theThread()}/hand-back` });
      expect(back.statusCode, back.body).toBe(200);
      const [t] = await h.queryAll<{ taken_over_at: Date | null }>(
        "SELECT taken_over_at FROM instagram_threads",
      );
      expect(t!.taken_over_at).toBeNull();
      expect(listed(await board(admin)).filter((l) => l.group === "flow_passed")).toEqual([]);
    });

    it("one who asks to stop after the hand-off is under Stop messaging, not passed to the team", async () => {
      await passes();
      await says("plan please");
      await says("stop");
      expect(listed(await board(admin))).toMatchObject([{ group: "stop", text: "stop", doNotContact: true }]);
    });

    it("out once a person takes the conversation over", async () => {
      await passes();
      await says("plan please");
      h.clock.advance(60_000);
      const r = await (
        await h.signIn(admin)
      ).inject({ method: "POST", url: `/api/v1/instagram/threads/${await theThread()}/take-over` });
      expect(r.statusCode, r.body).toBe(200);
      expect(listed(await board(admin)).filter((l) => l.group === "flow_passed")).toEqual([]);
    });

    it("never once a person can't answer any more (Instagram's 7 days)", async () => {
      await passes();
      await says("plan please");
      h.clock.advance(7 * 24 * H + 60_000);
      const r = await (
        await h.signIn(admin)
      ).inject({
        method: "GET",
        url: `/api/v1/whatsapp/replies?since=${encodeURIComponent(new Date(h.clock.now.getTime() - 8 * 24 * H).toISOString())}`,
      });
      expect(listed(r.json()).filter((l) => l.group === "flow_passed")).toEqual([]);
    });
  });
});
