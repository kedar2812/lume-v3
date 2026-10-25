import { ALL_GRANTS, AUTOPILOT_PRESETS, newId, type AutopilotReply } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { approvedTemplate, deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";
import type { AiRead } from "../../ai/provider";

/**
 * What a LUME AI reply may change on the lead (Autopilot spec 2026-10-19 §1.3: move along the pipeline, mark lost, fill
 * in details): the read names the lead's own stages, the business's lost reasons and the empty fields it may fill, by
 * id and key; a sent reply fills those fields in each field's own type and never overwrites what's there.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let stages: { id: string; name: string; kind: string }[];
let otherPipelineStages: string[];
let reasons: { id: string; label: string }[];
let villa: string;
const licence = testLicence({ instanceId: "LUME-TEST-UPDATES", now: () => h.clock.now });
const provider = fakeProvider();
const reads: { instructions: string; input: string }[] = [];
const S = 1000;
const MONDAY = new Date("2026-09-21T09:00:00Z");

const as = (u: U) => h.signIn(u);
const post = async (url: string, payload: unknown = {}) =>
  (await as(admin)).inject({ method: "POST", url, payload: payload as object });
const get = async (url: string) => (await (await as(admin)).inject({ method: "GET", url })).json();
const tick = async (ms = 0) => {
  if (ms) h.clock.advance(ms);
  await h.runAutopilot();
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
const field = async (payload: object) =>
  (await (await as(admin)).inject({ method: "POST", url: "/api/v1/fields", payload })).json().field as {
    id: string;
    options: { id: string; label: string }[];
  };
/** A lead in a run whose first message has gone: the next thing LUME AI writes is a reply. */
async function leadInRun(name: string, phone: string) {
  const id = await h.seedLead({ ownerId: admin.id, name, phone });
  phoneOf[id] = phone;
  const started = await post("/api/v1/autopilot/runs", {
    leadIds: [id],
    // A stage goal: a reply from the lead is a conversation, not the goal (a "get a reply" goal ends there).
    goal: { kind: "stage", stageId: stages.filter((x) => x.kind === "open").at(-1)!.id },
    speakerId: null,
    permissions: AUTOPILOT_PRESETS.hands_off,
    followUpDays: [2],
    dailyCap: null,
  });
  expect(started.statusCode, started.body).toBe(201);
  await tick();
  await tick(10 * S);
  await h.runWhatsAppSend();
  return { id, run: started.json().run.id as string };
}

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    licence: licence.options,
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
    ai: {
      read: <T>(o: AiRead<T>) => {
        reads.push({ instructions: o.instructions, input: o.input });
        return provider.read(o);
      },
      name: "fake",
      model: "fake-1",
    },
  });
  h.clock.now = MONDAY;
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await post("/api/v1/licence/check");
  await seedNumber(h, { runAs: admin.id });
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/whatsapp", payload: { replyFromLume: true } });
  await approvedTemplate(h, meta, admin, "Hi {{lead.first_name}}, thanks for your enquiry. Can we help?");

  const { pipelineId } = await h.config();
  stages = (
    await h.ownerPool.query<{ id: string; name: string; kind: string }>(
      "SELECT id, name, kind FROM stages WHERE pipeline_id = $1 AND archived_at IS NULL ORDER BY position",
      [pipelineId],
    )
  ).rows;
  const other = (await post("/api/v1/pipelines", { name: "Corporate" })).json().pipeline as {
    stages: { id: string }[];
  };
  otherPipelineStages = other.stages.map((x) => x.id);
  reasons = (
    await h.ownerPool.query<{ id: string; label: string }>(
      "SELECT id, label FROM lost_reasons WHERE archived_at IS NULL ORDER BY position",
    )
  ).rows;
  // One reason archived: never offered.
  await h.ownerPool.query("UPDATE lost_reasons SET archived_at = now() WHERE id = $1", [reasons.at(-1)!.id]);
  const type = await field({
    key: "property_type",
    label: "Property type",
    type: "select",
    options: [{ label: "Apartment" }, { label: "Villa" }],
  });
  villa = type.options.find((o) => o.label === "Villa")!.id;
  await field({ key: "budget", label: "Budget", type: "currency" });
  await field({ key: "visit_notes", label: "Visit notes", type: "text" });
  await field({ key: "site_contact", label: "Site contact", type: "phone" });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});

describe("what a LUME AI reply may change", () => {
  it("the read names the lead's own open and lost stages, live lost reasons and the empty fields it may fill", async () => {
    const { id } = await leadInRun("Meera Iyer", "+919876511001");
    const lead = (await get(`/api/v1/leads/${id}`)).lead as { version: number };
    await (
      await as(admin)
    ).inject({
      method: "PATCH",
      url: `/api/v1/leads/${id}`,
      headers: { "if-match": String(lead.version) },
      payload: { custom: { visit_notes: "Prefers evenings" } },
    });
    reads.length = 0;
    await writes(id, "Hi, we're looking at a villa");
    provider.script("autopilot_reply", [reply({})]);
    await tick();
    const read = reads.find((r) => JSON.parse(r.input).task === "autopilot_reply")!;
    expect(read, "a reply was read").toBeDefined();
    const input = JSON.parse(read.input);
    expect(input.stages).toEqual(
      stages.filter((x) => x.kind !== "won").map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
    );
    for (const s of otherPipelineStages) expect(JSON.stringify(input.stages)).not.toContain(s);
    expect(input.lostReasons).toEqual(reasons.slice(0, -1));
    // Empty fields only, never a contact; a choice by its options' labels.
    const mine = (input.fillable as { key: string }[]).filter((f) =>
      ["property_type", "budget", "visit_notes", "site_contact"].includes(f.key),
    );
    expect(mine).toEqual([
      { key: "property_type", label: "Property type", type: "select", options: ["Apartment", "Villa"] },
      { key: "budget", label: "Budget", type: "currency", options: [] },
    ]);
    expect(input.lead.fields).toEqual([{ label: "Visit notes", value: "Prefers evenings" }]);
  });

  it("a sent reply fills empty fields in their own type; never one already filled, a key it wasn't given or a contact", async () => {
    const { id } = await leadInRun("Rohan Gupta", "+919876511002");
    const lead = (await get(`/api/v1/leads/${id}`)).lead as { version: number };
    await (
      await as(admin)
    ).inject({
      method: "PATCH",
      url: `/api/v1/leads/${id}`,
      headers: { "if-match": String(lead.version) },
      payload: { custom: { visit_notes: "Prefers evenings" } },
    });
    await writes(id, "A villa, budget about 15,00,000");
    provider.script("autopilot_reply", [
      reply({
        message: "Lovely, a villa it is.",
        fields: {
          property_type: "villa",
          budget: "15,00,000",
          visit_notes: "Overwritten",
          site_contact: "+919800000000",
          no_such_field: "x",
        },
      }),
    ]);
    await tick();
    await tick(10 * S);
    await h.runWhatsAppSend();
    const after = (await get(`/api/v1/leads/${id}`)).lead as { custom: Record<string, unknown> };
    expect(after.custom).toMatchObject({
      property_type: villa,
      budget: 1500000,
      visit_notes: "Prefers evenings",
    });
    expect(after.custom.site_contact).toBeUndefined();
    expect(after.custom.no_such_field).toBeUndefined();
  });

  it("speaking as someone who may only view a field: it isn't offered, and a reply never writes it", async () => {
    const speaker = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "all" },
        { key: "leads.edit", scope: "all" },
        { key: "messages.send", scope: "all" },
      ],
      totp: false,
    });
    const [role] = (
      await h.ownerPool.query<{ role_id: string }>("SELECT role_id FROM user_roles WHERE user_id = $1", [
        speaker.id,
      ])
    ).rows;
    const [budget] = (
      await h.ownerPool.query<{ id: string }>("SELECT id FROM field_definitions WHERE key = 'budget'")
    ).rows;
    await h.ownerPool.query(
      "INSERT INTO role_field_access (role_id, field_id, access) VALUES ($1, $2, 'view')",
      [role!.role_id, budget!.id],
    );
    await h.ownerPool.query("SELECT pg_notify('lume_rbac', '')");
    await h.waitForRbacNotify();
    const id = await h.seedLead({ ownerId: admin.id, name: "Kabir Shah", phone: "+919876511004" });
    phoneOf[id] = "+919876511004";
    const started = await post("/api/v1/autopilot/runs", {
      leadIds: [id],
      goal: { kind: "stage", stageId: stages.filter((x) => x.kind === "open").at(-1)!.id },
      speakerId: speaker.id,
      permissions: AUTOPILOT_PRESETS.hands_off,
      followUpDays: [2],
      dailyCap: null,
    });
    expect(started.statusCode, started.body).toBe(201);
    await tick();
    await tick(10 * S);
    await h.runWhatsAppSend();
    reads.length = 0;
    await writes(id, "A villa, budget 9,00,000");
    provider.script("autopilot_reply", [
      reply({ message: "Noted, thank you.", fields: { property_type: "Villa", budget: "9,00,000" } }),
    ]);
    await tick();
    const input = JSON.parse(reads.find((r) => JSON.parse(r.input).task === "autopilot_reply")!.input);
    expect((input.fillable as { key: string }[]).map((f) => f.key)).toContain("property_type");
    expect((input.fillable as { key: string }[]).map((f) => f.key)).not.toContain("budget");
    await tick(10 * S);
    await h.runWhatsAppSend();
    const after = (await get(`/api/v1/leads/${id}`)).lead as { custom: Record<string, unknown> };
    expect(after.custom.property_type).toBe(villa);
    expect(after.custom.budget).toBeUndefined();
  });

  it("a reply that marks a lead lost uses one of the reasons it was given", async () => {
    const { id } = await leadInRun("Sneha Reddy", "+919876511003");
    await writes(id, "We went with another studio, thanks");
    const lost = stages.find((x) => x.kind === "lost")!;
    provider.script("autopilot_reply", [
      reply({
        message: "Thanks for letting us know. All the best.",
        stageId: lost.id,
        lostReasonId: reasons[0]!.id,
      }),
    ]);
    await tick();
    await tick(10 * S);
    await h.runWhatsAppSend();
    const after = (await get(`/api/v1/leads/${id}`)).lead as { stageId: string; lostReasonId: string };
    expect(after.stageId).toBe(lost.id);
    expect(after.lostReasonId).toBe(reasons[0]!.id);
  });
});
