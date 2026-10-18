import { ALL_GRANTS } from "@lume/core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { echo, history, inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";

/** Replies and phone-sent messages landing on the lead by themselves (spec 2026-10-18 §4.1–4.2; plan W1 Task 6). */
let h: Harness;
let admin: { id: string; email: string; password: string };
let rep: { id: string; email: string; password: string };
let numberId: string;
const SNEHA = "+919876543210";

const activities = async (lead: string) =>
  await h.queryAll<{
    type: string;
    text: string | null;
    user_id: string | null;
    at: string;
    via: string | null;
  }>(
    `SELECT type, payload->>'text' AS text, user_id, occurred_at AS at, payload->>'via' AS via
         FROM activities WHERE lead_id = $1 AND type LIKE 'whatsapp%' ORDER BY occurred_at, id`,
    [lead],
  );
const run = async (body: unknown) => {
  expect((await deliver(h, body)).statusCode).toBe(200);
  await h.runWhatsApp();
};
// Notifications are each person's own: read with the backup role, as other tests do.
const replied = async (userId: string, leadId: string) => {
  const c = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
  await c.connect();
  try {
    return (
      await c.query<{ title: string; body: string }>(
        "SELECT title, body FROM notifications WHERE kind = 'lead_replied' AND user_id = $1 AND lead_id = $2 ORDER BY id",
        [userId, leadId],
      )
    ).rows;
  } finally {
    await c.end();
  }
};

beforeAll(async () => {
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: "http://127.0.0.1:9", version: "v23.0" },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "leads.edit", scope: "own" },
      { key: "messages.send", scope: "own" },
    ],
    totp: false,
  });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.ownerPool.query("TRUNCATE whatsapp_events");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  h.whatsappQueued.length = 0;
  h.whatsappMediaQueued.length = 0;
  numberId = await seedNumber(h, { runAs: admin.id, owner: rep.id });
});

describe("a reply on a lead", () => {
  it("one activity at the message's time, the reply effects, and its owner told once", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await run(inbound({ at: "2026-10-21T06:00:00Z" }));
    expect(await activities(lead)).toEqual([
      {
        type: "whatsapp_received",
        text: "Yes, Saturday works",
        user_id: rep.id,
        at: expect.anything(),
        via: null,
      },
    ]);
    const [l] = await h.queryAll<{ last_reply_at: Date }>("SELECT last_reply_at FROM leads WHERE id = $1", [
      lead,
    ]);
    expect(new Date(l!.last_reply_at).toISOString()).toBe("2026-10-21T06:00:00.000Z");
    expect(await replied(rep.id, lead)).toEqual([
      { title: "Sneha replied on WhatsApp", body: "Yes, Saturday works" },
    ]);
  });

  it("the stage's reply move runs, as tapping They replied does", async () => {
    const stages = (await h.config()).stages;
    const from = stages["New"]!;
    const to = stages[Object.keys(stages).find((n) => n !== "New" && !/won|lost/i.test(n))!]!;
    await h.ownerPool.query("UPDATE stages SET after_reply_stage_id = $1 WHERE id = $2", [to, from]);
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await run(inbound());
    expect(
      (await h.queryAll<{ stage_id: string }>("SELECT stage_id FROM leads WHERE id = $1", [lead]))[0]!
        .stage_id,
    ).toBe(to);
    await h.ownerPool.query("UPDATE stages SET after_reply_stage_id = NULL WHERE id = $1", [from]);
  });

  it("Review Focus 1: the same message processed twice is one activity and one notice", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await run(inbound());
    h.clock.advance(60_000);
    await run(inbound());
    expect(await activities(lead)).toHaveLength(1);
    expect(await replied(rep.id, lead)).toHaveLength(1);
  });

  it("several messages in a row: each kept, one notice for the burst", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await run(inbound({ id: "wamid.A" }));
    h.clock.advance(60_000);
    await run(inbound({ id: "wamid.B" }));
    expect(await activities(lead)).toHaveLength(2);
    expect(await replied(rep.id, lead)).toHaveLength(1);
  });

  it("Review Focus 2: two leads with the number — the number owner's own lead gets it, never both", async () => {
    const theirs = await h.seedLead({ ownerId: admin.id, name: "Sneha (old)", phone: SNEHA });
    const mine = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await h.queryAll("UPDATE leads SET last_activity_at = now() + interval '1 day' WHERE id = $1", [theirs]);
    await run(inbound());
    expect(await activities(mine)).toHaveLength(1);
    expect(await activities(theirs)).toHaveLength(0);
  });

  it("none of the owner's: the most recently active lead with the number", async () => {
    const older = await h.seedLead({ ownerId: admin.id, name: "Sneha A", phone: SNEHA });
    const newer = await h.seedLead({ ownerId: admin.id, name: "Sneha B", phone: SNEHA });
    await h.queryAll("UPDATE leads SET last_activity_at = now() - interval '9 days' WHERE id = $1", [older]);
    await run(inbound());
    expect(await activities(newer)).toHaveLength(1);
    expect(await activities(older)).toHaveLength(0);
  });
});

describe("from the business's phone", () => {
  it("a message sent from the phone lands as sent, and answers a pending Sent? for the person who opened WhatsApp", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const c = await h.signIn(rep);
    expect(
      (
        await c.inject({
          method: "POST",
          url: `/api/v1/leads/${lead}/messages/prepare`,
          payload: { text: "Hi Sneha" },
        })
      ).statusCode,
    ).toBe(200);
    await run(echo({ at: new Date().toISOString() }));
    expect((await activities(lead)).map((x) => x.type)).toEqual(
      expect.arrayContaining(["whatsapp_opened", "whatsapp_sent", "whatsapp_confirmed_sent"]),
    );
    const confirmed = await h.queryAll(
      "SELECT user_id, payload->>'via' AS via FROM activities WHERE lead_id = $1 AND type = 'whatsapp_confirmed_sent'",
      [lead],
    );
    expect(confirmed).toEqual([{ user_id: rep.id, via: "echo" }]);
  });

  it("a Sent? opened over 24 hours ago is left alone", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const c = await h.signIn(rep);
    await c.inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/messages/prepare`,
      payload: { text: "Hi" },
    });
    // Sent from the phone 25 hours after WhatsApp was opened: a different conversation.
    await run(echo({ at: new Date(Date.now() + 25 * 3_600_000).toISOString() }));
    expect(
      await h.queryAll("SELECT 1 FROM activities WHERE lead_id = $1 AND type = 'whatsapp_confirmed_sent'", [
        lead,
      ]),
    ).toHaveLength(0);
  });

  it("sent to a number no lead has: dropped", async () => {
    await run(echo({ to: "919000000999", id: "wamid.NOLEAD" }));
    expect(
      await h.queryAll("SELECT 1 FROM activities WHERE payload->>'wamid' = 'wamid.NOLEAD'"),
    ).toHaveLength(0);
  });
});

describe("strangers and past chats", () => {
  it("a stranger waits in Not a lead yet; no lead is made", async () => {
    const leads = Number(
      (await h.queryAll<{ count: string }>("SELECT count(*) FROM leads WHERE deleted_at IS NULL"))[0]!.count,
    );
    await run(inbound({ from: "919000000777", name: "Ravi Supplier", id: "wamid.S1" }));
    expect(await h.queryAll("SELECT peer, name, text FROM whatsapp_inbox")).toEqual([
      { peer: "+919000000777", name: "Ravi Supplier", text: "Yes, Saturday works" },
    ]);
    expect(
      Number(
        (await h.queryAll<{ count: string }>("SELECT count(*) FROM leads WHERE deleted_at IS NULL"))[0]!
          .count,
      ),
    ).toBe(leads);
  });

  it("someone marked Not a lead never shows up again", async () => {
    await h.queryAll("INSERT INTO whatsapp_ignored (number_id, peer) VALUES ($1, '+919000000777')", [
      numberId,
    ]);
    await run(inbound({ from: "919000000777", id: "wamid.S2" }));
    expect(await h.queryAll("SELECT 1 FROM whatsapp_inbox WHERE wamid = 'wamid.S2'")).toHaveLength(0);
  });

  it("Review Focus 5: history after live messages — no duplicates, the thread in time order; strangers' history dropped", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await run(inbound({ id: "wamid.L1", at: "2026-10-21T06:00:00Z" }));
    await run(
      history([
        {
          id: "919876543210",
          messages: [
            { from: "919876543210", id: "wamid.H1", at: "2026-10-01T10:00:00Z", text: "Hi, saw your ad" },
            {
              from: "919000000001",
              id: "wamid.H2",
              at: "2026-10-01T10:05:00Z",
              text: "Hello! What do you need?",
            },
            { from: "919876543210", id: "wamid.L1", at: "2026-10-21T06:00:00Z", text: "Yes, Saturday works" },
          ],
        },
        {
          id: "919000000555",
          messages: [{ from: "919000000555", id: "wamid.X1", at: "2026-10-02T10:00:00Z", text: "unrelated" }],
        },
      ]),
    );
    expect((await activities(lead)).map((a) => [a.type, a.text])).toEqual([
      ["whatsapp_received", "Hi, saw your ad"],
      ["whatsapp_sent", "Hello! What do you need?"],
      ["whatsapp_received", "Yes, Saturday works"],
    ]);
    expect(await h.queryAll("SELECT 1 FROM whatsapp_inbox WHERE wamid = 'wamid.X1'")).toHaveLength(0);
    // Past chats tell nobody anything new.
    expect(await replied(rep.id, lead)).toHaveLength(1);
  });

  it("a photo: on the lead, waiting to be fetched", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await run(
      inbound({
        id: "wamid.P1",
        type: "image",
        image: { id: "M1", mime_type: "image/jpeg", caption: "Our hall" },
      }),
    );
    const m = await h.queryAll("SELECT id, lead_id, status, meta_id FROM whatsapp_media");
    expect(m).toEqual([{ id: expect.any(String), lead_id: lead, status: "waiting", meta_id: "M1" }]);
    expect(h.whatsappMediaQueued).toEqual([m[0]!.id]);
    const media = await h.queryAll(
      "SELECT payload->'media'->>'id' AS id FROM activities WHERE lead_id = $1 AND type = 'whatsapp_received'",
      [lead],
    );
    expect(media).toEqual([{ id: m[0]!.id }]);
  });
});

describe("when the person it runs as can't any more", () => {
  it("the number needs attention, and the event waits until it's fixed", async () => {
    await h.ownerPool.query("UPDATE whatsapp_numbers SET run_as = $1", [rep.id]);
    await h.queryAll("UPDATE users SET status = 'disabled' WHERE id = $1", [rep.id]);
    await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await run(inbound({ id: "wamid.W1" }));
    await h.queryAll("UPDATE users SET status = 'active' WHERE id = $1", [rep.id]);
    expect((await h.ownerPool.query("SELECT status, problem FROM whatsapp_numbers")).rows[0]).toEqual({
      status: "needs_attention",
      problem: "Whoever connected this number can't see leads any more. Connect it again.",
    });
    expect(
      (await h.ownerPool.query("SELECT status FROM whatsapp_events WHERE wamid = 'wamid.W1'")).rows[0].status,
    ).toBe("queued");
  });
});
