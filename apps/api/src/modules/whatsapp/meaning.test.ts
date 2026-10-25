import { randomUUID } from "node:crypto";
import { ALL_GRANTS, AUTOPILOT_PRESETS } from "@lume/core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";

/**
 * What a WhatsApp reply means (W2, spec 2026-10-18 §4.2, §5.1, §5.4): each live reply on a lead is read once by LUME AI
 * (on, with allowance), kept with the reply on the thread with its suggestion; a stop LUME AI hears marks the lead do not
 * contact like one LUME's own list catches; never read when AI is off, for a lead LUME AI is already talking to, or for a
 * reply with no words.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
const SNEHA = "+919876543210";
const licence = testLicence({ instanceId: "LUME-TEST-MEANING", now: () => h.clock.now });
const provider = fakeProvider();

const as = (u: U) => h.signIn(u);
const aiOn = async (enabled: boolean) =>
  (await as(admin)).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled } });
const writes = async (m: Record<string, unknown>) => {
  const body = inbound({
    from: SNEHA.slice(1),
    id: `wamid.${randomUUID()}`,
    at: h.clock.now.toISOString(),
    ...m,
  });
  expect((await deliver(h, body)).statusCode).toBe(200);
  await h.runWhatsApp();
};
const says = (text: string) => writes({ type: "text", text: { body: text } });
const reads = (lead: string) =>
  h.queryAll<{
    id: string;
    status: string;
    result: Record<string, unknown> | null;
    source_activity_id: string;
  }>(
    "SELECT id, status, result, source_activity_id FROM ai_reads WHERE lead_id = $1 AND task = 'reply_meaning' ORDER BY created_at",
    [lead],
  );
const thread = async (lead: string) =>
  (await (await as(admin)).inject({ method: "GET", url: `/api/v1/leads/${lead}/whatsapp` })).json() as {
    messages: { id: string; direction: string; meaning: unknown }[];
  };
const lead = () => h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: SNEHA });

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    licence: licence.options,
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
  });
  await h.ownerPool.query("UPDATE settings SET timezone = 'Asia/Kolkata' WHERE id = 1");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await (await as(admin)).inject({ method: "POST", url: "/api/v1/licence/check" });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
  h.whatsappQueued.length = 0;
  h.whatsappMeaningQueued.length = 0;
  await seedNumber(h, { runAs: admin.id });
  await aiOn(true);
});

describe("what a reply means", () => {
  it("each reply on a lead is read once: its group, its line and a suggestion, kept with the reply on the thread", async () => {
    const id = await lead();
    await says("How much does a modular kitchen cost?");
    expect(h.whatsappMeaningQueued).toHaveLength(1);
    await h.runWhatsAppMeaning();
    const [r] = await reads(id);
    expect(r).toMatchObject({ status: "ok", result: { meaning: "price", stop: false } });
    // Only a stop marks the lead: a question about the price leaves it free to be messaged.
    const [free] = await h.queryAll<{ dnc_at: Date | null }>("SELECT dnc_at FROM leads WHERE id = $1", [id]);
    expect(free!.dnc_at).toBeNull();
    // The same reply again (a retried job): no second read.
    h.whatsappMeaningQueued.push(r!.source_activity_id);
    await h.runWhatsAppMeaning();
    expect(await reads(id)).toHaveLength(1);

    const t = await thread(id);
    const mine = t.messages.find((m) => m.id === r!.source_activity_id)!;
    expect(mine.meaning).toMatchObject({
      readId: r!.id,
      group: "price",
      summary: "How much does a modular kitchen cost?",
      outcome: null,
    });
  });

  it("a stop only LUME AI hears marks the lead do not contact, and its owner hears", async () => {
    const id = await lead();
    provider.script("reply_meaning", [
      {
        meaning: "stop",
        summary: "Asks not to be written to again.",
        stop: true,
        stageId: null,
        followUp: null,
        lostReasonId: null,
      },
    ]);
    await says("Aage se mujhe likhna mat, shukriya");
    const [l0] = await h.queryAll<{ dnc_at: Date | null }>("SELECT dnc_at FROM leads WHERE id = $1", [id]);
    expect(l0!.dnc_at).toBeNull();
    await h.runWhatsAppMeaning();
    const [l] = await h.queryAll<{ dnc_reason: string | null; dnc_by: string | null }>(
      "SELECT dnc_reason, dnc_by FROM leads WHERE id = $1",
      [id],
    );
    expect(l).toEqual({ dnc_reason: "Said stop on WhatsApp", dnc_by: null });
    const reader = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
    await reader.connect();
    const told = (
      await reader.query("SELECT title FROM notifications WHERE kind = 'lead_stopped' AND lead_id = $1", [id])
    ).rows;
    await reader.end();
    expect(told).toEqual([{ title: "Sneha asked not to be messaged" }]);
  });

  it("not read: LUME AI off; a reply with no words; a stop LUME's list already caught; a lead LUME AI is talking to", async () => {
    const id = await lead();
    await aiOn(false);
    await says("Sounds good");
    await aiOn(true);
    await writes({ type: "image", image: { id: "media-1", mime_type: "image/jpeg", sha256: "abc" } });
    await says("please stop");
    expect(h.whatsappMeaningQueued).toEqual([]);

    // In an Autopilot run: its own read answers the lead, so no second one.
    // Lifted (as a person would), so the lead can join a run.
    await h.queryAll("UPDATE leads SET dnc_at = NULL, dnc_by = NULL, dnc_reason = NULL WHERE id = $1", [id]);
    await (
      await as(admin)
    ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: true } });
    await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry. Can we help?");
    const { pipelineId } = await h.config();
    const [goal] = await h.queryAll<{ id: string }>(
      "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position DESC LIMIT 1",
      [pipelineId],
    );
    const started = await (
      await as(admin)
    ).inject({
      method: "POST",
      url: "/api/v1/autopilot/runs",
      payload: {
        leadIds: [id],
        goal: { kind: "stage", stageId: goal!.id },
        speakerId: null,
        permissions: AUTOPILOT_PRESETS.hands_off,
        followUpDays: [2],
        dailyCap: null,
      },
    });
    expect(started.statusCode, started.body).toBe(201);
    await says("Is Saturday possible?");
    expect(h.whatsappMeaningQueued).toEqual([]);
  });

  it("a reply queued just before LUME AI started talking to the lead isn't read twice: the run answers it", async () => {
    const id = await lead();
    await says("What are your timings?");
    expect(h.whatsappMeaningQueued).toHaveLength(1);
    // The lead joins a run before the read's turn comes.
    await h.queryAll(
      `INSERT INTO autopilot_runs (id, name, started_by, speaker_id, goal, permissions, follow_up_days, outside_hours, status, number_id)
       SELECT gen_random_uuid(), 'Test', $1, $1, '{"kind":"reply"}'::jsonb, '{}'::jsonb, '{2}', 'wait', 'running', n.id
         FROM whatsapp_numbers n LIMIT 1`,
      [admin.id],
    );
    await h.queryAll(
      "INSERT INTO autopilot_leads (run_id, lead_id, state) SELECT id, $1, 'replied' FROM autopilot_runs ORDER BY created_at DESC LIMIT 1",
      [id],
    );
    await h.runWhatsAppMeaning();
    expect(await reads(id)).toEqual([]);
  });

  it("Apply does what it suggests, as the person, once", async () => {
    const id = await lead();
    provider.script("reply_meaning", [
      {
        meaning: "visit_or_call",
        summary: "Wants a call on Saturday at 11.",
        stop: false,
        stageId: null,
        followUp: { at: "2099-01-03T11:00", title: "Call Sneha" },
        lostReasonId: null,
      },
    ]);
    await says("Call me Saturday 11");
    await h.runWhatsAppMeaning();
    const [r] = await reads(id);
    const apply = () =>
      as(admin).then((c) =>
        c.inject({
          method: "POST",
          url: `/api/v1/ai/reads/${r!.id}/apply`,
          payload: { stage: true, followUp: true, tags: true },
        }),
      );
    const first = await apply();
    expect(first.statusCode, first.body).toBe(200);
    const tasks = await h.queryAll<{ title: string }>("SELECT title FROM tasks WHERE lead_id = $1", [id]);
    expect(tasks.map((t) => t.title)).toContain("Call Sneha");
    expect((await apply()).statusCode).toBe(409);
    const shown = (await thread(id)).messages.find((m) => m.id === r!.source_activity_id)!;
    expect(shown.meaning).toMatchObject({ outcome: "applied" });
  });
});
