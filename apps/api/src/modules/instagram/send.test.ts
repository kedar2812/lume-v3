import { randomUUID } from "node:crypto";
import pg from "pg";
import { ALL_GRANTS, igOutboundBody } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IG_ACCOUNT, IGSID } from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { heldOpen } from "../../../test/held";
import { IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { rollupDays } from "../analytics/rollup";
import { IG_MAYBE_SENT, igPacer, sendInstagramOutbox } from "./sender";
import { whenWords } from "./send";

/** Replying on Instagram from LUME (NEW_FEATURES_PLAN §4.4; plan 1A Task 6). */
const H = 3_600_000;
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
let rep: { id: string; email: string; password: string };
let other: { id: string; email: string; password: string };
let account: { id: string; sourceId: string };
let leadId: string;
let threadId: string;

/** A conversation on a lead the rep owns, the person's last message `ago` ms before now. */
async function conversation(ago = H) {
  leadId = await h.seedLead({ ownerId: rep.id, name: "Priya Shah" });
  threadId = randomUUID();
  await h.queryAll(
    "INSERT INTO instagram_threads (id, account_id, igsid, lead_id, last_in_at) VALUES ($1, $2, $3, $4, $5)",
    [threadId, account.id, IGSID, leadId, new Date(h.clock.now.getTime() - ago)],
  );
}
const send = async (
  u: typeof rep,
  body: Partial<{
    clientKey: string;
    text: string;
    quickReplies: { title: string; payload: string }[];
    retryOf: string;
  }> = {},
  lead = leadId,
) =>
  (await h.signIn(u)).inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/instagram/messages`,
    payload: { clientKey: randomUUID(), threadId, text: "Yes, the batch starts Monday", ...body },
  });
const outbox = () =>
  h.queryAll<{
    id: string;
    status: string;
    mid: string | null;
    problem: string | null;
    tag: string | null;
    tries: number;
  }>("SELECT id, status, mid, problem, tag, tries FROM instagram_outbox ORDER BY created_at, id");
const sentToMeta = () => ig.sent.filter((s) => s.accountId === IG_ACCOUNT);

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
  });
  h.setRelayUrl("https://relay.test");
  h.clock.now = new Date("2026-11-22T06:10:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    name: "Rhea Rep",
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "messages.send", scope: "own" },
    ],
  });
  other = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "messages.send", scope: "own" },
    ],
  });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  h.clock.advance(H);
  await h.ownerPool.query(
    "TRUNCATE leads, activities, instagram_threads, instagram_events, instagram_comments, instagram_outbox, lead_firsts CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  await h.ownerPool.query("TRUNCATE notifications");
  h.instagramSendQueued.length = 0;
  ig.sent.length = 0;
  ig.calls.length = 0;
  ig.failNext.length = 0;
  ig.tokens.clear();
  ig.revoked.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  account = await seedIgAccount(h, { runAs: admin.id });
  await conversation();
});

describe("a reply inside Meta's 24 hours", () => {
  it("goes to Meta exactly once, is sent with Meta's id, and counts as a send", async () => {
    const r = await send(rep, { quickReplies: [{ title: "Book a call", payload: "book" }] });
    expect(r.statusCode).toBe(202);
    expect(r.json().message).toMatchObject({ status: "queued", sentBy: { id: rep.id }, humanAgent: false });
    await h.runInstagramSend();
    expect(sentToMeta().map((s) => s.body)).toEqual([
      igOutboundBody(
        { igsid: IGSID },
        { text: "Yes, the batch starts Monday", quickReplies: [{ title: "Book a call", payload: "book" }] },
      ),
    ]);
    const [o] = await outbox();
    expect(o).toMatchObject({ status: "sent", mid: sentToMeta()[0]!.mid, tag: null });
    const acts = await h.queryAll<{ type: string; user_id: string }>(
      "SELECT type, user_id FROM activities WHERE type = 'instagram_confirmed_sent'",
    );
    expect(acts).toEqual([{ type: "instagram_confirmed_sent", user_id: rep.id }]);
    const [f] = await h.queryAll<{ first_contact_at: Date | null }>(
      "SELECT first_contact_at FROM lead_firsts WHERE lead_id = $1",
      [leadId],
    );
    expect(f!.first_contact_at).not.toBeNull();
  });

  it("the person who wrote takes the conversation over", async () => {
    await send(rep);
    const [t] = await h.queryAll<{ taken_over_by: string }>("SELECT taken_over_by FROM instagram_threads");
    expect(t!.taken_over_by).toBe(rep.id);
  });

  it("the same key twice, or twice at once, is one message", async () => {
    const clientKey = randomUUID();
    const a = await send(rep, { clientKey });
    const b = await send(rep, { clientKey });
    expect(b.json().message.id).toBe(a.json().message.id);
    const k2 = randomUUID();
    const [c, d] = await Promise.all([send(rep, { clientKey: k2 }), send(rep, { clientKey: k2 })]);
    expect(c.json().message.id).toBe(d.json().message.id);
    expect(await outbox()).toHaveLength(2);
  });

  it("a key another tab is still writing is that message once it lands, never an error", async () => {
    const clientKey = randomUUID();
    const first = randomUUID();
    const held = await heldOpen(h, rep.id, (c) =>
      c.query(
        `INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, text, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'dm', 'Yes, the batch starts Monday', 'queued')`,
        [first, threadId, leadId, account.id, rep.id, clientKey],
      ),
    );
    const second = send(rep, { clientKey });
    await held.commitOnceWaited();
    const r = await second;
    expect(r.statusCode).toBe(202);
    expect(r.json().message.id).toBe(first);
    expect(await outbox()).toHaveLength(1);
  });

  it("refuses more than Instagram takes, in words", async () => {
    const r = await send(rep, { text: "क".repeat(334) });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/too long for Instagram/);
    const q = await send(rep, {
      quickReplies: Array.from({ length: 14 }, (_, i) => ({ title: `Q${i}`, payload: `${i}` })),
    });
    expect(q.json().error.message).toBe("Instagram allows at most 13 quick replies.");
    expect(await outbox()).toHaveLength(0);
  });

  it("someone who can't see the lead gets 404; one who can see it but not message it 403", async () => {
    expect((await send(other)).statusCode).toBe(404);
    const viewer = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
    expect((await send(viewer)).statusCode).toBe(403);
  });

  it("a conversation that isn't on this lead is 404", async () => {
    const elsewhere = await h.seedLead({ ownerId: rep.id });
    expect((await send(rep, {}, elsewhere)).statusCode).toBe(404);
  });
});

describe("in Analytics", () => {
  it("a sent Instagram message is a send, and the person writing back within 72 hours is its reply", async () => {
    await send(rep);
    await h.runInstagramSend();
    const sentAt = (
      await h.queryAll<{ occurred_at: Date }>(
        "SELECT occurred_at FROM activities WHERE type = 'instagram_confirmed_sent'",
      )
    )[0]!.occurred_at;
    await h.queryAll(
      "INSERT INTO activities (id, lead_id, type, occurred_at, payload) VALUES (gen_random_uuid(), $1, 'instagram_received', $2, '{}')",
      [leadId, new Date(sentAt.getTime() + H)],
    );
    const day = sentAt.toISOString().slice(0, 10);
    await rollupDays(h.pool, [day], "UTC");
    const slots = await h.queryAll<{ kind: string; n: number }>(
      "SELECT kind, sum(n)::int AS n FROM analytics_daily_slot WHERE day = $1 AND kind IN ('sends', 'replies') GROUP BY kind ORDER BY kind",
      [day],
    );
    expect(slots).toEqual([
      { kind: "replies", n: 1 },
      { kind: "sends", n: 1 },
    ]);
    const [f] = await h.queryAll<{ first_contact_at: Date; first_reply_at: Date }>(
      "SELECT first_contact_at, first_reply_at FROM lead_firsts WHERE lead_id = $1",
      [leadId],
    );
    expect(f!.first_reply_at.getTime()).toBe(sentAt.getTime() + H);
  });
});

describe("after 24 hours", () => {
  it("a person's reply goes with Meta's human agent tag, and says so", async () => {
    await h.ownerPool.query("TRUNCATE leads, instagram_threads CASCADE");
    await conversation(25 * H);
    const r = await send(rep);
    expect(r.json().message.humanAgent).toBe(true);
    await h.runInstagramSend();
    expect(sentToMeta()[0]!.body).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  });

  it("after 7 days nothing goes, and LUME says from when, on the business's clock, month first", async () => {
    await h.ownerPool.query("TRUNCATE leads, instagram_threads CASCADE");
    await conversation(7 * 24 * H + 60_000);
    const r = await send(rep);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("WINDOW_CLOSED");
    // The harness's business is in Asia/Dubai (UTC+4).
    const ended = new Date(h.clock.now.getTime() - 60_000);
    expect(r.json().error.message).toContain(whenWords(ended, "Asia/Dubai"));
    expect(whenWords(new Date("2026-11-22T10:05:00Z"), "Asia/Dubai")).toBe("November 22, 2:05 pm");
    expect(await outbox()).toHaveLength(0);
  });

  it("someone who never wrote can't be messaged at all (no cold DMs)", async () => {
    await h.queryAll("UPDATE instagram_threads SET last_in_at = NULL");
    const r = await send(rep);
    expect(r.json().error.code).toBe("WINDOW_CLOSED");
    expect(r.json().error.message).toMatch(/hasn't written/);
  });

  it("the window closing between Send and Meta: failed with words, never sent", async () => {
    await h.ownerPool.query("TRUNCATE leads, instagram_threads CASCADE");
    await conversation(7 * 24 * H - 60_000);
    await send(rep);
    h.clock.advance(2 * 60_000);
    await h.runInstagramSend();
    expect(sentToMeta()).toHaveLength(0);
    expect((await outbox())[0]).toMatchObject({
      status: "failed",
      problem: expect.stringMatching(/ran out/),
    });
  });

  it("a flow's message after 24 hours is never sent (the tag is a person's only)", async () => {
    await h.ownerPool.query("TRUNCATE leads, instagram_threads CASCADE");
    await conversation(25 * H);
    await h.queryAll(
      `INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, text, status, flow_run_id, step_key)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), 'dm', 'Step two', 'queued', gen_random_uuid(), '0')`,
      [threadId, leadId, account.id, admin.id],
    );
    const [o] = await outbox();
    await sendInstagramOutbox(
      {
        app: h.app,
        d: h.deps,
        pacer: igPacer({ now: () => h.clock.now, perSecond: 20 }),
        privateRepliesPerHour: 600,
      },
      o!.id,
    );
    expect(sentToMeta()).toHaveLength(0);
    expect((await outbox())[0]!.status).toBe("failed");
  });
});

describe("between Send and Meta", () => {
  it("do not contact set meanwhile: cancelled, never sent", async () => {
    await send(rep);
    await h.queryAll("UPDATE leads SET dnc_at = now(), dnc_reason = 'Said stop' WHERE id = $1", [leadId]);
    await h.runInstagramSend();
    expect(sentToMeta()).toHaveLength(0);
    expect((await outbox())[0]!.status).toBe("cancelled");
  });

  it("Instagram switched off meanwhile: nothing more goes", async () => {
    await send(rep);
    await h.ownerPool.query(`UPDATE settings SET integrations = integrations - 'instagram' WHERE id = 1`);
    await h.runInstagramSend();
    expect(sentToMeta()).toHaveLength(0);
    expect((await outbox())[0]).toMatchObject({
      status: "failed",
      problem: "Instagram was switched off before this went.",
    });
  });

  it("Instagram taken out of the plan meanwhile: nothing more goes, and it says why", async () => {
    await send(rep);
    const licence = h.app.licence;
    const view = licence.view.bind(licence);
    licence.view = () => {
      const v = view();
      return {
        ...v,
        plan: { places: null, ...v.plan, modules: { ...v.plan?.modules, instagram: false } },
      } as typeof v;
    };
    try {
      await h.runInstagramSend();
    } finally {
      licence.view = view;
    }
    expect(sentToMeta()).toHaveLength(0);
    expect((await outbox())[0]).toMatchObject({
      status: "failed",
      problem: "Instagram left this LUME's plan before this went.",
    });
  });

  it("a flow's message never goes into a conversation a person took over meanwhile", async () => {
    await h.queryAll(
      `INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, text, status, flow_run_id, step_key)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), 'dm', 'Step two', 'queued', gen_random_uuid(), '0')`,
      [threadId, leadId, account.id, admin.id],
    );
    await h.queryAll("UPDATE instagram_threads SET taken_over_by = $2, taken_over_at = now() WHERE id = $1", [
      threadId,
      rep.id,
    ]);
    const [o] = await outbox();
    await sendInstagramOutbox(
      {
        app: h.app,
        d: h.deps,
        pacer: igPacer({ now: () => h.clock.now, perSecond: 20 }),
        privateRepliesPerHour: 600,
      },
      o!.id,
    );
    expect(sentToMeta()).toHaveLength(0);
    expect((await outbox())[0]).toMatchObject({
      status: "failed",
      problem: "A person took this conversation over before this went.",
    });
  });

  it("the sender lost the lead meanwhile: failed with words", async () => {
    await send(rep);
    await h.queryAll("UPDATE leads SET owner_id = $2 WHERE id = $1", [leadId, other.id]);
    await h.runInstagramSend();
    expect(sentToMeta()).toHaveLength(0);
    expect((await outbox())[0]!.problem).toBe("Rhea Rep can't message this lead any more.");
  });

  it("two messages to one person go in the order they were sent", async () => {
    await send(rep, { text: "first" });
    h.clock.advance(1000);
    await send(rep, { text: "second" });
    // The second's job runs first: it waits for the first, which wakes it.
    h.instagramSendQueued.reverse();
    await h.runInstagramSend();
    await h.runInstagramSend();
    expect(sentToMeta().map((s) => (s.body.message as { text: string }).text)).toEqual(["first", "second"]);
  });
});

describe("when Meta says no", () => {
  it("busy twice, then taken: sent once, after three calls", async () => {
    ig.failNext.push(613, 4);
    await send(rep);
    await h.runInstagramSend();
    await h.runInstagramSend();
    await h.runInstagramSend();
    const calls = ig.calls.filter((c) => c.path.endsWith("/messages"));
    expect(calls).toHaveLength(3);
    expect(sentToMeta()).toHaveLength(1);
    expect((await outbox())[0]).toMatchObject({ status: "sent", tries: 3 });
  });

  it("an answer lost after Meta took it: failed with words, and never sent again", async () => {
    ig.failNext.push("lose");
    await send(rep);
    await h.runInstagramSend();
    await h.runInstagramSend();
    expect(ig.calls.filter((c) => c.path.endsWith("/messages"))).toHaveLength(1);
    expect((await outbox())[0]).toMatchObject({ status: "failed", problem: IG_MAYBE_SENT });
  });

  it("outside Meta's window (Meta's own word): failed, not tried again", async () => {
    ig.failNext.push({ code: 10, subcode: 2534022 });
    await send(rep);
    await h.runInstagramSend();
    await h.runInstagramSend();
    expect(ig.calls.filter((c) => c.path.endsWith("/messages"))).toHaveLength(1);
    expect((await outbox())[0]!.status).toBe("failed");
  });

  it("a token Meta refuses: the account needs connecting again, admins hear once, nothing more goes", async () => {
    ig.failNext.push(190);
    await send(rep, { text: "one" });
    h.clock.advance(1000);
    await send(rep, { text: "two" });
    await h.runInstagramSend();
    await h.runInstagramSend();
    expect(sentToMeta()).toHaveLength(0);
    const [a] = await h.queryAll<{ status: string }>("SELECT status FROM instagram_accounts");
    expect(a!.status).toBe("needs_attention");
    expect((await outbox()).map((o) => o.status)).toEqual(["failed", "failed"]);
    const reader = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
    await reader.connect();
    const n = await reader
      .query("SELECT 1 FROM notifications WHERE kind = 'system_alert'")
      .finally(() => reader.end());
    expect(n.rowCount).toBe(1);
  });

  it("a message stuck sending for 10 minutes (a crash mid-send) is failed with words, never resent", async () => {
    await send(rep);
    await h.queryAll(
      "UPDATE instagram_outbox SET status = 'sending', updated_at = now() - interval '11 minutes'",
    );
    await h.runInstagramSend();
    const [o] = await outbox();
    await sendInstagramOutbox(
      {
        app: h.app,
        d: h.deps,
        pacer: igPacer({ now: () => h.clock.now, perSecond: 20 }),
        privateRepliesPerHour: 600,
      },
      o!.id,
    );
    expect(sentToMeta()).toHaveLength(0);
    expect((await outbox())[0]).toMatchObject({ status: "failed", problem: IG_MAYBE_SENT });
  });

  it("try again: only a failed message, once, even from two tabs", async () => {
    ig.failNext.push({ code: 10, subcode: 2534022 });
    await send(rep);
    await h.runInstagramSend();
    const [failed] = await outbox();
    const [a, b] = await Promise.all([
      send(rep, { retryOf: failed!.id }),
      send(rep, { retryOf: failed!.id }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    expect((await outbox()).map((o) => o.status)).toEqual(["cancelled", "queued"]);
  });
});

describe("the account's pace", () => {
  it("never more in one second than its pace: the rest wait and go after", async () => {
    for (let i = 0; i < 25; i++) {
      const id = await h.seedLead({ ownerId: rep.id });
      await h.queryAll(
        "INSERT INTO instagram_threads (id, account_id, igsid, lead_id, last_in_at) VALUES (gen_random_uuid(), $1, $2, $3, now())",
        [account.id, `66${String(i).padStart(14, "0")}`, id],
      );
      const [t] = await h.queryAll<{ id: string }>("SELECT id FROM instagram_threads WHERE lead_id = $1", [
        id,
      ]);
      threadId = t!.id;
      await send(rep, {}, id);
    }
    await h.runInstagramSend();
    expect(sentToMeta()).toHaveLength(20);
    expect(h.instagramSendQueued).toHaveLength(5);
    h.clock.advance(1000);
    await h.runInstagramSend();
    expect(sentToMeta()).toHaveLength(25);
  });
});

describe("the one private reply to a comment", () => {
  const comment = async (ago = H) => {
    const id = randomUUID();
    await h.queryAll(
      `INSERT INTO instagram_comments (id, account_id, comment_id, media_id, from_igsid, from_username, text, at)
       VALUES ($1, $2, 'C1', 'M1', '6599999999999999', 'new.person', 'GUIDE', $3)`,
      [id, account.id, new Date(h.clock.now.getTime() - ago)],
    );
    return id;
  };
  const reply = async (u: typeof admin, id: string, clientKey = randomUUID()) =>
    (await h.signIn(u)).inject({
      method: "POST",
      url: `/api/v1/instagram/comments/${id}/private-reply`,
      payload: { clientKey, text: "Here's the guide: tap below." },
    });

  it("goes to the comment, makes its writer a lead, and is never sent twice", async () => {
    const id = await comment();
    const key = randomUUID();
    const r = await reply(admin, id, key);
    expect(r.statusCode).toBe(202);
    expect(r.json().message.privateReply).toBe(true);
    expect((await reply(admin, id, key)).json().message.id).toBe(r.json().message.id);
    expect((await reply(admin, id)).json().error.code).toBe("PRIVATE_REPLY_USED");
    await h.runInstagramSend();
    expect(sentToMeta()[0]!.body).toMatchObject({ recipient: { comment_id: "C1" } });
    const [c] = await h.queryAll<{ private_reply: string; thread_id: string }>(
      "SELECT private_reply, thread_id FROM instagram_comments",
    );
    expect(c!.private_reply).toBe("sent");
    const [l] = await h.queryAll<{ instagram_handle: string; source_id: string }>(
      "SELECT l.instagram_handle, l.source_id FROM leads l JOIN instagram_threads t ON t.lead_id = l.id WHERE t.id = $1",
      [c!.thread_id],
    );
    expect(l).toEqual({ instagram_handle: "new.person", source_id: account.sourceId });
  });

  it("not after 7 days, and a failed one may be tried again in time", async () => {
    const old = await comment(7 * 24 * H + 1000);
    expect((await reply(admin, old)).json().error.code).toBe("PRIVATE_REPLY_USED");
    await h.queryAll("DELETE FROM instagram_comments");
    const id = await comment();
    ig.failNext.push(100);
    await reply(admin, id);
    await h.runInstagramSend();
    const [c] = await h.queryAll<{ private_reply: string }>("SELECT private_reply FROM instagram_comments");
    expect(c!.private_reply).toBe("failed");
    expect((await reply(admin, id)).statusCode).toBe(202);
  });

  it("a rep answering a stranger's comment: the new lead is theirs, whatever the source's rule", async () => {
    const id = await comment();
    const rules = await h.queryAll<{ rules: Record<string, unknown> }>(
      "SELECT rules FROM lead_sources WHERE id = $1",
      [account.sourceId],
    );
    await h.ownerPool.query("UPDATE lead_sources SET rules = $2 WHERE id = $1", [
      account.sourceId,
      JSON.stringify({ ...rules[0]!.rules, owner: { mode: "user", userId: admin.id } }),
    ]);
    const answerer = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "own" },
        { key: "leads.create", scope: "own" },
        { key: "messages.send", scope: "own" },
      ],
    });
    await h.ownerPool.query("UPDATE instagram_accounts SET owner_user_id = $1", [answerer.id]);
    const r = await reply(answerer, id);
    expect(r.statusCode).toBe(202);
    const [l] = await h.queryAll<{ owner_id: string }>(
      "SELECT l.owner_id FROM leads l JOIN instagram_threads t ON t.lead_id = l.id WHERE t.igsid = '6599999999999999'",
    );
    expect(l!.owner_id).toBe(answerer.id);
  });

  it("someone who may not add leads can't make a stranger one by answering", async () => {
    const id = await comment();
    const seer = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "all" },
        { key: "messages.send", scope: "all" },
      ],
    });
    expect((await reply(seer, id)).statusCode).toBe(403);
  });
});

describe("take over and hand back", () => {
  it("take over and hand back, by someone who may message the lead", async () => {
    const take = async (u: typeof rep, how: "take-over" | "hand-back") =>
      (await h.signIn(u)).inject({ method: "POST", url: `/api/v1/instagram/threads/${threadId}/${how}` });
    expect((await take(rep, "take-over")).json()).toEqual({ takenOver: { id: rep.id, name: "Rhea Rep" } });
    expect((await take(rep, "hand-back")).json()).toEqual({ takenOver: null });
    expect((await take(other, "take-over")).statusCode).toBe(404);
  });
});

describe("the lead's Instagram tab: its comments and the flow it's in (plan 2026-11-25-instagram-screens D2)", () => {
  const view = async (u: typeof rep = rep) =>
    (await (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/leads/${leadId}/instagram` })).json()
      .threads[0];
  const comment = async (o: {
    id: string;
    ago: number;
    thread?: string | null;
    state?: string;
    text?: string;
  }) =>
    h.queryAll(
      `INSERT INTO instagram_comments
         (id, account_id, comment_id, media_id, media_type, from_igsid, from_username, text, at, thread_id, private_reply)
       VALUES ($1, $2, $3, 'M1', 'REELS', $4, 'priya.fit', $5, $6, $7, $8)`,
      [
        randomUUID(),
        account.id,
        o.id,
        IGSID,
        o.text ?? "GUIDE please",
        new Date(h.clock.now.getTime() - o.ago),
        o.thread === undefined ? threadId : o.thread,
        o.state ?? "none",
      ],
    );

  it("its comments, newest first, with whether the one private reply can still go", async () => {
    await comment({ id: "C-new", ago: H });
    await comment({ id: "C-old", ago: 7 * 24 * H + 1000 });
    await comment({ id: "C-sent", ago: 2 * H, state: "sent" });
    await comment({ id: "C-failed", ago: 3 * H, state: "failed" });
    const t = await view();
    expect(
      t.comments.map((c: { text: string; privateReply: string; replyOpen: boolean }) => [
        c.privateReply,
        c.replyOpen,
      ]),
    ).toEqual([
      ["none", true],
      ["sent", false],
      ["failed", true],
      ["none", false],
    ]);
    expect(t.comments[0]).toMatchObject({ text: "GUIDE please", mediaType: "REELS" });
    expect(t.comments[0].id).toMatch(/^[0-9a-f-]{36}$/);
    // Instagram's own ids and the commenter's handle aren't part of it: the conversation says who it is.
    expect(JSON.stringify(t.comments)).not.toContain("C-new");
    expect(JSON.stringify(t.comments)).not.toContain("priya.fit");
  });

  it("only this conversation's comments, and at most the newest 20", async () => {
    await comment({ id: "C-loose", ago: H, thread: null, text: "not linked" });
    for (let i = 0; i < 25; i++) await comment({ id: `C${i}`, ago: (i + 2) * 60_000, text: `n${i}` });
    const t = await view();
    expect(t.comments).toHaveLength(20);
    expect(t.comments[0].text).toBe("n0");
    expect(JSON.stringify(t.comments)).not.toContain("not linked");
  });

  it("a conversation with no comments says so with an empty list", async () => {
    expect((await view()).comments).toEqual([]);
  });

  it("the flow a conversation is in while it runs or waits; none once it's done or stopped", async () => {
    const flowId = randomUUID();
    const versionId = randomUUID();
    await h.ownerPool.query(
      "INSERT INTO instagram_flows (id, name, status, created_by) VALUES ($1, 'Lunch box guide', 'draft', $2)",
      [flowId, admin.id],
    );
    await h.ownerPool.query(
      "INSERT INTO instagram_flow_versions (id, flow_id, version, steps, created_by) VALUES ($1, $2, 1, '[]', $3)",
      [versionId, flowId, admin.id],
    );
    const run = randomUUID();
    await h.queryAll(
      `INSERT INTO instagram_flow_runs (id, flow_id, version_id, thread_id, lead_id, status, state, started_by)
       VALUES ($1, $2, $3, $4, $5, 'waiting', '{}', 'comment')`,
      [run, flowId, versionId, threadId, leadId],
    );
    expect((await view()).flow).toEqual({ id: flowId, name: "Lunch box guide", waiting: true });
    await h.queryAll("UPDATE instagram_flow_runs SET status = 'running' WHERE id = $1", [run]);
    expect((await view()).flow).toEqual({ id: flowId, name: "Lunch box guide", waiting: false });
    for (const s of ["done", "stopped", "handed", "failed"]) {
      await h.queryAll("UPDATE instagram_flow_runs SET status = $2 WHERE id = $1", [run, s]);
      expect((await view()).flow, s).toBeNull();
    }
    await h.queryAll(
      `INSERT INTO instagram_outbox (id, thread_id, lead_id, account_id, user_id, client_key, kind, text, flow_run_id, step_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'dm', 'Here you go: the guide', $7, 's1', 'sent')`,
      [randomUUID(), threadId, leadId, account.id, admin.id, randomUUID(), run],
    );
    const sentByFlow = (await view()).messages.find(
      (m: { text: string }) => m.text === "Here you go: the guide",
    );
    expect(sentByFlow.flow).toBe("Lunch box guide");
    await send(rep);
    const mine = (await view()).messages.find(
      (m: { text: string }) => m.text === "Yes, the batch starts Monday",
    );
    expect(mine).toMatchObject({ flow: null, sentBy: { id: rep.id, name: "Rhea Rep" } });
    await h.ownerPool.query("DELETE FROM instagram_flows WHERE id = $1", [flowId]);
  });
});
