import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { echo, inbound, statuses } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { sweepWhatsAppFiles } from "./keep";
import { staleOutbox } from "./queue";

/** Sending a reply from LUME (plan W3a Task 4): the queue, Meta's answers and statuses, and what a send means. */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
const SNEHA = "+919876543210";
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n");
const quiet = { warn: () => undefined, error: () => undefined };

const as = (u: U) => h.signIn(u);
async function writes(from = SNEHA) {
  await deliver(
    h,
    structuredClone(
      inbound({ from: from.slice(1), id: `wamid.${randomUUID()}`, at: h.clock.now.toISOString() }),
    ),
  );
  await h.runWhatsApp();
}
async function reply(lead: string, body: Record<string, unknown>, u: U = rep) {
  const r = await (
    await as(u)
  ).inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/whatsapp/messages`,
    payload: { clientKey: randomUUID(), ...body },
  });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(202);
  return r.json().message as { id: string; outboxId: string };
}
async function attach(lead: string, bytes = PDF, name = "Prices.pdf") {
  const r = await (
    await as(rep)
  ).inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/whatsapp/files`,
    headers: { "content-type": "application/octet-stream", "x-file-name": name },
    payload: bytes,
  });
  expect(r.statusCode).toBe(201);
  return r.json().media.id as string;
}
const outbox = (id: string) =>
  h
    .queryAll<{ status: string; wamid: string | null; problem: string | null; tries: number }>(
      "SELECT status, wamid, problem, tries FROM whatsapp_outbox WHERE id = $1",
      [id],
    )
    .then((r) => r[0]!);
const status = (o: { id: string; status: string; code?: number }) => deliver(h, statuses(o));

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
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
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  h.whatsappQueued.length = 0;
  h.whatsappSendQueued.length = 0;
  meta.sent.length = 0;
  meta.uploads.length = 0;
  meta.failNext.length = 0;
  meta.revoked.clear();
  await seedNumber(h, { runAs: admin.id, owner: rep.id });
  await h.ownerPool.query(
    `UPDATE settings SET integrations = jsonb_set(integrations, '{whatsapp}', '{"enabled": true, "replyFromLume": true}'::jsonb) WHERE id = 1`,
  );
});

describe("sending", () => {
  it("a reply goes from the number, as its sender; then it counts as a send: last message, first contact, the follow-up done", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const made = await (
      await as(rep)
    ).inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/tasks`,
      payload: { title: "Reply to Sneha" },
    });
    expect(made.statusCode, made.body).toBe(201);
    const [task] = await h.queryAll<{ id: string }>("SELECT id FROM tasks WHERE lead_id = $1", [lead]);
    const m = await reply(lead, { text: "See you Saturday", taskId: task!.id });
    await h.runWhatsAppSend();
    expect(meta.sent).toEqual([
      {
        numberId: "106540352242922",
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: "919876543210",
          type: "text",
          text: { body: "See you Saturday", preview_url: true },
        },
      },
    ]);
    expect(await outbox(m.outboxId)).toMatchObject({ status: "sent", wamid: "wamid.OUT1", problem: null });
    // Review Focus 3: it counts as the person who sent it, not as the number's runner.
    const counted = await h.queryAll<{ type: string; user_id: string; via: string | null }>(
      "SELECT type, user_id, payload->>'via' AS via FROM activities WHERE lead_id = $1 AND type = 'whatsapp_confirmed_sent'",
      [lead],
    );
    expect(counted).toEqual([{ type: "whatsapp_confirmed_sent", user_id: rep.id, via: "lume" }]);
    const [l] = await h.queryAll<{ last_message_at: Date | null }>(
      "SELECT last_message_at FROM leads WHERE id = $1",
      [lead],
    );
    expect(l!.last_message_at).not.toBeNull();
    expect(
      await h.queryAll("SELECT 1 FROM lead_firsts WHERE lead_id = $1 AND first_contact_at IS NOT NULL", [
        lead,
      ]),
    ).toHaveLength(1);
    const [t] = await h.queryAll<{ status: string }>("SELECT status FROM tasks WHERE lead_id = $1", [lead]);
    expect(t).toEqual({ status: "done" });
    // An echo of it from Meta is the same message, not a second one on the thread (outcome 23).
    await deliver(h, echo({ id: "wamid.OUT1", at: h.clock.now.toISOString(), text: "See you Saturday" }));
    await h.runWhatsApp();
    expect(
      await h.queryAll("SELECT 1 FROM activities WHERE lead_id = $1 AND type = 'whatsapp_sent'", [lead]),
    ).toHaveLength(1);
  });

  it("a file goes once to Meta for each number: a second lead gets the same brochure without another upload", async () => {
    const a = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const b = await h.seedLead({ ownerId: rep.id, name: "Karan Mehta", phone: "+919876500011" });
    await writes();
    await writes("+919876500011");
    await reply(a, { mediaId: await attach(a), text: "Our prices" });
    await reply(b, { mediaId: await attach(b) });
    await h.runWhatsAppSend();
    expect(meta.uploads).toHaveLength(1);
    expect(meta.sent.map((s) => s.body.document)).toEqual([
      { id: "UP1", caption: "Our prices", filename: "Prices.pdf" },
      { id: "UP1", filename: "Prices.pdf" },
    ]);
  });

  it("a Meta id that expired is dropped and the file uploaded again, once", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    await reply(lead, { mediaId: await attach(lead) });
    await h.runWhatsAppSend();
    meta.expired.add("UP1");
    const m = await reply(lead, { mediaId: await attach(lead) });
    await h.runWhatsAppSend();
    expect(meta.uploads.map((u) => u.id)).toEqual(["UP1", "UP2"]);
    expect(await outbox(m.outboxId)).toMatchObject({ status: "sent" });
  });
});

describe("when Meta says no", () => {
  it("each refusal in words; a revoked token also puts the number in needs attention", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    for (const [code, words] of [
      [131047, "WhatsApp's 24 hours since the lead's last message had passed. Send it from the phone."],
      [131026, "This number can't get WhatsApp messages."],
      [190, "WhatsApp stopped letting LUME in. Connect this number again."],
    ] as const) {
      meta.failNext.push(code);
      const m = await reply(lead, { text: `try ${code}` });
      await h.runWhatsAppSend();
      expect([code, await outbox(m.outboxId)]).toMatchObject([code, { status: "failed", problem: words }]);
    }
    const [n] = await h.queryAll<{ status: string }>("SELECT status FROM whatsapp_numbers");
    expect(n).toEqual({ status: "needs_attention" });
    expect(meta.sent).toEqual([]);
  });

  it("busy or rate limited: tried again (the queue's backoff); after 5 tries, failed with words", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    meta.failNext.push(130429);
    const m = await reply(lead, { text: "busy" });
    await h.runWhatsAppSend();
    expect(await outbox(m.outboxId)).toMatchObject({ status: "queued", tries: 1, problem: null });
    expect(h.whatsappSendQueued).toEqual([m.outboxId]); // the queue tries it again
    await h.runWhatsAppSend();
    expect(await outbox(m.outboxId)).toMatchObject({ status: "sent", tries: 2 });

    meta.failNext.push(130429, 130429, 130429, 130429, 130429);
    const again = await reply(lead, { text: "busy again" });
    for (let i = 0; i < 5; i++) await h.runWhatsAppSend();
    expect(await outbox(again.outboxId)).toMatchObject({
      status: "failed",
      tries: 5,
      problem: "WhatsApp didn't take this message. Try again.",
    });
  });

  it("never twice: a send that may have gone before a crash is failed with words, not sent again", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const m = await reply(lead, { text: "did it go?" });
    await h.queryAll(
      "UPDATE whatsapp_outbox SET status = 'sending', updated_at = now() - interval '3 minutes' WHERE id = $1",
      [m.outboxId],
    );
    await h.runWhatsAppSend();
    expect(meta.sent).toEqual([]);
    expect(await outbox(m.outboxId)).toMatchObject({
      status: "failed",
      problem: "LUME couldn't tell whether this went. Check the phone before sending it again.",
    });
  });

  it("the sender lost the right to message, or the lead went to the bin, before the queue got to it: nothing is sent", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const m = await reply(lead, { text: "one" });
    await h.revokeGrant(rep.id, "messages.send");
    await h.runWhatsAppSend();
    expect(await outbox(m.outboxId)).toMatchObject({
      status: "failed",
      problem: expect.stringMatching(/ can't message this lead any more\.$/),
    });
    await h.grant(rep.id, [{ key: "messages.send", scope: "own" }]);
    const n = await reply(lead, { text: "two" });
    await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [lead]);
    await h.runWhatsAppSend();
    expect(await outbox(n.outboxId)).toMatchObject({
      status: "failed",
      problem: "This lead isn't here any more.",
    });
    expect(meta.sent).toEqual([]);
  });
});

describe("statuses", () => {
  it("only forward: delivered, a late 'sent' changes nothing, then read; a failure after delivery is ignored", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const m = await reply(lead, { text: "hello" });
    await h.runWhatsAppSend();
    await status({ id: "wamid.OUT1", status: "delivered" });
    expect((await outbox(m.outboxId)).status).toBe("delivered");
    await status({ id: "wamid.OUT1", status: "sent" });
    expect((await outbox(m.outboxId)).status).toBe("delivered");
    await status({ id: "wamid.OUT1", status: "failed", code: 131026 });
    expect((await outbox(m.outboxId)).status).toBe("delivered");
    await status({ id: "wamid.OUT1", status: "read" });
    await status({ id: "wamid.OUT1", status: "read" });
    expect((await outbox(m.outboxId)).status).toBe("read");
  });

  it("a failure before delivery says why; a status for a message LUME didn't send is nothing", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const m = await reply(lead, { text: "hello" });
    await h.runWhatsAppSend();
    await status({ id: "wamid.OUT1", status: "failed", code: 131026 });
    expect(await outbox(m.outboxId)).toMatchObject({
      status: "failed",
      problem: "This number can't get WhatsApp messages.",
    });
    expect((await status({ id: "wamid.FROMPHONE", status: "read" })).statusCode).toBe(200);
  });
});

describe("housekeeping", () => {
  it("a file attached and never sent goes after a day; one sent stays", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const unsent = await attach(lead, Buffer.from("%PDF-1.7 never sent"), "Draft.pdf");
    const sent = await attach(lead);
    await reply(lead, { mediaId: sent });
    await h.queryAll(
      "UPDATE whatsapp_media SET created_at = now() - interval '25 hours' WHERE id IN ($1, $2)",
      [unsent, sent],
    );
    await sweepWhatsAppFiles({ pool: h.pool, store: h.files.store, log: quiet });
    const left = await h.queryAll<{ id: string }>("SELECT id FROM whatsapp_media WHERE id IN ($1, $2)", [
      unsent,
      sent,
    ]);
    expect(left.map((r) => r.id)).toEqual([sent]);
  });

  it("messages a lost job left behind are found again by the minute sweep", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    const m = await reply(lead, { text: "lost" });
    expect(await staleOutbox(h.pool)).toEqual([]);
    await h.queryAll("UPDATE whatsapp_outbox SET updated_at = now() - interval '3 minutes' WHERE id = $1", [
      m.outboxId,
    ]);
    expect(await staleOutbox(h.pool)).toEqual([m.outboxId]);
  });
});
