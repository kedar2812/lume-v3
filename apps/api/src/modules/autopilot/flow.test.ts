import { ALL_GRANTS, AUTOPILOT_PRESETS, newId, type AutopilotReply } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";

/**
 * One run, end to end through the API (Autopilot A2, Task 10; spec 2026-10-19 §1–§6), against the fake Meta and a
 * scripted LUME AI: started on five leads, first messages paced inside hours, a price answered, a lead converted, a stop
 * kept, a lead taken over and handed back, Pause holding a message that was already on its way, the month's allowance
 * and a top-up, and the number rated yellow. Every message LUME AI sent is on its lead's thread as LUME AI's.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let goalStage: { id: string; name: string };
let numberId: string;
const licence = testLicence({ instanceId: "LUME-TEST-FLOW", now: () => h.clock.now });
const provider = fakeProvider();
const S = 1000;
const MIN = 60 * S;
// Monday, 13:00 in Dubai: inside working hours.
const MONDAY = new Date("2026-09-21T09:00:00Z");
/** This month on the business's clock (Dubai), as the licence counts it. */
const monthNow = () => new Date(h.clock.now.getTime() + 4 * 60 * MIN).toISOString().slice(0, 7);
const plan = (o: { calls: number; topUp?: number }) => {
  licence.setPlan({
    places: null,
    modules: ALL_MODULES,
    aiReadsHourly: null,
    aiCallsMonthly: o.calls,
    ...(o.topUp ? { aiTopUps: [{ month: monthNow(), calls: o.topUp }] } : {}),
  });
};

const as = (u: U) => h.signIn(u);
const post = async (url: string, payload: unknown = {}) =>
  (await as(admin)).inject({ method: "POST", url, payload: payload as object });
const get = async (url: string) => (await (await as(admin)).inject({ method: "GET", url })).json();
const checkIn = () => post("/api/v1/licence/check");
const tick = async (ms = 0) => {
  if (ms) h.clock.advance(ms);
  await h.runAutopilot();
};
/** Written, revealed, sent: LUME AI's next message goes to Meta. */
const sendNext = async () => {
  await tick();
  await tick(10 * S);
  await h.runWhatsAppSend();
};
const reply = (o: Partial<AutopilotReply>): AutopilotReply => ({
  kind: "reply",
  message: "Happy to help.",
  reason: "Replied.",
  evidence: null,
  fileIds: [],
  stageId: null,
  fields: {},
  followUp: null,
  lostReasonId: null,
  ...o,
});
const phoneOf: Record<string, string> = {};
/** The lead writes on WhatsApp now, these words. */
const writes = async (leadId: string, text: string) => {
  const r = await deliver(
    h,
    inbound({
      from: phoneOf[leadId]!.slice(1),
      id: `wamid.${newId()}`,
      at: h.clock.now.toISOString(),
      type: "text",
      text: { body: text },
    }),
  );
  expect(r.statusCode).toBe(200);
  await h.runWhatsApp();
};
const stateOf = async (run: string, leadId: string) =>
  (
    await h.queryAll<{
      state: string;
      draft: string | null;
      card: { headline: string; quote: string | null } | null;
    }>("SELECT state, draft, card FROM autopilot_leads WHERE run_id = $1 AND lead_id = $2", [run, leadId])
  )[0]!;
const runOf = async (run: string) =>
  (
    await h.queryAll<{ status: string; pause_reason: string | null }>(
      "SELECT status, pause_reason FROM autopilot_runs WHERE id = $1",
      [run],
    )
  )[0]!;
/** What reached Meta for this lead, in order: a template's name, or a text's words. */
const sentTo = (leadId: string) =>
  meta.sent
    .filter((m) => (m.body as { to: string }).to === phoneOf[leadId]!.slice(1))
    .map((m) => {
      const b = m.body as { type: string; text?: { body: string } };
      return b.type === "text" ? b.text!.body : b.type;
    });
const lead = async (name: string, phone: string | null) => {
  const id = await h.seedLead({ ownerId: admin.id, name, ...(phone ? { phone } : {}) });
  if (phone) phoneOf[id] = phone;
  return id;
};

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    licence: licence.options,
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
  });
  h.clock.now = MONDAY;
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  const { pipelineId } = await h.config();
  goalStage = (
    await h.ownerPool.query<{ id: string; name: string }>(
      "SELECT id, name FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position DESC LIMIT 1",
      [pipelineId],
    )
  ).rows[0]!;
  plan({ calls: 1000 });
  await checkIn();
  numberId = await seedNumber(h, { runAs: admin.id });
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: true } });
  await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry. Can we help?");
  const prices = [{ id: newId(), item: "Modular kitchen", price: 380000, unit: "per kitchen", notes: "" }];
  expect(
    (
      await (
        await as(admin)
      ).inject({ method: "PATCH", url: "/api/v1/ai/profile", payload: { knows: { prices } } })
    ).statusCode,
  ).toBe(200);
});
afterAll(async () => {
  await h.close();
  await meta.close();
});

describe("a LUME AI run, end to end", () => {
  it("starts, talks, converts, stops, hands over, pauses and recovers, all through the API", async () => {
    const meera = await lead("Meera Iyer", "+919876500001");
    const rohan = await lead("Rohan Gupta", "+919876500002");
    const sneha = await lead("Sneha Reddy", "+919876500003");
    const anika = await lead("Anika Rao", "+919876500004");
    const noNumber = await lead("Kabir Shah", null);
    const isha = await lead("Isha Menon", "+919876500005");
    expect(
      (await post(`/api/v1/leads/${isha}/do-not-contact`, { reason: "Asked on a call" })).statusCode,
    ).toBe(200);
    const all = [meera, rohan, sneha, anika, noNumber, isha];
    const body = {
      leadIds: all,
      goal: { kind: "stage", stageId: goalStage.id },
      speakerId: null,
      permissions: AUTOPILOT_PRESETS.hands_off,
      followUpDays: [2, 5],
      dailyCap: null,
    };
    const skipped = [
      { leadId: noNumber, why: "No WhatsApp number" },
      { leadId: isha, why: "Asked not to be messaged" },
    ];

    // The estimate, then the run: the two who can't be messaged are skipped, with why.
    const estimate = await post("/api/v1/autopilot/estimate", body);
    expect(estimate.json()).toMatchObject({ eligible: 4, skipped, firstMessages: 4 });
    const started = await post("/api/v1/autopilot/runs", body);
    expect(started.statusCode, started.body).toBe(201);
    expect(started.json().skipped).toEqual(skipped);
    const run = started.json().run.id as string;

    // First messages: approved templates, one at a time, paced (never a burst), inside working hours.
    for (let i = 0; i < 12; i++) await tick(i ? MIN : 0);
    const firsts = await h.queryAll<{ created_at: Date }>(
      "SELECT created_at FROM whatsapp_outbox WHERE autopilot_run_id = $1 ORDER BY created_at",
      [run],
    );
    expect(firsts).toHaveLength(4);
    const gaps = firsts.slice(1).map((f, i) => f.created_at.getTime() - firsts[i]!.created_at.getTime());
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(20 * S);
    expect(firsts.at(-1)!.created_at.getTime()).toBeLessThan(MONDAY.getTime() + 6 * 60 * MIN); // before 19:00
    await h.runWhatsAppSend();
    for (const l of [meera, rohan, sneha, anika]) expect(sentTo(l)).toEqual(["template"]);
    expect(sentTo(isha)).toEqual([]);

    // Meera asks the price: LUME AI answers from the price list.
    h.clock.advance(5 * MIN);
    await writes(meera, "How much for a modular kitchen?");
    provider.script("autopilot_reply", [reply({ message: "A modular kitchen is ₹3,80,000 all in." })]);
    await sendNext();
    expect(sentTo(meera)).toEqual(["template", "A modular kitchen is ₹3,80,000 all in."]);
    expect((await stateOf(run, meera)).state).toBe("talking");

    // Rohan agrees a visit and LUME AI moves him to the goal stage: Ready for you, with his own words.
    await writes(rohan, "Saturday 4 pm works");
    provider.script("autopilot_reply", [reply({ message: "Lovely, see you then.", stageId: goalStage.id })]);
    await sendNext();
    expect(await stateOf(run, rohan)).toMatchObject({
      state: "ready",
      card: { headline: `Reached ${goalStage.name}`, quote: "Saturday 4 pm works" },
    });
    expect((await get(`/api/v1/leads/${rohan}`)).lead.stageId).toBe(goalStage.id);

    // Sneha says stop: do not contact, one apology, and nothing after, from LUME AI or anyone.
    await writes(sneha, "please stop");
    expect((await stateOf(run, sneha)).state).toBe("stopped");
    await sendNext();
    await sendNext();
    expect(sentTo(sneha)).toEqual(["template", "Sorry for the messages. You won't hear from us again."]);
    const byHand = await post(`/api/v1/leads/${sneha}/whatsapp/messages`, { clientKey: newId(), text: "Hi" });
    expect(byHand.json().error?.code).toBe("DO_NOT_CONTACT");

    // Anika writes; the person takes over while LUME AI is writing (the half-written text is theirs), then hands back.
    await writes(anika, "Do you have photos of past kitchens?");
    provider.script("autopilot_reply", [reply({ message: "Yes, I can share some from last month." })]);
    await tick();
    const draft = (await stateOf(run, anika)).draft;
    expect(draft).toBe("Yes, I can share some from last month.");
    const took = await post(`/api/v1/autopilot/runs/${run}/leads/${anika}/take-over`);
    expect(took.json()).toMatchObject({ state: "with_you", draft });
    await tick(MIN);
    await h.runWhatsAppSend();
    expect(sentTo(anika)).toEqual(["template"]);
    expect((await post(`/api/v1/autopilot/runs/${run}/leads/${anika}/hand-back`)).json().state).toBe(
      "replied",
    );
    provider.script("autopilot_reply", [reply({ message: "Here are a few from our recent work." })]);
    await sendNext();
    expect(sentTo(anika)).toEqual(["template", "Here are a few from our recent work."]);

    // Pause after a message is on its way, before the job reaches Meta: it never goes, and the thread doesn't show it.
    h.clock.advance(MIN);
    await writes(meera, "And a wardrobe?");
    provider.script("autopilot_reply", [
      reply({ message: "A wardrobe depends on the size. Can I call you?" }),
    ]);
    await tick();
    await tick(10 * S);
    const onItsWay = await h.queryAll<{ id: string; status: string }>(
      "SELECT id, status FROM whatsapp_outbox WHERE lead_id = $1 AND status = 'queued'",
      [meera],
    );
    expect(onItsWay).toHaveLength(1);
    expect((await post(`/api/v1/autopilot/runs/${run}/pause`)).statusCode).toBe(200);
    await h.runWhatsAppSend();
    expect(sentTo(meera)).toHaveLength(2);
    expect(
      (
        await h.queryAll<{ status: string }>("SELECT status FROM whatsapp_outbox WHERE id = $1", [
          onItsWay[0]!.id,
        ])
      )[0]!.status,
    ).toBe("cancelled");
    const meeraThread = await get(`/api/v1/leads/${meera}/whatsapp`);
    expect(meeraThread.messages.map((m: { text: string | null }) => m.text)).not.toContain(
      "A wardrobe depends on the size. Can I call you?",
    );
    // It never went, so after Resume her question is answered all the same.
    expect((await stateOf(run, meera)).state).toBe("replied");
    expect((await post(`/api/v1/autopilot/runs/${run}/resume`)).statusCode).toBe(200);
    provider.script("autopilot_reply", [
      reply({ message: "A wardrobe depends on the size. Can I call you?" }),
    ]);
    await sendNext();
    expect(sentTo(meera).at(-1)).toBe("A wardrobe depends on the size. Can I call you?");

    // The month's allowance runs out: the run pauses by itself, and a top-up resumes it by itself.
    const used = (await h.queryAll<{ n: number }>("SELECT count(*)::int AS n FROM ai_reads"))[0]!.n;
    plan({ calls: used });
    await checkIn();
    h.clock.advance(MIN);
    await writes(anika, "Can someone visit on Sunday?");
    await tick();
    expect(await runOf(run)).toEqual({ status: "paused", pause_reason: "month" });
    await h.runWhatsAppSend();
    expect(sentTo(anika)).toHaveLength(2);
    plan({ calls: used, topUp: 20 });
    await checkIn();
    provider.script("autopilot_reply", [reply({ message: "Let me check Sunday and come back to you." })]);
    await tick(MIN);
    expect((await runOf(run)).status).toBe("running");
    await sendNext();
    expect(sentTo(anika).at(-1)).toBe("Let me check Sunday and come back to you.");

    // Meta rates the number yellow: every run on it pauses, and admins are told why.
    const number = (
      await h.ownerPool.query<{ waba_id: string; display_phone: string }>(
        "SELECT waba_id, display_phone FROM whatsapp_numbers WHERE id = $1",
        [numberId],
      )
    ).rows[0]!;
    const flagged = await deliver(h, {
      object: "whatsapp_business_account",
      entry: [
        {
          id: number.waba_id,
          time: 1,
          changes: [
            {
              field: "phone_number_quality_update",
              value: {
                display_phone_number: number.display_phone,
                event: "FLAGGED",
                current_limit: "TIER_250",
              },
            },
          ],
        },
      ],
    });
    expect(flagged.statusCode).toBe(200);
    expect(await runOf(run)).toEqual({ status: "paused", pause_reason: "quality" });
    const bell = (await get("/api/v1/notifications")).items.map((n: { title: string }) => n.title);
    expect(bell).toContain(`WhatsApp rated ${number.display_phone} yellow`);
    const before = meta.sent.length;
    await writes(meera, "Hello?");
    await sendNext();
    expect(meta.sent).toHaveLength(before);

    // Every message LUME AI sent is on its lead's thread as LUME AI's, in this run, for the speaker.
    for (const l of [meera, rohan, sneha, anika]) {
      const out = (await get(`/api/v1/leads/${l}/whatsapp`)).messages.filter(
        (m: { direction: string }) => m.direction === "out",
      );
      expect(out.length).toBe(sentTo(l).length);
      for (const m of out) expect(m).toMatchObject({ sentBy: { id: admin.id }, lumeAi: { runId: run } });
    }
  }, 60_000);
});
