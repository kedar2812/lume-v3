import { generateKeyPairSync } from "node:crypto";
import {
  ALL_GRANTS,
  nextStepOutput,
  rawPublicKey,
  signLicence,
  type AiTask,
  type LicencePayload,
  type PlanClaim,
} from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { fakeProvider } from "../../ai/fake";
import { runRead } from "./service";

/**
 * AI leads across months (owner's spec 2026-11-12, tests T3, T5, T6). The licence keeps the newest answer it was given,
 * so in this file the clock only ever moves forward: each test starts in a later month than the one before.
 */
const server = generateKeyPairSync("ed25519");
const D = 86_400_000;
const all = {
  googleSheets: true,
  webhooks: true,
  googleCalendar: true,
  calendly: true,
  ai: true,
  whatsapp: true,
};
let h: Harness;
let ownerUser: { id: string; email: string; password: string };
let lead: string;
let other: string;
let plan: PlanClaim | undefined;

const token = () =>
  signLicence(
    {
      v: 1,
      kid: "t1",
      instanceId: "LUME-TEST-LEADS",
      state: "active",
      licenseType: "subscription",
      issuedAt: h.clock.now.toISOString(),
      validUntil: new Date(h.clock.now.getTime() + 8 * D).toISOString(),
      paidUntil: "2027-12-31",
      trialEndsAt: null,
      reason: "paid",
      notice: null,
      ...(plan ? { plan } : {}),
    } satisfies LicencePayload,
    server.privateKey,
  );
const owner = () => h.signIn(ownerUser);
/** The plan, kept from a check-in at the clock's time now. */
const leads = async (
  aiLeadsMonthly: number | null,
  aiLeadTopUps: { month: string; leads: number }[] = [],
) => {
  plan = {
    places: null,
    modules: all,
    aiReadsHourly: null,
    aiReadsWeekly: null,
    aiLeadsMonthly,
    aiLeadTopUps,
  };
  await (await owner()).inject({ method: "POST", url: "/api/v1/licence/check" });
};
/** The clock at `iso`, then the plan checked in again then (a newer answer, as the real check-ins are). */
const at = async (iso: string, n: number | null, topUps: { month: string; leads: number }[] = []) => {
  h.clock.now = new Date(iso);
  await leads(n, topUps);
};
const readOn = async (id: string, task: AiTask = "next_step") =>
  (await (await owner()).inject({ method: "POST", url: `/test/ai-read/${id}?task=${task}` })).json();
const used = async () => (await (await owner()).inject({ method: "GET", url: "/api/v1/ai" })).json().leads;

beforeAll(async () => {
  h = await createHarness({
    licence: {
      mode: "enforce",
      instanceId: "LUME-TEST-LEADS",
      licenseKey: "LUME-KEY-SECRET-LEADS",
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.7.0",
      fetch: (async () => new Response(JSON.stringify({ token: token() }), { status: 200 })) as typeof fetch,
    },
    ai: fakeProvider(),
    aiTimeoutMs: 200,
    extraRoutes: (app, d) => {
      app.post<{ Params: { id: string }; Querystring: { task?: AiTask } }>(
        "/test/ai-read/:id",
        { config: { permission: "leads.view" } },
        (req) =>
          runRead(req, d, {
            task: req.query.task ?? "next_step",
            leadId: req.params.id,
            instructions: "Rules.",
            input: "{}",
            schema: nextStepOutput,
            maxOutputTokens: 500,
          }),
      );
    },
  });
  await h.ownerPool.query("UPDATE settings SET timezone = 'Asia/Kolkata' WHERE id = 1");
  ownerUser = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  lead = await h.seedLead({ ownerId: ownerUser.id, name: "Sneha Reddy" });
  other = await h.seedLead({ ownerId: ownerUser.id, name: "Arjun Mehta" });
  h.clock.now = new Date("2026-10-01T06:00:00Z");
  await leads(10);
  await (await owner()).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.ownerPool.query("UPDATE settings SET timezone = 'Asia/Kolkata' WHERE id = 1");
});

describe("AI leads across months", () => {
  it("T3: a lead that starts on the 28th counts again next month, on the business's clock (east of UTC)", async () => {
    await at("2026-10-28T10:00:00Z", 10);
    expect(await readOn(lead)).toHaveProperty("output");
    expect(await used()).toEqual({ used: 1, limit: 10, resetsAt: "2026-10-31T18:30:00.000Z" });
    // 20:00 UTC on October 31 is 01:30 on November 1 in Kolkata: November already, and nothing used yet.
    await at("2026-10-31T20:00:00Z", 10);
    expect(await used()).toEqual({ used: 0, limit: 10, resetsAt: "2026-11-30T18:30:00.000Z" });
    expect(await readOn(lead)).toHaveProperty("output");
    expect(await used()).toMatchObject({ used: 1 });
  });

  it("T3: west of UTC, 02:00 UTC on December 1 is still November 30 in New York", async () => {
    await h.ownerPool.query("UPDATE settings SET timezone = 'America/New_York' WHERE id = 1");
    await at("2026-11-28T15:00:00Z", 10);
    const before = (await used()).used;
    expect(await readOn(other)).toHaveProperty("output");
    await at("2026-12-01T02:00:00Z", 10);
    expect(await readOn(other)).toHaveProperty("output");
    // Still November in New York: the same lead, still one AI lead more than before.
    expect(await used()).toEqual({ used: before + 1, limit: 10, resetsAt: "2026-12-01T05:00:00.000Z" });
    await at("2026-12-01T06:00:00Z", 10); // 01:00 on December 1 in New York (EST)
    expect(await used()).toMatchObject({ used: 0 });
  });

  it("T5: a lead's 20 are for its month: refused on the 30th, LUME AI is back for it on the 1st", async () => {
    await at("2026-12-30T06:00:00Z", 100);
    for (let i = 0; i < 20; i++) expect(await readOn(lead)).toHaveProperty("output");
    expect(await readOn(lead)).toEqual({ unavailable: "lead_cap", until: "2026-12-31T18:30:00.000Z" });
    await at("2027-01-01T06:00:00Z", 100);
    expect(await readOn(lead)).toHaveProperty("output");
  });

  it("T6: top-ups expire at month end: this month's pack is gone on the 1st, with no rollover", async () => {
    await at("2027-02-10T06:00:00Z", 1, [{ month: "2027-02", leads: 100 }]);
    expect(await used()).toMatchObject({ limit: 101 });
    expect(await readOn(lead)).toHaveProperty("output");
    expect(await readOn(other)).toHaveProperty("output");
    // March: the plan's 1 again, the February pack (still signed beside it) doesn't count.
    await at("2027-03-01T06:00:00Z", 1, [{ month: "2027-02", leads: 100 }]);
    expect(await used()).toMatchObject({ used: 0, limit: 1 });
    expect(await readOn(lead)).toHaveProperty("output");
    expect(await readOn(other)).toEqual({ unavailable: "leads", until: "2027-03-31T18:30:00.000Z" });
  });
});
