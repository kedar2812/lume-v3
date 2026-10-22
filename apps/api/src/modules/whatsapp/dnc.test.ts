import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";

/**
 * Do not contact (Autopilot A2, Task 3; spec 2026-10-19 §1.3 "Stop means stop"): a lead who asked not to be messaged
 * is held by every way LUME sends, whoever sends, until an admin lifts it.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
const SNEHA = "+919876543210";
const WORDS = "Sneha asked not to be messaged. An admin can lift this on the lead.";

const as = (u: U) => h.signIn(u);
const dnc = async (u: U, lead: string, reason = "Asked on a call") =>
  (await as(u)).inject({ method: "POST", url: `/api/v1/leads/${lead}/do-not-contact`, payload: { reason } });
const lift = async (u: U, lead: string) =>
  (await as(u)).inject({ method: "DELETE", url: `/api/v1/leads/${lead}/do-not-contact` });
const reply = async (u: U, lead: string) =>
  (await as(u)).inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/whatsapp/messages`,
    payload: { clientKey: randomUUID(), text: "Hi Sneha" },
  });
async function writes() {
  const body = inbound({ from: SNEHA.slice(1), id: `wamid.${randomUUID()}`, at: h.clock.now.toISOString() });
  expect((await deliver(h, body)).statusCode).toBe(200);
  await h.runWhatsApp();
}
const outbox = (lead: string) =>
  h.queryAll<{ status: string; problem: string | null }>(
    "SELECT status, problem FROM whatsapp_outbox WHERE lead_id = $1 ORDER BY created_at",
    [lead],
  );

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
  await seedNumber(h, { runAs: admin.id, owner: rep.id });
  await (
    await as(admin)
  ).inject({
    method: "PUT",
    url: "/api/v1/integrations/whatsapp",
    payload: { replyFromLume: true },
  });
});

describe("do not contact", () => {
  it("a rep sets it; only an admin lifts it; both are on the lead's timeline, saying who and why", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    expect((await dnc(rep, lead)).statusCode).toBe(200);
    const view = (await (await as(rep)).inject({ method: "GET", url: `/api/v1/leads/${lead}` })).json().lead;
    expect(view.doNotContact).toMatchObject({ by: rep.id, reason: "Asked on a call" });
    expect((await lift(rep, lead)).statusCode).toBe(403);
    expect((await lift(admin, lead)).statusCode).toBe(200);
    expect(
      (await (await as(admin)).inject({ method: "GET", url: `/api/v1/leads/${lead}` })).json().lead
        .doNotContact,
    ).toBeNull();
    const acts = await h.queryAll<{ type: string; user_id: string; payload: Record<string, unknown> }>(
      "SELECT type, user_id, payload FROM activities WHERE lead_id = $1 AND type IN ('dnc_set', 'dnc_lifted') ORDER BY occurred_at",
      [lead],
    );
    expect(acts).toEqual([
      { type: "dnc_set", user_id: rep.id, payload: { reason: "Asked on a call" } },
      { type: "dnc_lifted", user_id: admin.id, payload: {} },
    ]);
  });

  it("a reply and click-to-send stop at do not contact, in words", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    await dnc(rep, lead);
    const r = await reply(rep, lead);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: "DO_NOT_CONTACT", message: WORDS });
    const open = await (
      await as(rep)
    ).inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/messages/prepare`,
      payload: { text: "Hi" },
    });
    expect(open.statusCode).toBe(409);
    expect(open.json().error.code).toBe("DO_NOT_CONTACT");
  });

  it("a message already queued when it's set never reaches WhatsApp", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    expect((await reply(rep, lead)).statusCode).toBe(202);
    await dnc(rep, lead);
    await h.runWhatsAppSend();
    expect(meta.sent).toHaveLength(0);
    expect(await outbox(lead)).toEqual([{ status: "failed", problem: WORDS }]);
  });

  it("only a message marked for after it (LUME AI's one apology for a stop) still goes", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await writes();
    expect((await reply(rep, lead)).statusCode).toBe(202);
    await dnc(rep, lead);
    await h.queryAll("UPDATE whatsapp_outbox SET allow_after_dnc = true WHERE lead_id = $1", [lead]);
    await h.runWhatsAppSend();
    expect(await outbox(lead)).toEqual([{ status: "sent", problem: null }]);
    expect(meta.sent).toHaveLength(1);
  });
});
