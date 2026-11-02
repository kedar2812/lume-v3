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
/** Something that happens while LUME AI is reading (once): a person or the lead acting in those seconds. */
let duringRead: (() => Promise<unknown>) | null = null;
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
  fields: [],
  followUp: null,
  lostReasonId: null,
  meeting: null,
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
    ai: {
      read: async (o) => {
        const f = duringRead;
        duringRead = null;
        if (f) await f();
        return provider.read(o);
      },
      name: "fake",
      model: "fake-1",
    },
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

describe("what LUME AI wrote while things changed under it (review 2026-10-26 A1)", () => {
  const startOn = async (leadIds: string[]) => {
    const r = await post("/api/v1/autopilot/runs", {
      leadIds,
      goal: { kind: "stage", stageId: goalStage.id },
      speakerId: null,
      permissions: AUTOPILOT_PRESETS.hands_off,
      followUpDays: [2, 5],
      dailyCap: null,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().run.id as string;
  };
  /** A lead in a fresh run, its first message sent, inside working hours. */
  const inRun = async (name: string, phone: string) => {
    const id = await lead(name, phone);
    const run = await startOn([id]);
    await sendNext();
    expect(sentTo(id)).toEqual(["template"]);
    return { id, run };
  };

  beforeAll(async () => {
    // The end-to-end run left the number rated yellow and the month spent: a healthy number, a fresh week.
    await h.ownerPool.query("UPDATE whatsapp_numbers SET quality = 'green'");
    const DAY = 24 * 60 * MIN;
    let t = MONDAY.getTime();
    while (t <= h.clock.now.getTime()) t += 7 * DAY;
    h.clock.now = new Date(t);
    plan({ calls: 100_000 });
    expect((await checkIn()).statusCode).toBe(200);
  });

  it("a person takes over while LUME AI is writing its reply: the reply is dropped and the lead stays theirs", async () => {
    const { id, run } = await inRun("Tara Nair", "+919876500011");
    await writes(id, "Do you do bathrooms too?");
    provider.script("autopilot_reply", [reply({ message: "Yes, bathrooms too." })]);
    duringRead = async () =>
      expect((await post(`/api/v1/autopilot/runs/${run}/leads/${id}/take-over`)).statusCode).toBe(200);
    await sendNext();
    await sendNext();
    expect(sentTo(id)).toEqual(["template"]);
    expect(await stateOf(run, id)).toMatchObject({ state: "with_you", draft: null });
  });

  it("a lead who wrote before the run is answered in the conversation, not opened with a template (2026-11-01)", async () => {
    // Live test: a new run sent "thanks for your interest" to someone who had just written "this is a scam".
    const id = await lead("Kiran Bose", "+919876500013");
    await writes(id, "Is this the kitchen people? What do you charge?");
    h.clock.advance(60 * MIN);
    provider.script("autopilot_reply", [
      reply({ message: "Yes, we design kitchens. A modular one is ₹3,80,000." }),
    ]);
    const run = await startOn([id]);
    await sendNext();
    expect(sentTo(id)).toEqual(["Yes, we design kitchens. A modular one is ₹3,80,000."]);
    expect((await stateOf(run, id)).state).toBe("talking");
  });

  it("a lead whose message is past the 24 hours gets the approved template, as WhatsApp requires", async () => {
    const id = await lead("Neel Joshi", "+919876500014");
    await writes(id, "Hello?");
    h.clock.advance(25 * 60 * MIN);
    const run = await startOn([id]);
    await sendNext();
    expect(sentTo(id)).toEqual(["template"]);
    expect((await stateOf(run, id)).state).toBe("sent");
  });

  it("working hours changed to include now: a lead held for the morning goes now, not at the old opening (live test 2026-11-01)", async () => {
    const patch = async (workingHours: unknown) =>
      (await as(admin)).inject({ method: "PATCH", url: "/api/v1/settings", payload: { workingHours } });
    const before = (await get("/api/v1/settings")).workingHours;
    // Monday, before the business opens (only 18:00 to 20:00): the first message waits for the evening.
    expect((await patch({ days: [1, 2, 3, 4, 5], start: "18:00", end: "20:00" })).statusCode).toBe(200);
    const id = await lead("Ira Menon", "+919876500015");
    await startOn([id]);
    await sendNext();
    expect(sentTo(id)).toEqual([]);
    // Open all day from now: the lead isn't left waiting for an opening that no longer applies.
    expect((await patch({ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" })).statusCode).toBe(200);
    for (let i = 0; i < 20 && !sentTo(id).length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      await sendNext();
    }
    expect(sentTo(id)).toEqual(["template"]);
    await patch(before);
  });

  it("the lead writes again while LUME AI is writing: the old reply is dropped and the new message answered", async () => {
    const { id, run } = await inRun("Dev Malhotra", "+919876500012");
    await writes(id, "Do you do bathrooms too?");
    provider.script("autopilot_reply", [
      reply({ message: "Yes, bathrooms too." }),
      reply({ message: "A modular kitchen is ₹3,80,000 all in." }),
    ]);
    duringRead = () => writes(id, "Actually, how much is a kitchen?");
    await sendNext();
    await sendNext();
    expect(sentTo(id)).toEqual(["template", "A modular kitchen is ₹3,80,000 all in."]);
    expect((await stateOf(run, id)).state).toBe("talking");
  });
});

/** Calls LUME AI may say yes to (spec 2026-11-02 LUME AI books calls), on the business's clock (Dubai). */
describe("a call LUME AI says yes to", () => {
  const DAY = 24 * 60 * MIN;
  const how = "We'll call you on this number.";
  const calls = {
    windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "16:00", to: "19:00" }],
    minutes: 30,
    noticeHours: 2,
    daysAhead: 14,
    how,
  };
  const setCalls = async (c: unknown) =>
    (await as(admin)).inject({
      method: "PATCH",
      url: "/api/v1/ai/profile",
      payload: { standing: { calls: c } },
    });
  /** Tomorrow on the business's clock (Dubai, UTC+4), as "YYYY-MM-DD". */
  const tomorrow = () => new Date(h.clock.now.getTime() + 4 * 60 * MIN + DAY).toISOString().slice(0, 10);
  /** That day's 17:00 in Dubai, as the instant it is. */
  const fivePm = (day: string) => new Date(`${day}T13:00:00Z`);
  const meetingsOf = (leadId: string) =>
    h.queryAll<{
      source: string;
      matched_by: string;
      owner_id: string;
      starts_at: Date;
      ends_at: Date;
      location: string | null;
      status: string;
      title: string;
    }>(
      "SELECT source, matched_by, owner_id, starts_at, ends_at, location, status, title FROM meetings WHERE lead_id = $1",
      [leadId],
    );
  const startWith = async (leadIds: string[], permissions = AUTOPILOT_PRESETS.hands_off) => {
    const r = await post("/api/v1/autopilot/runs", {
      leadIds,
      goal: { kind: "stage", stageId: goalStage.id },
      speakerId: null,
      permissions,
      followUpDays: [2, 5],
      dailyCap: null,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().run.id as string;
  };
  const inRun = async (name: string, phone: string, permissions = AUTOPILOT_PRESETS.hands_off) => {
    const id = await lead(name, phone);
    const run = await startWith([id], permissions);
    await sendNext();
    expect(sentTo(id)).toEqual(["template"]);
    return { id, run };
  };
  /** A meeting already on the speaker's calendar, as LUME's Google sync writes one: as its owner. */
  const busyAt = async (startsAt: Date, minutes = 60) => {
    const c = await h.ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)",
        [admin.id],
      );
      const id = newId();
      await c.query(
        `INSERT INTO meetings (id, owner_id, source, external_id, matched_by, title, starts_at, ends_at)
         VALUES ($1, $2, 'google', $5, 'title', 'Site visit', $3, $4)`,
        [id, admin.id, startsAt, new Date(startsAt.getTime() + minutes * MIN), id],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    await h.ownerPool.query("UPDATE whatsapp_numbers SET quality = 'green'");
    let t = MONDAY.getTime();
    while (t <= h.clock.now.getTime()) t += 7 * DAY;
    h.clock.now = new Date(t);
    plan({ calls: 100_000 });
    expect((await checkIn()).statusCode).toBe(200);
  });

  it("no times given: Book meetings can't be chosen, and says where to give them", async () => {
    expect((await setCalls({ ...calls, windows: [] })).statusCode).toBe(200);
    expect((await get("/api/v1/ai/profile")).available.book_meetings).toEqual({
      ok: false,
      why: "Give LUME AI the times it may say yes to a call in Settings → LUME AI.",
      fixHref: "/settings/ai",
    });
    expect((await setCalls(calls)).statusCode).toBe(200);
    expect((await get("/api/v1/ai/profile")).available.book_meetings).toEqual({ ok: true });
  });

  it("a free time the lead proposes: LUME AI says yes, the call is booked as the reply goes, and the lead is Ready", async () => {
    const { id, run } = await inRun("Zara Khan", "+919876500021");
    await writes(id, "Can we talk tomorrow at 5 pm?");
    const day = tomorrow();
    provider.script("autopilot_reply", [
      reply({ message: `Done, tomorrow at 5 pm. ${how}`, meeting: { at: `${day}T17:00` } }),
    ]);
    await sendNext();
    expect(sentTo(id)).toEqual(["template", `Done, tomorrow at 5 pm. ${how}`]);
    expect(await meetingsOf(id)).toEqual([
      {
        source: "lume",
        matched_by: "lume_ai",
        owner_id: admin.id,
        starts_at: fivePm(day),
        ends_at: new Date(fivePm(day).getTime() + 30 * MIN),
        location: how,
        status: "scheduled",
        title: "Call with Zara Khan",
      },
    ]);
    const state = await stateOf(run, id);
    expect(state.state).toBe("ready");
    expect(state.card?.headline).toMatch(/^Call booked for .+ at 5 pm$/);
    // On the lead's Meetings and in the Calendar, and in its history.
    expect((await get(`/api/v1/leads/${id}/meetings`)).meetings).toEqual([
      expect.objectContaining({ title: "Call with Zara Khan", matchedBy: "lume_ai" }),
    ]);
    const from = new Date(h.clock.now.getTime() - DAY).toISOString();
    const to = new Date(h.clock.now.getTime() + 3 * DAY).toISOString();
    expect((await get(`/api/v1/meetings?from=${from}&to=${to}`)).meetings).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Call with Zara Khan" })]),
    );
    const acts = await h.queryAll<{ payload: { byAi?: boolean } }>(
      "SELECT payload FROM activities WHERE lead_id = $1 AND type = 'meeting_booked'",
      [id],
    );
    expect(acts).toEqual([
      { payload: expect.objectContaining({ byAi: true, startsAt: fivePm(day).toISOString() }) },
    ]);
  });

  it("a time already taken is never said yes to: a person gets the lead, with why, and nothing is sent", async () => {
    const { id, run } = await inRun("Omar Siddiqui", "+919876500022");
    const day = tomorrow();
    await busyAt(new Date(`${day}T14:00:00Z`)); // 18:00 to 19:00 in Dubai
    await writes(id, "Tomorrow 6 pm?");
    provider.script("autopilot_reply", [
      reply({ message: "Done, tomorrow at 6 pm.", meeting: { at: `${day}T18:00` } }),
    ]);
    await sendNext();
    expect(sentTo(id)).toEqual(["template"]);
    expect(await meetingsOf(id)).toEqual([]);
    expect(await stateOf(run, id)).toMatchObject({
      state: "needs_you",
      card: { headline: "LUME AI wanted to say yes to a call at a time you already have a meeting." },
    });
  });

  it("two leads say yes to the same time: one is booked; the other gets nothing sent and goes to a person", async () => {
    const a = await inRun("Lina Haddad", "+919876500023");
    const b = await inRun("Yusuf Ali", "+919876500024");
    const day = tomorrow();
    await writes(a.id, "Tomorrow 4 pm works");
    await writes(b.id, "Tomorrow 4 pm please");
    provider.script("autopilot_reply", [
      reply({ message: "Done, tomorrow at 4 pm.", meeting: { at: `${day}T16:00` } }),
      reply({ message: "Done, tomorrow at 4 pm.", meeting: { at: `${day}T16:00` } }),
    ]);
    // Both written before either is sent: the second finds the time taken as it books.
    await tick();
    await tick();
    expect((await stateOf(a.run, a.id)).draft).toBe("Done, tomorrow at 4 pm.");
    expect((await stateOf(b.run, b.id)).draft).toBe("Done, tomorrow at 4 pm.");
    await tick(10 * S);
    await tick();
    await h.runWhatsAppSend();
    const sent = [sentTo(a.id), sentTo(b.id)].map((x) => x.length);
    expect(sent.sort()).toEqual([1, 2]);
    const booked = [...(await meetingsOf(a.id)), ...(await meetingsOf(b.id))];
    expect(booked).toHaveLength(1);
    const loser = sentTo(a.id).length === 1 ? a : b;
    expect(await stateOf(loser.run, loser.id)).toMatchObject({
      state: "needs_you",
      card: { headline: "LUME AI wanted to say yes to a call at a time you already have a meeting." },
    });
  });

  it("set to Ask me: the yes waits for a tap and holds nothing; approved, it's booked as it goes", async () => {
    const ask = { ...AUTOPILOT_PRESETS.hands_off, book_meetings: "ask" as const };
    const { id, run } = await inRun("Noor Aziz", "+919876500025", ask);
    const day = tomorrow();
    await writes(id, "Tomorrow 5:30 pm?");
    provider.script("autopilot_reply", [
      reply({ message: "Done, tomorrow at 5:30 pm.", meeting: { at: `${day}T17:30` } }),
    ]);
    await tick();
    expect((await stateOf(run, id)).state).toBe("needs_you");
    expect(await meetingsOf(id)).toEqual([]);
    const asks = (await get(`/api/v1/autopilot/runs/${run}`)).asks;
    expect(asks).toEqual([expect.objectContaining({ leadId: id, action: "book_meetings" })]);
    expect((await post(`/api/v1/autopilot/asks/${asks[0].id}/approve`)).statusCode).toBe(200);
    await tick();
    await h.runWhatsAppSend();
    expect(sentTo(id)).toEqual(["template", "Done, tomorrow at 5:30 pm."]);
    expect(await meetingsOf(id)).toEqual([
      expect.objectContaining({ starts_at: new Date(`${day}T13:30:00Z`) }),
    ]);
  });

  it("approved after the time was taken: nothing is sent, and a person gets the lead", async () => {
    const ask = { ...AUTOPILOT_PRESETS.hands_off, book_meetings: "ask" as const };
    const { id, run } = await inRun("Rami Saleh", "+919876500026", ask);
    const day = tomorrow();
    await writes(id, "Tomorrow 4:30 pm?");
    provider.script("autopilot_reply", [
      reply({ message: "Done, tomorrow at 4:30 pm.", meeting: { at: `${day}T16:30` } }),
    ]);
    await tick();
    const asks = (await get(`/api/v1/autopilot/runs/${run}`)).asks;
    await busyAt(new Date(`${day}T12:30:00Z`), 30); // someone books 16:30 while it waits
    expect((await post(`/api/v1/autopilot/asks/${asks[0].id}/approve`)).statusCode).toBe(200);
    await tick();
    await h.runWhatsAppSend();
    expect(sentTo(id)).toEqual(["template"]);
    expect(await meetingsOf(id)).toEqual([]);
    expect((await stateOf(run, id)).state).toBe("needs_you");
  });

  it("the times it may offer are in what LUME AI reads, never one that's taken", async () => {
    const { id } = await inRun("Huda Karim", "+919876500027");
    await writes(id, "When can we talk?");
    provider.script("autopilot_reply", [reply({ message: "Happy to talk." })]);
    await sendNext();
    const input = JSON.parse(provider.calls.at(-1)!.input) as { callTimes?: { at: string; label: string }[] };
    const offered = (input.callTimes ?? []).map((c) => c.at);
    expect(offered.length).toBeGreaterThan(1);
    expect(offered.length).toBeLessThanOrEqual(6);
    // Tomorrow is full (Lina 16:00, a meeting 16:30, Zara 17:00, Noor 17:30, a visit 18:00 to 19:00): none offered.
    expect(offered.filter((at) => at.startsWith(tomorrow()))).toEqual([]);
    const dayAfter = new Date(new Date(`${tomorrow()}T12:00:00Z`).getTime() + DAY).toISOString().slice(0, 10);
    expect(offered).toContain(`${dayAfter}T16:00`);
  });
});
