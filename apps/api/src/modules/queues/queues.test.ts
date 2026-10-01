import { ALL_GRANTS, localDayBounds, newId, type Grant } from "@lume/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;
let repId: string;
let adminId: string;
// A masked rep: runs queues over their own leads, never sees a full number.
const repGrants: Grant[] = [
  ...(
    ["leads.view", "leads.edit", "leads.change_stage", "messages.send", "messages.send_queue"] as const
  ).map((key) => ({ key, scope: "own" as const })),
  { key: "templates.use", scope: null },
];
const NUMBER = "+971507654321";

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  const a = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  adminId = a.id;
  admin = await h.signIn(a);
  const r = await h.seedUser({ grants: repGrants, totp: true, name: "Riya Sharma" });
  repId = r.id;
  rep = await h.signIn(r);
});
afterAll(() => h.close());
// One run at a time per person: every test leaves none open.
afterEach(async () => {
  for (const c of [rep, admin]) {
    const cur = (await c.inject({ method: "GET", url: "/api/v1/queues/current" })).json();
    if (cur) await post(c, `/api/v1/queues/${cur.id}/cancel`);
  }
});

const post = (c: AuthedClient, url: string, payload?: unknown) =>
  c.inject({ method: "POST", url, ...(payload !== undefined ? { payload: payload as object } : {}) });
const get = (c: AuthedClient, url: string) => c.inject({ method: "GET", url });
const template = async (name: string) =>
  (
    await h.queryAll<{ id: string; version: string }>(
      "SELECT id, current_version_id AS version FROM message_templates WHERE name = $1",
      [name],
    )
  )[0]!;
const leads = (n: number, tag: string, o: { ownerId?: string } = {}) =>
  Promise.all(
    Array.from({ length: n }, (_, i) =>
      h.seedLead({
        ownerId: o.ownerId ?? repId,
        name: `${tag} ${String.fromCharCode(65 + i)}`,
        phone: NUMBER,
      }),
    ),
  );
const start = (c: AuthedClient, body: Record<string, unknown>) => post(c, "/api/v1/queues", body);
const item = (q: string, pos: number, what: string, body?: unknown) =>
  `/api/v1/queues/${q}/items/${pos}/${what}` + (body === undefined ? "" : "");
/** As a person, past the API: runs are their person's alone under row-level security. */
async function asUser(userId: string, text: string, params: unknown[]) {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      userId,
    ]);
    await c.query(text, params);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
const setMessaging = (body: Record<string, number>) =>
  admin.inject({ method: "PUT", url: "/api/v1/settings/messaging", payload: body });

describe("planning a run (4C Task 2)", () => {
  it("from a view: its leads in its order, and who's left out and why", async () => {
    const tag = "Planview";
    const [charlie, alpha] = [
      await h.seedLead({ ownerId: repId, name: `${tag} Charlie`, phone: NUMBER }),
      await h.seedLead({ ownerId: repId, name: `${tag} Alpha`, phone: NUMBER }),
    ];
    await h.seedLead({ ownerId: repId, name: `${tag} Bravo`, phoneStatus: "missing" });
    await h.seedLead({
      ownerId: repId,
      name: `${tag} Delta`,
      phoneRaw: "050 123 4567",
      phoneStatus: "needs_country",
    });
    // Not the rep's: row-level security keeps it out of their view altogether.
    await h.seedLead({ ownerId: adminId, name: `${tag} Echo`, phone: NUMBER });
    const view = (
      await post(rep, "/api/v1/views", {
        name: "Plan view",
        color: "accent",
        filters: { q: tag, sort: "name" },
      })
    ).json();
    const t = await template("First hello");
    const r = await start(rep, { viewId: view.id, templateId: t.id });
    expect(r.statusCode).toBe(201);
    const { queue, leftOut, more } = r.json();
    expect(queue).toMatchObject({
      status: "active",
      sourceName: "Plan view",
      templateName: "First hello",
      total: 2,
      done: { sent: 0, notSent: 0, skipped: 0 },
      today: { sent: 0, cap: 150 },
    });
    expect(queue.items.map((i: { leadId: string }) => i.leadId)).toEqual([alpha, charlie]);
    expect(queue.items[0]).toMatchObject({
      position: 0,
      name: `${tag} Alpha`,
      status: "pending",
      reason: null,
    });
    expect(queue.items[0].stageName).toBeTruthy();
    expect(leftOut).toEqual([
      { name: `${tag} Bravo`, reason: "No WhatsApp number" },
      { name: `${tag} Delta`, reason: "The number needs a country code" },
    ]);
    expect(more).toBe(0);
  });

  it("from a selection: its own order, capped at the run size, and the rest wait", async () => {
    expect((await setMessaging({ queueSize: 2 })).statusCode).toBe(200);
    try {
      const [a, b, c] = await leads(3, "Selection");
      const r = await start(rep, { leadIds: [c, a, b] });
      expect(r.statusCode).toBe(201);
      expect(r.json().queue).toMatchObject({ sourceName: "Your selection", templateName: null, total: 2 });
      expect(r.json().queue.items.map((i: { leadId: string }) => i.leadId)).toEqual([c, a]);
      expect(r.json().more).toBe(1);
    } finally {
      await setMessaging({ queueSize: 50 });
    }
  });

  it("leaves out a lead the person sees but may not message", async () => {
    // Sees every lead, messages only their own.
    const u = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "all" },
        { key: "messages.send", scope: "own" },
        { key: "messages.send_queue", scope: "own" },
      ],
      totp: true,
    });
    const viewer = await h.signIn(u);
    const [theirs] = await leads(1, "Viewerown", { ownerId: u.id });
    const [others] = await leads(1, "Viewerothers", { ownerId: adminId });
    const r = await start(viewer, { leadIds: [others, theirs] });
    expect(r.statusCode).toBe(201);
    expect(r.json().queue.items.map((i: { leadId: string }) => i.leadId)).toEqual([theirs]);
    expect(r.json().leftOut).toEqual([{ name: "Viewerothers A", reason: "Not one you may message" }]);
    await post(viewer, `/api/v1/queues/${r.json().queue.id}/cancel`);
  });

  it("nothing to send: says so, and starts nothing", async () => {
    const lead = await h.seedLead({ ownerId: repId, name: "Nonumber", phoneStatus: "missing" });
    const r = await start(rep, { leadIds: [lead] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: "NOTHING_TO_SEND" });
    expect((await get(rep, "/api/v1/queues/current")).json()).toBeNull();
  });

  it("one run at a time: another waits until this one is finished or ended", async () => {
    const [a] = await leads(1, "Onerun");
    const first = await start(rep, { leadIds: [a] });
    expect(first.statusCode).toBe(201);
    const again = await start(rep, { leadIds: [a] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({
      code: "QUEUE_OPEN",
      message: "Finish or end your current run first",
    });
    const cur = (await get(rep, "/api/v1/queues/current")).json();
    expect(cur.id).toBe(first.json().queue.id);
    expect((await post(rep, `/api/v1/queues/${cur.id}/cancel`)).json()).toMatchObject({
      status: "cancelled",
    });
    expect((await get(rep, "/api/v1/queues/current")).json()).toBeNull();
    expect((await start(rep, { leadIds: [a] })).statusCode).toBe(201);
  });

  it("a plan first (Task 3): who'd be in, who's left out, today's count, and any open run — and nothing starts", async () => {
    const [a, b] = await leads(2, "Planonly");
    const bare = await h.seedLead({ ownerId: repId, name: "Planonly Z", phoneStatus: "missing" });
    const r = await post(rep, "/api/v1/queues/plan", { leadIds: [a, bare, b] });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      total: 2,
      leftOut: [{ name: "Planonly Z", reason: "No WhatsApp number" }],
      more: 0,
      today: { sent: expect.any(Number), cap: 150 },
      open: null,
    });
    expect((await get(rep, "/api/v1/queues/current")).json()).toBeNull();
    // With a run open, the plan says so, and how far it has got.
    const q = (await start(rep, { leadIds: [a, b] })).json().queue;
    await post(rep, item(q.id, 0, "skip"));
    expect((await post(rep, "/api/v1/queues/plan", { leadIds: [a] })).json().open).toEqual({
      id: q.id,
      status: "active",
      sourceName: "Your selection",
      done: 1,
      total: 2,
    });
  });

  it("a run is its person's alone", async () => {
    const [a] = await leads(1, "Private");
    const q = (await start(rep, { leadIds: [a] })).json().queue;
    expect((await get(admin, `/api/v1/queues/${q.id}`)).statusCode).toBe(404);
    expect((await post(admin, item(q.id, 0, "prepare"), { text: "Hi" })).statusCode).toBe(404);
    expect((await post(admin, `/api/v1/queues/${q.id}/cancel`)).statusCode).toBe(404);
  });
});

describe("running it", () => {
  it("prepare, Sent?, next: each lead once, logged as a queued send, and the run finishes", async () => {
    const [a, b, c] = await leads(3, "Runflow");
    const t = await template("First hello");
    const q = (await start(rep, { leadIds: [a, b, c], templateId: t.id })).json().queue;
    // No text: the planned template, in this lead's words.
    const p = await post(rep, item(q.id, 0, "prepare"), {});
    expect(p.statusCode).toBe(200);
    expect(p.json().url).toMatch(/^https:\/\/wa\.me\/971507654321\?text=/);
    expect(p.json().text).toMatch(/^Hi Runflow, this is Riya from /);
    const s = await post(rep, item(q.id, 0, "sent"));
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ next: 1 });
    const sent = await h.queryAll<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM activities WHERE lead_id = $1 AND type = 'whatsapp_confirmed_sent'",
      [a],
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ queueId: q.id, templateVersionId: t.version });
    // Own words for this one lead.
    const own = await post(rep, item(q.id, 1, "prepare"), { text: "Just for you" });
    expect(own.json()).toMatchObject({ text: "Just for you" });
    expect((await post(rep, item(q.id, 1, "not-sent"))).json()).toMatchObject({ next: 2 });
    expect((await post(rep, item(q.id, 2, "skip"))).json()).toMatchObject({ next: null, finished: true });
    const done = (await get(rep, `/api/v1/queues/${q.id}`)).json();
    expect(done).toMatchObject({
      status: "finished",
      done: { sent: 1, notSent: 1, skipped: 1 },
      today: { sent: 1 },
    });
    expect(done.items.map((i: { status: string }) => i.status)).toEqual(["sent", "not_sent", "skipped"]);
    expect((await get(rep, "/api/v1/queues/current")).json()).toBeNull();
  });

  it("each lead's words before Send (Task 4): the planned template in their words, with nothing claimed", async () => {
    const [a] = await leads(1, "Wordsfirst");
    const t = await template("First hello");
    const q = (await start(rep, { leadIds: [a], templateId: t.id })).json().queue;
    const r = await get(rep, item(q.id, 0, "text"));
    expect(r.statusCode).toBe(200);
    expect(r.json().text).toMatch(/^Hi Wordsfirst, this is Riya from /);
    expect(r.json().missing).toEqual([]);
    expect(r.body).not.toMatch(/7654321/);
    expect((await get(rep, `/api/v1/queues/${q.id}`)).json().items[0].status).toBe("pending");
    // Own words: nothing to show yet. A lead that can't be sent any more: why, and nothing skipped yet.
    const [b] = await leads(1, "Wordsown");
    await post(rep, `/api/v1/queues/${q.id}/cancel`);
    const own = (await start(rep, { leadIds: [b] })).json().queue;
    expect((await get(rep, item(own.id, 0, "text"))).json()).toEqual({ text: "", missing: [] });
    await h.queryAll("UPDATE leads SET phone_e164 = NULL, phone_status = 'missing' WHERE id = $1", [b]);
    expect((await get(rep, item(own.id, 0, "text"))).json()).toEqual({ unavailable: "No WhatsApp number" });
    expect((await get(rep, `/api/v1/queues/${own.id}`)).json().items[0].status).toBe("pending");
  });

  it("skipping a lead that can't be sent any more records why, not just that it was skipped", async () => {
    const [a, b] = await leads(2, "Skipwhy");
    const q = (await start(rep, { leadIds: [a, b] })).json().queue;
    await h.queryAll("UPDATE leads SET phone_e164 = NULL, phone_status = 'missing' WHERE id = $1", [a]);
    await post(rep, item(q.id, 0, "skip"));
    await post(rep, item(q.id, 1, "skip"));
    const items = (await get(rep, `/api/v1/queues/${q.id}`)).json().items;
    expect(items.map((i: { reason: string }) => i.reason)).toEqual(["No WhatsApp number", "Skipped"]);
  });

  it("sent, not sent and skip are each once per lead", async () => {
    const [a, b] = await leads(2, "Onceeach");
    const q = (await start(rep, { leadIds: [a, b] })).json().queue;
    // Nothing to answer before WhatsApp was opened.
    expect((await post(rep, item(q.id, 0, "sent"))).statusCode).toBe(409);
    expect((await post(rep, item(q.id, 0, "not-sent"))).statusCode).toBe(409);
    await post(rep, item(q.id, 0, "prepare"), { text: "Hi" });
    expect((await post(rep, item(q.id, 0, "sent"))).statusCode).toBe(200);
    for (const what of ["sent", "not-sent", "skip"])
      expect((await post(rep, item(q.id, 0, what))).json().error).toMatchObject({ code: "ITEM_DONE" });
    expect((await post(rep, item(q.id, 0, "prepare"), { text: "Hi" })).json().error).toMatchObject({
      code: "ITEM_DONE",
    });
    expect((await post(rep, item(q.id, 9, "prepare"), { text: "Hi" })).statusCode).toBe(404);
    // Own words need words.
    expect((await post(rep, item(q.id, 1, "prepare"), {})).statusCode).toBe(400);
  });

  it("Review Focus 1: two tabs on one lead: one sends, the other is told and moves on", async () => {
    const [a, b] = await leads(2, "Twotabs");
    const q = (await start(rep, { leadIds: [a, b] })).json().queue;
    const [x, y] = await Promise.all([
      post(rep, item(q.id, 0, "prepare"), { text: "Hi" }),
      post(rep, item(q.id, 0, "prepare"), { text: "Hi" }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    const lost = x.statusCode === 409 ? x : y;
    expect(lost.json().error).toMatchObject({ code: "ITEM_TAKEN", details: { next: 1 } });
    const opened = await h.queryAll(
      "SELECT 1 FROM activities WHERE lead_id = $1 AND type = 'whatsapp_opened'",
      [a],
    );
    expect(opened).toHaveLength(1);
    const [s1, s2] = await Promise.all([post(rep, item(q.id, 0, "sent")), post(rep, item(q.id, 0, "sent"))]);
    expect([s1.statusCode, s2.statusCode].sort()).toEqual([200, 409]);
    const sent = await h.queryAll(
      "SELECT 1 FROM activities WHERE lead_id = $1 AND type = 'whatsapp_confirmed_sent'",
      [a],
    );
    expect(sent).toHaveLength(1);
  });

  it("Review Focus 3: a lead reassigned, deleted or left without a number is skipped with why, and the run goes on", async () => {
    const [moved, gone, bare, fine] = await leads(4, "Lostlead");
    const q = (await start(rep, { leadIds: [moved, gone, bare, fine] })).json().queue;
    await h.queryAll("UPDATE leads SET owner_id = $1 WHERE id = $2", [adminId, moved]);
    expect((await admin.inject({ method: "DELETE", url: `/api/v1/leads/${gone}` })).statusCode).toBe(204);
    await h.queryAll(
      "UPDATE leads SET phone_e164 = NULL, phone_raw = NULL, phone_status = 'missing' WHERE id = $1",
      [bare],
    );
    const answers = [];
    for (const pos of [0, 1, 2])
      answers.push((await post(rep, item(q.id, pos, "prepare"), { text: "Hi" })).json());
    expect(answers).toEqual([
      { skipped: "No longer one of your leads, or deleted", next: 1 },
      { skipped: "No longer one of your leads, or deleted", next: 2 },
      { skipped: "No WhatsApp number", next: 3 },
    ]);
    expect((await post(rep, item(q.id, 3, "prepare"), { text: "Hi" })).statusCode).toBe(200);
    const run = (await get(rep, `/api/v1/queues/${q.id}`)).json();
    expect(run).toMatchObject({ status: "active", done: { skipped: 3 } });
    expect(run.items[2]).toMatchObject({ status: "skipped", reason: "No WhatsApp number" });
    // Rights changed mid-run: the same.
    await h.revokeGrant(repId, "messages.send");
    await h.waitForRbacNotify();
    try {
      const r = await post(rep, item(q.id, 3, "sent"));
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ next: null, finished: true });
      // It went (WhatsApp was open, and they said so): it counts as sent, though it can't be logged on the lead.
      expect((await get(rep, `/api/v1/queues/${q.id}`)).json().items[3]).toMatchObject({
        status: "sent",
        reason: "Sent, but not logged on the lead: Not one you may message",
      });
    } finally {
      await h.grant(repId, [{ key: "messages.send", scope: "own" }]);
      await h.waitForRbacNotify();
    }
  });

  it("Review Focus 5: a template edited, then archived, mid-run still sends the planned words", async () => {
    const [a, b] = await leads(2, "Planned");
    const t = await template("Gentle nudge");
    const q = (await start(rep, { leadIds: [a, b], templateId: t.id })).json().queue;
    const planned = (await post(rep, item(q.id, 0, "prepare"), {})).json().text as string;
    await post(rep, item(q.id, 0, "skip"));
    expect(
      (
        await admin.inject({
          method: "PATCH",
          url: `/api/v1/templates/${t.id}`,
          payload: { body: "Changed words" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await post(admin, `/api/v1/templates/${t.id}/archive`)).statusCode).toBeLessThan(300);
    try {
      const p = await post(rep, item(q.id, 1, "prepare"), {});
      expect(p.statusCode).toBe(200);
      expect(p.json().text).toBe(planned.replace("Planned A", "Planned B"));
      expect(p.json().text).not.toContain("Changed words");
      const opened = await h.queryAll<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM activities WHERE lead_id = $1 AND type = 'whatsapp_opened'",
        [b],
      );
      expect(opened[0]!.payload).toMatchObject({ templateVersionId: t.version, queueId: q.id });
      expect((await get(rep, `/api/v1/queues/${q.id}`)).json().templateName).toBe("Gentle nudge");
    } finally {
      await post(admin, `/api/v1/templates/${t.id}/restore`);
    }
  });

  it("pause, resume and cancel", async () => {
    const [a] = await leads(1, "Pausing");
    const q = (await start(rep, { leadIds: [a] })).json().queue;
    expect((await post(rep, `/api/v1/queues/${q.id}/pause`)).json()).toMatchObject({
      status: "paused",
      pausedReason: null,
    });
    // Paused is still the current run (Resume finds it).
    expect((await get(rep, "/api/v1/queues/current")).json().id).toBe(q.id);
    expect((await post(rep, item(q.id, 0, "prepare"), { text: "Hi" })).json().error).toMatchObject({
      code: "QUEUE_PAUSED",
    });
    expect((await post(rep, `/api/v1/queues/${q.id}/resume`)).json()).toMatchObject({ status: "active" });
    expect((await post(rep, `/api/v1/queues/${q.id}/cancel`)).json()).toMatchObject({ status: "cancelled" });
    expect((await post(rep, `/api/v1/queues/${q.id}/resume`)).json().error).toMatchObject({
      code: "QUEUE_OVER",
    });
    expect((await post(rep, item(q.id, 0, "prepare"), { text: "Hi" })).json().error).toMatchObject({
      code: "QUEUE_OVER",
    });
  });

  it("Review Focus 2: the daily cap counts queued sends since midnight where the person is", async () => {
    const KOLKATA = "Asia/Kolkata";
    // Someone with no sends yet today.
    const k = await h.seedUser({ grants: repGrants, totp: true, name: "Kiran Rao" });
    const kiran = await h.signIn(k);
    await h.ownerPool.query("UPDATE users SET timezone = $1 WHERE id = $2", [KOLKATA, k.id]);
    // The business is elsewhere: its midnight must not be the one that counts.
    const [{ timezone: businessTz }] = (await h.ownerPool.query("SELECT timezone FROM settings WHERE id = 1"))
      .rows;
    await h.ownerPool.query("UPDATE settings SET timezone = 'America/Los_Angeles' WHERE id = 1");
    await setMessaging({ dailyCap: 2 });
    const [a, b] = await leads(2, "Capped", { ownerId: k.id });
    const before = await leads(3, "Cappedbefore", { ownerId: k.id });
    const midnight = localDayBounds(new Date(), KOLKATA).start.getTime();
    const minute = 60_000;
    // An earlier run of the rep's today: two sent after midnight in Kolkata, one just before it.
    const earlier = newId();
    await asUser(
      k.id,
      "INSERT INTO send_queues (id, user_id, source, source_name, status, finished_at) VALUES ($1, $2, 'selection', 'Your selection', 'finished', now())",
      [earlier, k.id],
    );
    const sentAt = (pos: number, at: number) =>
      asUser(
        k.id,
        "INSERT INTO send_queue_items (queue_id, position, lead_id, status, done_at) VALUES ($1, $2, $3, 'sent', $4)",
        [earlier, pos, before[pos], new Date(at)],
      );
    try {
      await sentAt(0, midnight + minute);
      await sentAt(1, midnight + 2 * minute);
      await sentAt(2, midnight - minute);
      // A one-off send from the drawer doesn't count.
      expect((await post(kiran, `/api/v1/leads/${b}/messages/prepare`, { text: "Hi" })).statusCode).toBe(200);
      expect((await post(kiran, `/api/v1/leads/${b}/messages/confirm`, { sent: true })).statusCode).toBe(200);
      const q = (await start(kiran, { leadIds: [a, b] })).json().queue;
      expect(q.today).toEqual({ sent: 2, cap: 2 });
      const r = await post(kiran, item(q.id, 0, "prepare"), { text: "Hi" });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatchObject({
        code: "DAILY_CAP",
        message: "You've sent today's 2; the run is paused until tomorrow",
      });
      const paused = (await get(kiran, `/api/v1/queues/${q.id}`)).json();
      expect(paused).toMatchObject({ status: "paused", pausedReason: "daily_cap" });
      expect(paused.items[0].status).toBe("pending");
      // Still today: resuming says so again.
      expect((await post(kiran, `/api/v1/queues/${q.id}/resume`)).json().error).toMatchObject({
        code: "DAILY_CAP",
      });
      // A new day in Kolkata: those two were yesterday's.
      await asUser(
        k.id,
        "UPDATE send_queue_items SET done_at = done_at - interval '1 hour' WHERE queue_id = $1",
        [earlier],
      );
      expect((await post(kiran, `/api/v1/queues/${q.id}/resume`)).json()).toMatchObject({
        status: "active",
        today: { sent: 0, cap: 2 },
      });
      expect((await post(kiran, item(q.id, 0, "prepare"), { text: "Hi" })).statusCode).toBe(200);
    } finally {
      const cur = (await get(kiran, "/api/v1/queues/current")).json();
      if (cur) await post(kiran, `/api/v1/queues/${cur.id}/cancel`);
      await setMessaging({ dailyCap: 150 });
      await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [businessTz]);
      await h.ownerPool.query("UPDATE users SET timezone = NULL WHERE id = $1", [k.id]);
    }
  });

  it("Review Focus 4: a masked rep's run never carries the number, except in the WhatsApp link", async () => {
    const [a, b, c] = await leads(3, "Maskedrun");
    await h.seedLead({ ownerId: repId, name: "Maskedrun Z", phoneStatus: "missing" });
    const view = (
      await post(rep, "/api/v1/views", { name: "Masked run", color: "ok", filters: { q: "Maskedrun" } })
    ).json();
    const bodies: string[] = [];
    const s = await start(rep, { viewId: view.id, templateId: (await template("First hello")).id });
    bodies.push(s.body);
    const q = s.json().queue;
    bodies.push((await start(rep, { leadIds: [a] })).body); // 409
    bodies.push((await get(rep, "/api/v1/queues/current")).body);
    const p = (await post(rep, item(q.id, 0, "prepare"), {})).json();
    expect(p.url).toContain("971507654321");
    bodies.push(JSON.stringify({ ...p, url: undefined }));
    bodies.push((await post(rep, item(q.id, 0, "prepare"), {})).body); // 409
    bodies.push((await post(rep, item(q.id, 0, "sent"))).body);
    bodies.push((await post(rep, item(q.id, 1, "skip"))).body);
    bodies.push((await post(rep, `/api/v1/queues/${q.id}/pause`)).body);
    bodies.push((await post(rep, item(q.id, 2, "prepare"), {})).body); // paused
    bodies.push((await post(rep, `/api/v1/queues/${q.id}/resume`)).body);
    bodies.push((await get(rep, `/api/v1/queues/${q.id}`)).body);
    bodies.push((await post(rep, `/api/v1/queues/${q.id}/cancel`)).body);
    for (const body of bodies) expect(body).not.toMatch(/7654321|507654/);
    expect([b, c]).toHaveLength(2);
  });

  it("final review #1: a lead open in another tab can't be skipped from this one; Not sent is the way to let it go", async () => {
    const [a, b] = await leads(2, "Skipsending");
    const q = (await start(rep, { leadIds: [a, b] })).json().queue;
    await post(rep, item(q.id, 0, "prepare"), { text: "Hi" });
    expect((await post(rep, item(q.id, 0, "skip"))).json().error).toMatchObject({ code: "ITEM_TAKEN" });
    expect((await post(rep, item(q.id, 0, "not-sent"))).statusCode).toBe(200);
  });

  it("final review #3: ending a run lets go of a lead left open, so it never counts against the cap", async () => {
    const k = await h.seedUser({ grants: repGrants, totp: true, name: "Cap Keeper" });
    const who = await h.signIn(k);
    const [a, b, c] = await leads(3, "Endopen", { ownerId: k.id });
    const q = (await start(who, { leadIds: [a, b] })).json().queue;
    await post(who, item(q.id, 0, "prepare"), { text: "Hi" });
    const ended = (await post(who, `/api/v1/queues/${q.id}/cancel`)).json();
    expect(ended.items[0]).toMatchObject({ status: "not_sent", reason: "Ended before Sent? was answered" });
    // Nothing can move in an ended run.
    expect((await post(who, item(q.id, 1, "skip"))).json().error).toMatchObject({ code: "QUEUE_OVER" });
    expect((await post(who, item(q.id, 0, "sent"))).json().error).toMatchObject({ code: "QUEUE_OVER" });
    // A cap of one: the lead left open in the ended run doesn't use it up.
    await setMessaging({ dailyCap: 1 });
    try {
      const next = (await start(who, { leadIds: [c] })).json().queue;
      expect(next.today).toEqual({ sent: 0, cap: 1 });
      expect((await post(who, item(next.id, 0, "prepare"), { text: "Hi" })).statusCode).toBe(200);
      await post(who, `/api/v1/queues/${next.id}/cancel`);
    } finally {
      await setMessaging({ dailyCap: 150 });
    }
  });

  it("final review #8: the WhatsApp link (with the number) is never kept for replay", async () => {
    const [a] = await leads(1, "Noreplay");
    const q = (await start(rep, { leadIds: [a] })).json().queue;
    const r = await rep.inject({
      method: "POST",
      url: item(q.id, 0, "prepare"),
      payload: { text: "Hi" },
      headers: { "idempotency-key": "prepare-once-0001" },
    });
    expect(r.statusCode).toBe(200);
    const drawer = await rep.inject({
      method: "POST",
      url: `/api/v1/leads/${a}/messages/prepare`,
      payload: { text: "Hi" },
      headers: { "idempotency-key": "prepare-once-0002" },
    });
    expect(drawer.statusCode).toBe(200);
    const kept = await h.queryAll("SELECT key FROM idempotency_keys WHERE response::text LIKE '%7654321%'");
    expect(kept).toEqual([]);
  });

  it("is audited in words", async () => {
    const [a] = await leads(1, "Audited");
    const q = (await start(rep, { leadIds: [a] })).json().queue;
    await post(rep, `/api/v1/queues/${q.id}/pause`);
    await post(rep, `/api/v1/queues/${q.id}/resume`);
    await post(rep, `/api/v1/queues/${q.id}/cancel`);
    const rows = await h.queryAll<{ action: string; diff: Record<string, unknown> }>(
      "SELECT action, diff FROM audit_log WHERE entity_id = $1 ORDER BY id",
      [q.id],
    );
    expect(rows).toEqual([
      { action: "queue.started", diff: { source: "Your selection", leads: 1 } },
      { action: "queue.paused", diff: {} },
      { action: "queue.resumed", diff: {} },
      { action: "queue.cancelled", diff: { sent: 0 } },
    ]);
  });

  it("a template the person may no longer use mid-run: they're asked for their own words, and the run goes on", async () => {
    const [a, b] = await leads(2, "Rolechange");
    const t = await template("Gentle nudge");
    const q = (await start(rep, { leadIds: [a, b], templateId: t.id })).json().queue;
    // A role the rep doesn't hold: the template becomes someone else's.
    const other = crypto.randomUUID();
    await h.ownerPool.query("INSERT INTO roles (id, name) VALUES ($1, 'Partners only')", [other]);
    await admin.inject({
      method: "PATCH",
      url: `/api/v1/templates/${t.id}`,
      payload: { allowedRoleIds: [other] },
    });
    try {
      // Its words aren't offered either: nothing from a template the role can't use.
      const words = (await get(rep, item(q.id, 0, "text"))).json();
      expect(words).toMatchObject({ text: "", missing: [] });
      expect(words.note).toMatch(/your own words/);
      const refused = await post(rep, item(q.id, 0, "prepare"), {});
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe("TEMPLATE_NOT_YOURS");
      const own = await post(rep, item(q.id, 0, "prepare"), { text: "Hi in my own words" });
      expect(own.statusCode).toBe(200);
      expect((await get(rep, `/api/v1/queues/${q.id}`)).json().status).toBe("active");
    } finally {
      await admin.inject({
        method: "PATCH",
        url: `/api/v1/templates/${t.id}`,
        payload: { allowedRoleIds: [] },
      });
    }
  });

  it("a lead answered Not sent can be tried again in the same run", async () => {
    const [a] = await leads(1, "Retry");
    const q = (await start(rep, { leadIds: [a] })).json().queue;
    await post(rep, item(q.id, 0, "prepare"), { text: "Hi" });
    await post(rep, item(q.id, 0, "not-sent"));
    expect((await get(rep, `/api/v1/queues/${q.id}`)).json().items[0]).toMatchObject({ status: "not_sent" });
    const again = await post(rep, item(q.id, 0, "retry"));
    expect(again.statusCode).toBe(200);
    expect((await get(rep, `/api/v1/queues/${q.id}`)).json().items[0]).toMatchObject({ status: "pending" });
    expect((await post(rep, item(q.id, 0, "prepare"), { text: "Hi again" })).statusCode).toBe(200);
  });

  it("'Message these' on a view with changes not saved yet runs what's shown, and says so", async () => {
    const [x, y] = await leads(2, "Asshown");
    const tag = (
      await admin.inject({ method: "POST", url: "/api/v1/tags", payload: { label: "Asshown tag" } })
    ).json();
    const tagId = (tag.tag?.id ?? tag.id) as string;
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [x, tagId]);
    const v = (
      await post(rep, "/api/v1/views", { name: "All mine", color: "cyan", filters: { ownerId: "me" } })
    ).json();
    const shown = { ownerId: "me", tagId };
    expect((await post(rep, "/api/v1/queues/plan", { viewId: v.id, filters: shown })).json().total).toBe(1);
    const q = (await start(rep, { viewId: v.id, filters: shown })).json().queue;
    expect(q.sourceName).toBe("All mine (as shown)");
    expect(q.items.map((i: { leadId: string }) => i.leadId)).toEqual([x]);
    expect(q.items.map((i: { leadId: string }) => i.leadId)).not.toContain(y);
  });

  it("today's count has indexes behind it", async () => {
    const idx = await h.queryAll<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename IN ('send_queues', 'send_queue_items')",
    );
    const defs = idx.map((i) => i.indexdef);
    // A plain one on whose runs these are (the "one open run" index covers only open ones).
    expect(defs.some((d) => /ON public\.send_queues USING btree \(user_id\)$/.test(d))).toBe(true);
    expect(defs.join("\n")).toMatch(
      /ON public\.send_queue_items USING btree \(done_at\) WHERE \(status = 'sent'::text\)/,
    );
  });
});
