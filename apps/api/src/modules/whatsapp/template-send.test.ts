import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";

/**
 * Sending an approved template from LUME (plan W3b-2 Task 6; spec 2026-10-18 §4.3): to a lead who never wrote, or went
 * quiet over 24 hours ago, with its cost shown first and the month's limit kept.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
let number: string;
const SNEHA = "+919876543210";

const as = (u: U) => h.signIn(u);
const metaNameOf = async (submissionId: string) =>
  (
    await h.ownerPool.query<{ meta_name: string }>(
      "SELECT meta_name FROM whatsapp_template_submissions WHERE id = $1",
      [submissionId],
    )
  ).rows[0]!.meta_name;
/** A LUME template submitted to WhatsApp and approved by its webhook: its submission's id. */
async function approved(body: string, category = "first_touch") {
  const t = (
    await (
      await as(admin)
    ).inject({
      method: "POST",
      url: "/api/v1/templates",
      payload: { name: `T ${randomUUID().slice(0, 8)}`, category, body },
    })
  ).json() as { id: string };
  const s = await (
    await as(admin)
  ).inject({ method: "POST", url: `/api/v1/templates/${t.id}/whatsapp`, payload: { language: "en" } });
  expect(s.statusCode, s.body).toBe(202);
  const id = s.json().submissions[0].id as string;
  expect(
    (await deliver(h, meta.templateUpdate(await metaNameOf(id), { status: "APPROVED" }))).statusCode,
  ).toBe(200);
  return id;
}
const state = async (u: U, lead: string) =>
  (await (await as(u)).inject({ method: "GET", url: `/api/v1/leads/${lead}/whatsapp/templates` })).json();
const sendTemplate = async (u: U, lead: string, submissionId: string, clientKey: string = randomUUID()) =>
  (await as(u)).inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/whatsapp/template`,
    payload: { submissionId, clientKey },
  });
const outbox = (lead: string) =>
  h.queryAll<{
    status: string;
    paid: boolean;
    cost: string | null;
    cost_currency: string | null;
    problem: string | null;
    text: string;
  }>(
    "SELECT status, paid, cost, cost_currency, problem, text FROM whatsapp_outbox WHERE lead_id = $1 ORDER BY created_at",
    [lead],
  );
const toMeta = () => meta.sent.filter((m) => m.body.type === "template").map((m) => m.body);

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version, appId: meta.appId },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "messages.send", scope: "own" },
      { key: "templates.use", scope: null },
    ],
    totp: false,
  });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.queryAll("DELETE FROM whatsapp_outbox"); // row-level secured: deleted with every lead in scope
  await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  await h.ownerPool.query("UPDATE settings SET messaging = '{}'::jsonb WHERE id = 1");
  meta.templates.clear();
  meta.sent.length = 0;
  meta.failNext.length = 0;
  h.whatsappSendQueued.length = 0;
  number = await seedNumber(h, { runAs: admin.id, owner: rep.id });
  expect(
    (
      await (
        await as(admin)
      ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: true } })
    ).statusCode,
  ).toBe(200);
});

describe("an approved template to any lead", () => {
  it("to a lead who never wrote: from the owner's number, its cost shown first, the lead's values in order, and it counts as a send", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const s = await approved("Hi {{lead.first_name}}, this is the studio. Shall we talk this week?");
    const st = await state(rep, lead);
    expect(st.number).toEqual({ id: number, display: "+91 90000 00001" });
    expect(st.reason).toBeNull();
    expect(st.options).toEqual([
      {
        submissionId: s,
        name: expect.any(String),
        category: "MARKETING",
        preview: "Hi Sneha, this is the studio. Shall we talk this week?",
        missing: [],
        cost: { amount: 0.86, currency: "INR", asOf: "2026-10-18" },
      },
    ]);
    const r = await sendTemplate(rep, lead, s);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().message).toMatchObject({
      direction: "out",
      text: "Hi Sneha, this is the studio. Shall we talk this week?",
      status: "queued",
    });
    await h.runWhatsAppSend();
    const [sent] = toMeta();
    expect(sent).toMatchObject({
      to: "919876543210",
      type: "template",
      template: {
        name: await metaNameOf(s),
        language: { code: "en" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Sneha" }] }],
      },
    });
    expect(await outbox(lead)).toEqual([
      expect.objectContaining({ status: "sent", paid: true, cost: "0.8600", cost_currency: "INR" }),
    ]);
    const [l] = await h.queryAll<{ last_message_at: Date | null }>(
      "SELECT last_message_at FROM leads WHERE id = $1",
      [lead],
    );
    expect(l!.last_message_at).not.toBeNull();
  });

  it("a value the lead doesn't have: never sent with a blank; the sheet and the refusal name it", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const s = await approved(
      "Hi {{lead.first_name}}, your visit on {{meeting.date}} is confirmed. See you!",
      "reminder",
    );
    expect((await state(rep, lead)).options[0].missing).toEqual(["Meeting date"]);
    const r = await sendTemplate(rep, lead, s);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toEqual({
      code: "MISSING_VALUES",
      message: "Sneha has no Meeting date yet, so this template can't go. Choose another, or add it first.",
    });
    expect(await outbox(lead)).toEqual([]);
  });

  it("Review Focus 1: edited after approval, the approved words keep going; the edit never goes unapproved", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const s = await approved("Hello there, this is the studio. Shall we talk this week?");
    const [{ template_id }] = (
      await h.ownerPool.query<{ template_id: string }>(
        `SELECT v.template_id FROM whatsapp_template_submissions s
         JOIN template_versions v ON v.id = s.template_version_id WHERE s.id = $1`,
        [s],
      )
    ).rows as [{ template_id: string }];
    const edit = await (
      await as(admin)
    ).inject({
      method: "PATCH",
      url: `/api/v1/templates/${template_id}`,
      payload: { body: "Hello there, a NEW unapproved line. Shall we talk?" },
    });
    expect(edit.statusCode).toBe(200);
    const st = await state(rep, lead);
    expect(
      st.options.map((o: { submissionId: string; preview: string }) => [o.submissionId, o.preview]),
    ).toEqual([[s, "Hello there, this is the studio. Shall we talk this week?"]]);
    expect((await sendTemplate(rep, lead, s)).statusCode).toBe(202);
    expect((await outbox(lead))[0]!.text).toBe("Hello there, this is the studio. Shall we talk this week?");
  });

  it("the same key twice is one message", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const s = await approved("Hello there, this is the studio. Shall we talk this week?");
    const key = randomUUID();
    expect((await sendTemplate(rep, lead, s, key)).statusCode).toBe(202);
    expect((await sendTemplate(rep, lead, s, key)).statusCode).toBe(202);
    expect(await outbox(lead)).toHaveLength(1);
  });

  it("inside the 24 hours it's still a paid message: WhatsApp charges every template (2026-10-01)", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    await deliver(
      h,
      inbound({ from: SNEHA.slice(1), id: `wamid.${randomUUID()}`, at: h.clock.now.toISOString() }),
    );
    await h.runWhatsApp();
    const s = await approved("Hello there, this is the studio. Shall we talk this week?");
    expect((await sendTemplate(rep, lead, s)).statusCode).toBe(202);
    expect((await outbox(lead))[0]!.paid).toBe(true);
  });

  it("someone who turned off marketing messages: marked, and offered only reminders after", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const marketing = await approved("Hello there, this is the studio. Shall we talk this week?");
    const reminder = await approved(
      "Hello there, a reminder of your visit to the studio. See you soon!",
      "reminder",
    );
    meta.failNext.push(131050);
    expect((await sendTemplate(rep, lead, marketing)).statusCode).toBe(202);
    await h.runWhatsAppSend();
    expect((await outbox(lead))[0]).toMatchObject({
      status: "failed",
      problem: "This person turned off marketing messages from you on WhatsApp.",
    });
    const [l] = await h.queryAll<{ off: Date | null }>(
      "SELECT whatsapp_marketing_off_at AS off FROM leads WHERE id = $1",
      [lead],
    );
    expect(l!.off).not.toBeNull();
    expect((await state(rep, lead)).options.map((o: { submissionId: string }) => o.submissionId)).toEqual([
      reminder,
    ]);
    expect((await sendTemplate(rep, lead, marketing)).json().error.code).toBe("MARKETING_OFF");
  });

  it("a template WhatsApp no longer has as approved: the send fails in words, and the template says submit again", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const s = await approved("Hello there, this is the studio. Shall we talk this week?");
    meta.templateUpdate(await metaNameOf(s), { status: "PAUSED" }); // its webhook not here yet
    expect((await sendTemplate(rep, lead, s)).statusCode).toBe(202);
    await h.runWhatsAppSend();
    expect((await outbox(lead))[0]).toMatchObject({
      status: "failed",
      problem: "WhatsApp no longer has this template as approved. Submit it again.",
    });
    const [row] = await h.queryAll<{ status: string }>(
      "SELECT status FROM whatsapp_template_submissions WHERE id = $1",
      [s],
    );
    expect(row!.status).toBe("failed");
  });

  it("a template approved on another WhatsApp account isn't offered for this number, nor sent", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const s = await approved("Hello there, this is the studio. Shall we talk this week?");
    await h.ownerPool.query("UPDATE whatsapp_template_submissions SET waba_id = 'ANOTHER' WHERE id = $1", [
      s,
    ]);
    expect((await state(rep, lead)).options).toEqual([]);
    const r = await sendTemplate(rep, lead, s);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("TEMPLATE_NOT_HERE");
  });

  it("the month's limit: at it, nothing goes, said with the numbers", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Sneha Reddy", phone: SNEHA });
    const s = await approved("Hello there, this is the studio. Shall we talk this week?");
    await (
      await as(admin)
    ).inject({ method: "PUT", url: "/api/v1/settings/messaging", payload: { paidSendsMonthly: 1 } });
    expect((await sendTemplate(rep, lead, s)).statusCode).toBe(202);
    const r = await sendTemplate(rep, lead, s);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toEqual({
      code: "PAID_LIMIT",
      message: "This month's paid WhatsApp messages are used up (1 of 1). An admin can ask for more.",
    });
    expect(await outbox(lead)).toHaveLength(1);
  });

  it("someone who can't message the lead gets nothing to choose and can't send", async () => {
    const lead = await h.seedLead({ ownerId: admin.id, name: "Karan Mehta", phone: "+919876500011" });
    const s = await approved("Hello there, this is the studio. Shall we talk this week?");
    expect((await sendTemplate(rep, lead, s)).statusCode).toBe(404);
  });
});
