import { randomUUID } from "node:crypto";
import { ALL_GRANTS, type Grant } from "@lume/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";

/**
 * The focus run inside LUME (spec 2026-11-26-focus-run-in-lume): each lead goes through the business's connected
 * WhatsApp number; the run's approved template outside the 24 hours, a message or the template inside them; a send
 * WhatsApp refuses later becomes Not sent; LUME AI can take the leads still waiting.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
let number: string;
const SNEHA = "+919876543210";
const H = 3_600_000;
const repGrants: Grant[] = [
  ...(
    ["leads.view", "leads.edit", "leads.change_stage", "messages.send", "messages.send_queue"] as const
  ).map((key) => ({ key, scope: "own" as const })),
  { key: "templates.use", scope: null },
];

const as = (u: U) => h.signIn(u);
const post = async (u: U, url: string, payload?: object) =>
  (await as(u)).inject({ method: "POST", url, ...(payload ? { payload } : {}) });
const get = async (u: U, url: string) => (await as(u)).inject({ method: "GET", url });
const item = (q: string, pos: number, what: string) => `/api/v1/queues/${q}/items/${pos}/${what}`;
const metaNameOf = async (submissionId: string) =>
  (
    await h.ownerPool.query<{ meta_name: string }>(
      "SELECT meta_name FROM whatsapp_template_submissions WHERE id = $1",
      [submissionId],
    )
  ).rows[0]!.meta_name;
/** A LUME template, submitted to WhatsApp; approved by its webhook unless told not to. */
async function template(name: string, body: string, o: { approve?: boolean } = {}) {
  const t = (await post(admin, "/api/v1/templates", { name, category: "first_touch", body })).json() as {
    id: string;
  };
  const s = await post(admin, `/api/v1/templates/${t.id}/whatsapp`, { language: "en" });
  expect(s.statusCode, s.body).toBe(202);
  const submissionId = s.json().submissions[0].id as string;
  if (o.approve !== false)
    expect(
      (await deliver(h, meta.templateUpdate(await metaNameOf(submissionId), { status: "APPROVED" })))
        .statusCode,
    ).toBe(200);
  return { id: t.id, submissionId };
}
const lead = (name: string, o: { owner?: string; phone?: string | null } = {}) =>
  h.seedLead({
    ownerId: o.owner ?? rep.id,
    name,
    ...(o.phone === null ? { phoneStatus: "missing" } : { phone: o.phone ?? SNEHA }),
  });
/** They wrote to the business `ago` ms back, to the connected number. */
const wrote = (leadId: string, ago: number) =>
  h.queryAll(
    `INSERT INTO activities (id, lead_id, type, occurred_at, payload)
     VALUES (gen_random_uuid(), $1, 'whatsapp_received', $2, $3::jsonb)`,
    [leadId, new Date(h.clock.now.getTime() - ago), JSON.stringify({ numberId: number, text: "Hi" })],
  );
const run = async (leadIds: string[], templateId?: string) => {
  const r = await post(rep, "/api/v1/queues", { leadIds, ...(templateId ? { templateId } : {}) });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().queue as { id: string };
};
/** As the rep, past the API: runs are their person's alone under row-level security. */
async function asRep<R>(text: string, params: unknown[]): Promise<R[]> {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      rep.id,
    ]);
    const r = await c.query(text, params);
    await c.query("COMMIT");
    return r.rows as R[];
  } finally {
    c.release();
  }
}
const view = async (q: string) => (await get(rep, `/api/v1/queues/${q}`)).json();
const outbox = (leadId: string) =>
  h.queryAll<{ id: string; status: string; text: string | null; submission_id: string | null }>(
    "SELECT id, status, text, submission_id FROM whatsapp_outbox WHERE lead_id = $1 ORDER BY created_at",
    [leadId],
  );
const send = (
  q: string,
  pos: number,
  body: { mode: "template" | "message"; text?: string; clientKey?: string },
) => post(rep, item(q, pos, "send"), { clientKey: randomUUID(), ...body });

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    preset: "coaching",
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version, appId: meta.appId },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: repGrants, totp: false, name: "Riya Sharma" });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.queryAll("DELETE FROM whatsapp_outbox");
  await h.ownerPool.query("DELETE FROM whatsapp_template_submissions");
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  await h.ownerPool.query("UPDATE settings SET messaging = '{}'::jsonb WHERE id = 1");
  meta.templates.clear();
  meta.sent.length = 0;
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
// One run at a time per person.
afterEach(async () => {
  const cur = (await get(rep, "/api/v1/queues/current")).json();
  if (cur) await post(rep, `/api/v1/queues/${cur.id}/cancel`);
});

describe("how each lead goes", () => {
  it("outside 24 hours: the run's approved template in this lead's words; inside: the window and the words", async () => {
    const t = await template(
      `Hello ${randomUUID().slice(0, 6)}`,
      "Hi {{lead.first_name}}, this is the studio.",
    );
    const a = await lead("Sneha Reddy");
    const q = await run([a], t.id);
    const out = (await get(rep, item(q.id, 0, "channel"))).json();
    expect(out).toMatchObject({
      via: "lume",
      window: { open: false, lastInAt: null, until: null },
      template: { submissionId: t.submissionId, preview: "Hi Sneha, this is the studio.", missing: [] },
    });
    await wrote(a, 3 * H);
    const inside = (await get(rep, item(q.id, 0, "channel"))).json();
    expect(inside).toMatchObject({
      via: "lume",
      window: {
        open: true,
        lastInAt: new Date(h.clock.now.getTime() - 3 * H).toISOString(),
        until: new Date(h.clock.now.getTime() + 21 * H).toISOString(),
      },
      template: { submissionId: t.submissionId },
      text: "Hi Sneha, this is the studio.",
    });
    expect(JSON.stringify(inside)).not.toContain("9876543210");
  });

  it("24 hours after they wrote, the window has closed: the template only", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const a = await lead("Sneha Reddy");
    await wrote(a, 25 * H);
    const q = await run([a], t.id);
    expect((await get(rep, item(q.id, 0, "channel"))).json()).toMatchObject({
      via: "lume",
      window: { open: false, until: null },
    });
    expect((await send(q.id, 0, { mode: "message", text: "Hi" })).json().error.code).toBe("WINDOW_CLOSED");
  });

  it("one asked not to be messaged since: not a card to send, the old one with why and Skip", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const a = await lead("Sneha Reddy");
    const q = await run([a], t.id);
    await h.queryAll("UPDATE leads SET dnc_at = now(), dnc_reason = 'Asked' WHERE id = $1", [a]);
    expect((await get(rep, item(q.id, 0, "channel"))).json()).toEqual({
      via: "whatsapp",
      why: "Asked not to be messaged",
    });
  });

  it("WhatsApp's way when LUME can't send: no number, Reply from LUME off, no WhatsApp number, can't message them", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const a = await lead("Sneha Reddy");
    const none = await lead("Kabir Das");
    const q = await run([a, none], t.id);
    // Their number gone since the run started.
    await h.queryAll("UPDATE leads SET phone_e164 = NULL, phone_status = 'missing' WHERE id = $1", [none]);
    await (
      await as(admin)
    ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: false } });
    expect((await get(rep, item(q.id, 0, "channel"))).json()).toEqual({
      via: "whatsapp",
      why: "Replying from LUME is off. An admin can switch it on in Settings → Integrations → WhatsApp.",
    });
    await (
      await as(admin)
    ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: true } });
    // Said as the run says it everywhere, and the card offers Skip.
    expect((await get(rep, item(q.id, 1, "channel"))).json()).toEqual({
      via: "whatsapp",
      why: "No WhatsApp number",
    });
    // The run's own number gone: said by its number.
    await h.ownerPool.query("UPDATE whatsapp_numbers SET status = 'disconnected', token_enc = NULL");
    expect((await get(rep, item(q.id, 0, "channel"))).json()).toEqual({
      via: "whatsapp",
      why: "+91 90000 00001 isn't connected any more.",
    });
  });

  it("the run's template not approved: outside 24 hours WhatsApp's way, inside a message", async () => {
    const name = `Not yet ${randomUUID().slice(0, 6)}`;
    const t = await template(name, "Hi there, this is the studio.", { approve: false });
    // Another template is approved: never sent in this one's place.
    await template(`Other ${randomUUID().slice(0, 6)}`, "Something else entirely.");
    const a = await lead("Sneha Reddy");
    const q = await run([a], t.id);
    expect((await get(rep, item(q.id, 0, "channel"))).json()).toEqual({
      via: "whatsapp",
      why: `${name} isn't approved by WhatsApp yet.`,
    });
    await wrote(a, H);
    expect((await get(rep, item(q.id, 0, "channel"))).json()).toMatchObject({
      via: "lume",
      window: { open: true },
      template: null,
      text: "Hi there, this is the studio.",
    });
  });

  it("the approved words, never an edit waiting for approval", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const edit = await (
      await as(admin)
    ).inject({
      method: "PATCH",
      url: `/api/v1/templates/${t.id}`,
      payload: { body: "A NEW line nobody approved." },
    });
    expect(edit.statusCode, edit.body).toBeLessThan(300);
    const q = await run([await lead("Sneha Reddy")], t.id);
    expect((await get(rep, item(q.id, 0, "channel"))).json().template.preview).toBe(
      "Hi there, this is the studio.",
    );
  });

  it("a run in the person's own words: inside 24 hours a message only, outside WhatsApp's way", async () => {
    const a = await lead("Sneha Reddy");
    const q = await run([a]);
    expect((await get(rep, item(q.id, 0, "channel"))).json()).toEqual({
      via: "whatsapp",
      why: "They haven't written in 24 hours, and a message from LUME then needs an approved template.",
    });
    await wrote(a, H);
    expect((await get(rep, item(q.id, 0, "channel"))).json()).toMatchObject({
      via: "lume",
      template: null,
      text: null,
    });
  });
});

describe("sending from the run", () => {
  it("the template: queued once, the item sent with its message, the next lead; the same key again is the same message", async () => {
    const t = await template(
      `Hello ${randomUUID().slice(0, 6)}`,
      "Hi {{lead.first_name}}, this is the studio.",
    );
    const [a, b] = [await lead("Sneha Reddy"), await lead("Kabir Das")];
    const q = await run([a, b], t.id);
    const key = randomUUID();
    const r = await send(q.id, 0, { mode: "template", clientKey: key });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ next: 1, message: { text: "Hi Sneha, this is the studio." } });
    const [o] = await outbox(a);
    expect(o).toMatchObject({ submission_id: t.submissionId, status: "queued" });
    const [it0] = await asRep<{ status: string; outbox_id: string }>(
      "SELECT status, outbox_id FROM send_queue_items WHERE queue_id = $1 AND position = 0",
      [q.id],
    );
    expect(it0).toEqual({ status: "sent", outbox_id: o!.id });
    // A retried request (the network dropped the answer): the same message, never a second.
    const again = await send(q.id, 0, { mode: "template", clientKey: key });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("ITEM_DONE");
    expect(await outbox(a)).toHaveLength(1);
    expect((await view(q.id)).today.sent).toBeGreaterThan(0);
  });

  it("a message only inside the 24 hours: their own words, else the run's", async () => {
    const t = await template(
      `Hello ${randomUUID().slice(0, 6)}`,
      "Hi {{lead.first_name}}, this is the studio.",
    );
    const [a, b] = [await lead("Sneha Reddy"), await lead("Kabir Das")];
    const q = await run([a, b], t.id);
    const outside = await send(q.id, 0, { mode: "message" });
    expect(outside.statusCode).toBe(409);
    expect(outside.json().error).toEqual({
      code: "WINDOW_CLOSED",
      message: "They haven't written in 24 hours, so only the template can go.",
    });
    expect(await outbox(a)).toEqual([]);
    await wrote(a, H);
    await wrote(b, H);
    expect((await send(q.id, 0, { mode: "message", text: "Just for you, Sneha" })).statusCode).toBe(200);
    expect((await outbox(a))[0]).toMatchObject({ text: "Just for you, Sneha", submission_id: null });
    expect((await send(q.id, 1, { mode: "message" })).statusCode).toBe(200);
    expect((await outbox(b))[0]).toMatchObject({ text: "Hi Kabir, this is the studio." });
  });

  it("two sends at once on one lead send one", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const a = await lead("Sneha Reddy");
    const q = await run([a, await lead("Kabir Das")], t.id);
    const [x, y] = await Promise.all([
      send(q.id, 0, { mode: "template" }),
      send(q.id, 0, { mode: "template" }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    expect(await outbox(a)).toHaveLength(1);
  });

  it("a refusal about the lead skips it with why", async () => {
    // A field the template needs, which one lead has and another doesn't.
    const key = `goal_${randomUUID().slice(0, 6)}`;
    await h.queryAll(
      "INSERT INTO field_definitions (id, key, label, type) VALUES (gen_random_uuid(), $1, 'Goal', 'text')",
      [key],
    );
    const t = await template(
      `Hello ${randomUUID().slice(0, 6)}`,
      `Hi {{lead.first_name}}, about {{lead.custom.${key}}}.`,
    );
    const off = await lead("Sneha Reddy");
    await h.queryAll(
      "UPDATE leads SET whatsapp_marketing_off_at = now(), custom = jsonb_build_object($2::text, 'Fat loss') WHERE id = $1",
      [off, key],
    );
    const nameless = await lead("Kabir Das");
    const q = await run([off, nameless, await lead("Kabir Das")], t.id);
    const r = await send(q.id, 0, { mode: "template" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      skipped: "This person turned off marketing messages from you on WhatsApp.",
      next: 1,
    });
    const m = await send(q.id, 1, { mode: "template" });
    expect(m.json()).toMatchObject({
      skipped: expect.stringMatching(/^Kabir has no .+ yet, so this template can't go/),
      next: 2,
    });
    expect((await view(q.id)).items.map((i: { status: string }) => i.status)).toEqual([
      "skipped",
      "skipped",
      "pending",
    ]);
  });

  it("a refusal that stops every send pauses the run; the lead waits", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const q = await run([await lead("Sneha Reddy"), await lead("Kabir Das")], t.id);
    await (
      await as(admin)
    ).inject({ method: "PUT", url: "/api/v1/settings/messaging", payload: { paidSendsMonthly: 1 } });
    expect((await send(q.id, 0, { mode: "template" })).statusCode).toBe(200);
    // Refused in words, and the pause is kept.
    const r = await send(q.id, 1, { mode: "template" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("PAID_LIMIT");
    const v = await view(q.id);
    expect(v).toMatchObject({
      status: "paused",
      pausedReason: expect.stringMatching(/paid WhatsApp messages/),
    });
    expect(v.items[1].status).toBe("pending");
  });

  it("refused by WhatsApp later: Not sent with why, off the day's count; Try again sends it again", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const a = await lead("Sneha Reddy");
    const q = await run([a, await lead("Kabir Das")], t.id);
    const before = (await view(q.id)).today.sent;
    expect((await send(q.id, 0, { mode: "template" })).statusCode).toBe(200);
    expect((await view(q.id)).today.sent).toBe(before + 1);
    await h.queryAll(
      "UPDATE whatsapp_outbox SET status = 'failed', problem = 'This number isn''t on WhatsApp.' WHERE lead_id = $1",
      [a],
    );
    const v = await view(q.id);
    expect(v.items[0]).toMatchObject({ status: "not_sent", reason: "This number isn't on WhatsApp." });
    expect(v.today.sent).toBe(before);
    expect((await post(rep, item(q.id, 0, "retry"))).statusCode).toBe(200);
    expect((await send(q.id, 0, { mode: "template" })).statusCode).toBe(200);
    expect(await outbox(a)).toHaveLength(2);
  });

  it("never {{…}} to a customer: a message with a value this lead hasn't got is refused until it's filled", async () => {
    const key = `goal_${randomUUID().slice(0, 6)}`;
    await h.queryAll(
      "INSERT INTO field_definitions (id, key, label, type) VALUES (gen_random_uuid(), $1, 'Goal', 'text')",
      [key],
    );
    const t = await template(
      `Hello ${randomUUID().slice(0, 6)}`,
      `Hi {{lead.first_name}}, about {{lead.custom.${key}}}.`,
    );
    const a = await lead("Sneha Reddy");
    await wrote(a, H);
    const q = await run([a], t.id);
    const r = await send(q.id, 0, { mode: "message" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("UNFILLED");
    expect(await outbox(a)).toEqual([]);
    expect((await send(q.id, 0, { mode: "message", text: "Hi Sneha, about fat loss." })).statusCode).toBe(
      200,
    );
  });

  it("refused, then confirmed after all (or sent again from their chat): back to sent, so Try again can't send it twice", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const [a, b] = [await lead("Sneha Reddy"), await lead("Kabir Das")];
    const q = await run([a, b], t.id);
    expect((await send(q.id, 0, { mode: "template" })).statusCode).toBe(200);
    expect((await send(q.id, 1, { mode: "template" })).statusCode).toBe(200);
    await h.queryAll(
      "UPDATE whatsapp_outbox SET status = 'failed', problem = 'Not sure it went.' WHERE lead_id = ANY($1)",
      [[a, b]],
    );
    expect((await view(q.id)).items.map((i: { status: string }) => i.status)).toEqual([
      "not_sent",
      "not_sent",
    ]);
    await h.queryAll("UPDATE whatsapp_outbox SET status = 'sent' WHERE lead_id = $1", [a]);
    await h.queryAll("UPDATE whatsapp_outbox SET status = 'cancelled' WHERE lead_id = $1", [b]);
    expect(
      (await view(q.id)).items.map((i: { status: string; reason: string | null }) => [i.status, i.reason]),
    ).toEqual([
      ["sent", null],
      ["sent", "Sent again from their chat"],
    ]);
    expect((await post(rep, item(q.id, 0, "retry"))).statusCode).toBe(409);
  });

  it("the day's cap: reached, the run pauses and nothing more goes", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const [a, b] = [await lead("Sneha Reddy"), await lead("Kabir Das")];
    const q = await run([a, b], t.id);
    const sentSoFar = (await view(q.id)).today.sent;
    await (
      await as(admin)
    ).inject({
      method: "PUT",
      url: "/api/v1/settings/messaging",
      payload: { dailyCap: sentSoFar + 1 },
    });
    expect((await send(q.id, 0, { mode: "template" })).statusCode).toBe(200);
    const r = await send(q.id, 1, { mode: "template" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("DAILY_CAP");
    expect(await outbox(b)).toEqual([]);
    expect((await view(q.id)).status).toBe("paused");
  });

  it("do not contact, a lead gone, a lead no longer theirs: skipped with why", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const [a, b, c] = [await lead("Sneha Reddy"), await lead("Kabir Das"), await lead("Zoya Khan")];
    const q = await run([a, b, c], t.id);
    await h.queryAll("UPDATE leads SET dnc_at = now(), dnc_reason = 'Asked' WHERE id = $1", [a]);
    await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [b]);
    await h.queryAll("UPDATE leads SET owner_id = $2 WHERE id = $1", [c, admin.id]);
    for (const pos of [0, 1, 2]) {
      const r = await send(q.id, pos, { mode: "template" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().skipped).toEqual(expect.any(String));
    }
    expect(meta.sent).toEqual([]);
  });
});

describe("before and around the run", () => {
  it("the plan says how the run will go", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const notYet = await template(`Draft ${randomUUID().slice(0, 6)}`, "Hi there.", { approve: false });
    const a = await lead("Sneha Reddy");
    await lead("No Phone", { phone: null });
    const b = await lead("Kabir Das");
    await wrote(b, H);
    const p = await post(rep, "/api/v1/queues/plan", { leadIds: [a, b] });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().lume).toEqual({
      on: true,
      numberId: number,
      through: 2,
      inWindow: 1,
      approvedTemplateIds: [t.id],
    });
    expect(p.json().lume.approvedTemplateIds).not.toContain(notYet.id);
    await (
      await as(admin)
    ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: false } });
    expect((await post(rep, "/api/v1/queues/plan", { leadIds: [a, b] })).json().lume).toMatchObject({
      on: false,
    });
  });

  it("handed to LUME AI: the leads its run took leave this one; the rest stay; none left, it finishes", async () => {
    const [a, b, c] = [await lead("Sneha Reddy"), await lead("Kabir Das"), await lead("Zoya Khan")];
    const q = await run([a, b, c]);
    const runId = randomUUID();
    await h.queryAll(
      `INSERT INTO autopilot_runs (id, name, started_by, speaker_id, number_id, goal, permissions, follow_up_days, outside_hours)
       VALUES ($1, 'Run', $2, $2, $3, '{"kind":"reply"}'::jsonb, '{}'::jsonb, '{}', 'wait')`,
      [runId, rep.id, number],
    );
    for (const l of [a, b])
      await h.queryAll(
        "INSERT INTO autopilot_leads (run_id, lead_id, state, active) VALUES ($1, $2, 'up_next', true)",
        [runId, l],
      );
    const r = await post(rep, `/api/v1/queues/${q.id}/handed`, { runId });
    expect(r.statusCode, r.body).toBe(200);
    expect(
      r.json().items.map((i: { status: string; reason: string | null }) => [i.status, i.reason]),
    ).toEqual([
      ["skipped", "Handed to LUME AI"],
      ["skipped", "Handed to LUME AI"],
      ["pending", null],
    ]);
    // Someone else's LUME AI run: as if it didn't exist.
    const other = randomUUID();
    await h.queryAll(
      `INSERT INTO autopilot_runs (id, name, started_by, speaker_id, number_id, goal, permissions, follow_up_days, outside_hours)
       VALUES ($1, 'Run', $2, $2, $3, '{"kind":"reply"}'::jsonb, '{}'::jsonb, '{}', 'wait')`,
      [other, admin.id, number],
    );
    expect((await post(rep, `/api/v1/queues/${q.id}/handed`, { runId: other })).statusCode).toBe(404);
    await h.queryAll(
      "INSERT INTO autopilot_leads (run_id, lead_id, state, active) VALUES ($1, $2, 'up_next', true)",
      [runId, c],
    );
    expect((await post(rep, `/api/v1/queues/${q.id}/handed`, { runId })).json().status).toBe("finished");
  });
});

describe("which number the run sends from (owner 2026-11-26)", () => {
  /** Another connected number: the business's unless owned; on the same WhatsApp account unless told. */
  const another = async (display: string, o: { owner?: string | null; waba?: string } = {}) => {
    const id = await seedNumber(h, {
      runAs: admin.id,
      owner: o.owner ?? null,
      phoneNumberId: `${Date.now()}${Math.random()}`.slice(0, 15),
    });
    await h.ownerPool.query(
      "UPDATE whatsapp_numbers SET display_phone = $2, waba_id = coalesce($3, waba_id) WHERE id = $1",
      [id, display, o.waba ?? null],
    );
    // seedNumber writes WhatsApp's settings afresh: Reply from LUME back on, as the tests set it.
    await h.ownerPool.query(
      "UPDATE settings SET integrations = jsonb_set(integrations, '{whatsapp,replyFromLume}', 'true'::jsonb) WHERE id = 1",
    );
    return id;
  };
  const wroteTo = (leadId: string, ago: number, numberId: string) =>
    h.queryAll(
      `INSERT INTO activities (id, lead_id, type, occurred_at, payload)
       VALUES (gen_random_uuid(), $1, 'whatsapp_received', $2, $3::jsonb)`,
      [leadId, new Date(h.clock.now.getTime() - ago), JSON.stringify({ numberId, text: "Hi" })],
    );
  const start = (body: object) => post(rep, "/api/v1/queues", body);
  const plan = async (leadIds: string[], numberId?: string) =>
    (await post(rep, "/api/v1/queues/plan", { leadIds, ...(numberId ? { numberId } : {}) })).json();
  const outboxNumbers = (leadId: string) =>
    h.queryAll<{ number_id: string }>("SELECT number_id FROM whatsapp_outbox WHERE lead_id = $1", [leadId]);

  it("the numbers this person may send from: the business's and their own, never a teammate's", async () => {
    const business = await another("+91 90000 00002");
    await another("+91 90000 00003", { owner: admin.id });
    const a = await lead("Sneha Reddy");
    expect((await plan([a])).numbers).toEqual([
      { id: business, display: "+91 90000 00002", whose: "the business's" },
      { id: number, display: "+91 90000 00001", whose: "Riya Sharma's" },
    ]);
  });

  it("two or more: nothing is chosen for them; the run starts only on the number they chose, and keeps it", async () => {
    const business = await another("+91 90000 00002");
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const a = await lead("Sneha Reddy");
    expect((await plan([a])).lume).toMatchObject({ on: true, numberId: null });
    const none = await start({ leadIds: [a], templateId: t.id });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe("NUMBER_REQUIRED");
    const teammate = await another("+91 90000 00003", { owner: admin.id });
    const theirs = await start({ leadIds: [a], templateId: t.id, numberId: teammate });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().error.code).toBe("NUMBER_NOT_YOURS");
    const r = await start({ leadIds: [a], templateId: t.id, numberId: business });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().queue.number).toEqual({ display: "+91 90000 00002", whose: "the business's" });
    // The rep's own number is the lead owner's, yet the template goes from the run's.
    expect((await send(r.json().queue.id, 0, { mode: "template" })).statusCode).toBe(200);
    expect(await outboxNumbers(a)).toEqual([{ number_id: business }]);
  });

  it("one number they can use: no choice to make, and the run keeps it", async () => {
    const a = await lead("Sneha Reddy");
    const p = await plan([a]);
    expect(p.numbers).toHaveLength(1);
    expect(p.lume).toMatchObject({ on: true, numberId: number });
    const q = await run([a]);
    expect((await view(q.id)).number).toEqual({ display: "+91 90000 00001", whose: "Riya Sharma's" });
  });

  it("you can text them directly only when they wrote to the run's number in the last 24 hours", async () => {
    const business = await another("+91 90000 00002");
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const [a, b] = [await lead("Sneha Reddy"), await lead("Kabir Das")];
    await wroteTo(a, H, number); // to the rep's own number, not the run's
    await wroteTo(b, 2 * H, business);
    await wroteTo(b, H, number); // later, to the other one
    const p = await plan([a, b], business);
    expect(p.lume).toMatchObject({ numberId: business, inWindow: 1 });
    const r = await start({ leadIds: [a, b], templateId: t.id, numberId: business });
    const q = r.json().queue.id as string;
    expect((await get(rep, item(q, 0, "channel"))).json().window.open).toBe(false);
    expect((await send(q, 0, { mode: "message" })).json().error.code).toBe("WINDOW_CLOSED");
    expect((await get(rep, item(q, 1, "channel"))).json().window.open).toBe(true);
    expect((await send(q, 1, { mode: "message", text: "Hi Kabir" })).statusCode).toBe(200);
    // From the run's number, not the one they wrote to last.
    expect(await outboxNumbers(b)).toEqual([{ number_id: business }]);
  });

  it("only templates approved on the run's number's WhatsApp account", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const other = await another("+91 90000 00002", { waba: "999000111222333" });
    const a = await lead("Sneha Reddy");
    expect((await plan([a], other)).lume.approvedTemplateIds).toEqual([]);
    const r = await start({ leadIds: [a], templateId: t.id, numberId: other });
    const ch = (await get(rep, item(r.json().queue.id, 0, "channel"))).json();
    expect(ch.via).toBe("whatsapp");
  });

  it("the run's number gone while it's open: its leads open WhatsApp, and say why", async () => {
    const a = await lead("Sneha Reddy");
    const q = await run([a]);
    await h.ownerPool.query(
      "UPDATE whatsapp_numbers SET status = 'disconnected', token_enc = NULL WHERE id = $1",
      [number],
    );
    await another("+91 90000 00002");
    expect((await get(rep, item(q.id, 0, "channel"))).json()).toEqual({
      via: "whatsapp",
      why: "+91 90000 00001 isn't connected any more.",
    });
  });

  it("a run from before numbers were chosen goes as it did: from the lead owner's number", async () => {
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const a = await lead("Sneha Reddy");
    const q = await run([a], t.id);
    await asRep("UPDATE send_queues SET number_id = NULL, number_asked = false WHERE id = $1", [q.id]);
    expect((await view(q.id)).number).toBeNull();
    expect((await get(rep, item(q.id, 0, "channel"))).json().via).toBe("lume");
  });

  it("Leads → Messaged from: the leads a number reached, not one it failed to, and from the phone too", async () => {
    const business = await another("+91 90000 00002");
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const [a, b, c, d] = [
      await lead("Sneha Reddy"),
      await lead("Kabir Das"),
      await lead("Zoya Khan"),
      await lead("Ira Sen"),
    ];
    // One who only wrote to the business's number: written to it, never messaged from it.
    await wroteTo(await lead("Only Wrote"), H, business);
    const r = await start({ leadIds: [a, b], templateId: t.id, numberId: business });
    const q = r.json().queue.id as string;
    expect((await send(q, 0, { mode: "template" })).statusCode).toBe(200);
    expect((await send(q, 1, { mode: "template" })).statusCode).toBe(200);
    await h.queryAll("UPDATE whatsapp_outbox SET status = 'failed' WHERE lead_id = $1", [b]);
    // Sent from the phone's WhatsApp (no outbox), and one from the rep's own number.
    await h.queryAll(
      `INSERT INTO activities (id, lead_id, type, occurred_at, payload) VALUES
         (gen_random_uuid(), $1, 'whatsapp_sent', now(), $3::jsonb),
         (gen_random_uuid(), $2, 'whatsapp_sent', now(), $4::jsonb)`,
      [
        c,
        d,
        JSON.stringify({ numberId: business, text: "Hi" }),
        JSON.stringify({ numberId: number, text: "Hi" }),
      ],
    );
    const ids = async (n: string) =>
      ((await get(rep, `/api/v1/leads?messagedFrom=${n}&limit=50`)).json().items as { id: string }[])
        .map((l) => l.id)
        .sort();
    expect(await ids(business)).toEqual([a, c].sort());
    expect(await ids(number)).toEqual([d]);
    expect(await ids(randomUUID())).toEqual([]);
    expect((await get(rep, "/api/v1/leads?messagedFrom=nope")).statusCode).toBe(400);
    // Every number, for the filter's menu: whose each is, never a token or an account id.
    const list = (await get(rep, "/api/v1/wa-numbers")).json();
    expect(list.numbers).toEqual([
      { id: number, display: "+91 90000 00001", whose: "Riya Sharma's", connected: true },
      { id: business, display: "+91 90000 00002", whose: "the business's", connected: true },
    ]);
  });

  it("a lead's chat says which number each message went from or came to, once there's more than one", async () => {
    const a = await lead("Sneha Reddy");
    await wroteTo(a, H, number);
    const thread = async () =>
      (await get(rep, `/api/v1/leads/${a}/whatsapp`)).json().messages as { number?: string }[];
    expect((await thread()).map((m) => m.number)).toEqual([undefined]);
    const business = await another("+91 90000 00002");
    const t = await template(`Hello ${randomUUID().slice(0, 6)}`, "Hi there, this is the studio.");
    const r = await start({ leadIds: [a], templateId: t.id, numberId: business });
    expect((await send(r.json().queue.id, 0, { mode: "template" })).statusCode).toBe(200);
    expect((await thread()).map((m) => m.number)).toEqual(["+91 90000 00001", "+91 90000 00002"]);
  });

  it("no number of their own, though a teammate's is connected: the run opens WhatsApp, never from the teammate's", async () => {
    await h.ownerPool.query("UPDATE whatsapp_numbers SET owner_user_id = $1 WHERE id = $2", [
      admin.id,
      number,
    ]);
    const a = await lead("Sneha Reddy");
    const p = await plan([a]);
    expect(p.numbers).toEqual([]);
    expect(p.lume.on).toBe(false);
    const q = (await start({ leadIds: [a] })).json().queue.id as string;
    expect((await get(rep, item(q, 0, "channel"))).json()).toEqual({
      via: "whatsapp",
      why: "No WhatsApp number of yours is connected to LUME.",
    });
    expect((await send(q, 0, { mode: "template" })).json().error.code).toBe("NOT_THROUGH_LUME");
  });

  it("Reply from LUME off: no number to choose", async () => {
    await another("+91 90000 00002");
    await (
      await as(admin)
    ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: false } });
    const a = await lead("Sneha Reddy");
    const p = await plan([a]);
    expect(p.numbers).toEqual([]);
    expect((await start({ leadIds: [a] })).statusCode).toBe(201);
  });
});
