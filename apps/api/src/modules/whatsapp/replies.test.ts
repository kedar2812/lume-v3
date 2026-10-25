import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inbound } from "../../../../../packages/core/src/whatsapp/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { fakeProvider } from "../../ai/fake";

/**
 * Who replied (W2, spec 2026-10-18 §4.2): each lead's latest WhatsApp reply since a moment, grouped by what it means,
 * in the board's order, only leads the person can see.
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
const licence = testLicence({ instanceId: "LUME-TEST-REPLIES", now: () => h.clock.now });
const provider = fakeProvider();
const MIN = 60_000;

const as = (u: U) => h.signIn(u);
const writes = async (phone: string, text: string) => {
  const body = inbound({
    from: phone.slice(1),
    id: `wamid.${randomUUID()}`,
    at: h.clock.now.toISOString(),
    type: "text",
    text: { body: text },
  });
  expect((await deliver(h, body)).statusCode).toBe(200);
  await h.runWhatsApp();
  await h.runWhatsAppMeaning();
};
const board = async (u: U, since: Date) =>
  (
    await (
      await as(u)
    ).inject({
      method: "GET",
      url: `/api/v1/whatsapp/replies?since=${encodeURIComponent(since.toISOString())}`,
    })
  ).json() as {
    groups: {
      group: string;
      count: number;
      leads: { leadId: string; name: string; summary: string | null }[];
    }[];
  };

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    licence: licence.options,
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: false });
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
  await seedNumber(h, { runAs: admin.id });
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
});

describe("Who replied", () => {
  it("each lead's latest reply since the moment, grouped by meaning in the board's order; a stop and an unread reply too", async () => {
    const sent = new Date(h.clock.now.getTime() - MIN);
    const meera = await h.seedLead({ ownerId: admin.id, name: "Meera Iyer", phone: "+919876500001" });
    const rohan = await h.seedLead({ ownerId: rep.id, name: "Rohan Gupta", phone: "+919876500002" });
    const sneha = await h.seedLead({ ownerId: admin.id, name: "Sneha Reddy", phone: "+919876500003" });
    const kabir = await h.seedLead({ ownerId: admin.id, name: "Kabir Shah", phone: "+919876500004" });
    await writes("+919876500001", "Sounds good, tell me more");
    await writes("+919876500001", "How much does it cost?");
    await writes("+919876500002", "Can you call me tomorrow?");
    await writes("+919876500003", "please stop");
    // LUME AI off for this one: replied, not read.
    await (
      await as(admin)
    ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: false } });
    await writes("+919876500004", "ok");

    const b = await board(admin, sent);
    expect(b.groups.map((g) => g.group)).toEqual([
      "interested",
      "price",
      "visit_or_call",
      "later",
      "not_interested",
      "stop",
      "wrong_number",
      "not_sure",
    ]);
    const of = (g: string) => b.groups.find((x) => x.group === g)!;
    expect(of("price")).toMatchObject({
      count: 1,
      leads: [{ leadId: meera, summary: "How much does it cost?" }],
    });
    expect(of("interested").count).toBe(0);
    expect(of("visit_or_call").leads.map((l) => l.leadId)).toEqual([rohan]);
    expect(of("stop").leads.map((l) => l.leadId)).toEqual([sneha]);
    expect(of("not_sure")).toMatchObject({ count: 1, leads: [{ leadId: kabir, summary: null }] });
  });

  it("only replies since the moment; a rep sees only their own leads", async () => {
    await h.seedLead({ ownerId: admin.id, name: "Meera Iyer", phone: "+919876500001" });
    const rohan = await h.seedLead({ ownerId: rep.id, name: "Rohan Gupta", phone: "+919876500002" });
    await writes("+919876500001", "How much?");
    h.clock.advance(10 * MIN);
    const since = new Date(h.clock.now.getTime() - MIN);
    await writes("+919876500002", "How much is it?");
    const all = await board(admin, since);
    expect(all.groups.flatMap((g) => g.leads.map((l) => l.leadId))).toEqual([rohan]);
    const own = await board(rep, new Date(since.getTime() - 60 * MIN));
    expect(own.groups.flatMap((g) => g.leads.map((l) => l.leadId))).toEqual([rohan]);
  });
});
