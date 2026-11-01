import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { fakeProvider } from "../../ai/fake";

/** LUME AI writes templates (owner, 2026-10-31): POST /api/v1/templates/draft, for whoever manages templates. */
let h: Harness;
type U = { id: string; email: string; password: string };
let admin: U;
let rep: U;
const licence = testLicence({ instanceId: "LUME-TEST-TEMPLATE-DRAFT", now: () => h.clock.now });
const provider = fakeProvider();

const as = (u: U) => h.signIn(u);
const draft = async (u: U, prompt: string) =>
  (await as(u)).inject({ method: "POST", url: "/api/v1/templates/draft", payload: { prompt } });
// Row security is forced on ai_reads: read them as the harness's all-scope query.
const reads = async () =>
  h.queryAll<{ task: string; lead_id: string | null; status: string }>(
    "SELECT task, lead_id, status FROM ai_reads ORDER BY created_at",
  );
const monthUsed = async () =>
  (
    (await (await as(admin)).inject({ method: "GET", url: "/api/v1/ai" })).json() as {
      month?: { used: number };
    }
  ).month?.used;

beforeAll(async () => {
  h = await createHarness({
    licence: licence.options,
    ai: { read: (o) => provider.read(o), name: "fake", model: "fake-1" },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({ grants: [{ key: "templates.use", scope: null }], totp: false });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.ownerPool.query("TRUNCATE ai_reads, ai_limit_notices");
  licence.setPlan({ places: null, modules: ALL_MODULES, aiReadsHourly: null, aiCallsMonthly: 1000 });
  await (await as(admin)).inject({ method: "POST", url: "/api/v1/licence/check" });
  await (
    await as(admin)
  ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: true } });
});

describe("POST /api/v1/templates/draft", () => {
  it("two or three drafts LUME could submit, and one read about the business, not a lead", async () => {
    const before = await monthUsed();
    const r = await draft(admin, "Follow up with leads who asked for pricing and went quiet");
    expect(r.statusCode, r.body).toBe(200);
    // Counted against the month like every read: a draft is never free of the allowance.
    expect(await monthUsed()).toBe((before ?? 0) + 1);
    const options = r.json().options as { name: string; body: string; category: string; why: string }[];
    expect(options.length).toBeGreaterThanOrEqual(2);
    for (const o of options) {
      expect(o.body).toMatch(/\{\{lead\.first_name\}\}/);
      expect(o.why.length).toBeGreaterThan(0);
    }
    expect(await reads()).toEqual([{ task: "template_draft", lead_id: null, status: "ok" }]);
    // Never about one lead: nothing of any lead goes to LUME AI.
    expect(provider.calls.at(-1)!.input).toContain(
      "Follow up with leads who asked for pricing and went quiet",
    );
  });

  it("drafts LUME couldn't submit are left out; none left says so with an empty list", async () => {
    provider.script("template_draft", [
      {
        options: [
          { name: "Starts", category: "follow_up", body: "{{lead.first_name}}, still keen?", why: "Short." },
          {
            name: "Offer",
            category: "follow_up",
            body: "Hi {{lead.first_name}}, 30% off today. Keen?",
            why: "Urgent.",
          },
        ],
      },
    ]);
    const r = await draft(admin, "Follow up");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ options: [] });
  });

  it("LUME AI off: said in words, and nothing is read", async () => {
    await (
      await as(admin)
    ).inject({ method: "PUT", url: "/api/v1/integrations/ai", payload: { enabled: false } });
    const r = await draft(admin, "Follow up");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("AI_OFF");
    expect(await reads()).toEqual([]);
  });

  it("only whoever manages templates; an empty request is refused", async () => {
    expect((await draft(rep, "Follow up")).statusCode).toBe(403);
    const empty = await draft(admin, "   ");
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe("EMPTY");
    expect(await reads()).toEqual([]);
  });
});
