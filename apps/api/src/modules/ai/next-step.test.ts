import { ALL_GRANTS, type NextStep } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { fakeProvider, type FakeProvider } from "../../ai/fake";

/** A call note into a next step, applied with one tap (spec 2026-10-18 §5.2, §5.4; plan Review Focus 1–3, 5). */
let h: Harness;
let provider: FakeProvider = fakeProvider();
let me: { id: string; email: string; password: string };
let rep: { id: string; email: string; password: string };
/** The default pipeline's open stages, in their order. */
let open: string[];
let tag: string;

const as = (u: typeof me): Promise<AuthedClient> => h.signIn(u);
const answer = (over: Partial<NextStep> = {}): NextStep => ({
  summary: "Wants a site visit on Saturday.",
  stageId: null,
  followUp: null,
  lostReasonId: null,
  tagIds: [],
  decisionMaker: null,
  ...over,
});
async function leadWithCall(owner: string, note = "Talked for 20 minutes. Call back Saturday 11.") {
  const lead = await h.seedLead({
    ownerId: owner,
    name: "Sneha Reddy",
    phone: "+919876543210",
    email: "sneha@example.com",
  });
  const c = await as(owner === me.id ? me : rep);
  const call = await c.inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/calls`,
    payload: { outcome: "talked", note },
  });
  return { lead, activity: call.json().activity.id as string };
}
const suggest = async (u: typeof me, lead: string, activity: string) =>
  (await as(u)).inject({
    method: "POST",
    url: `/api/v1/leads/${lead}/ai/next-step`,
    payload: { activityId: activity },
  });
const apply = async (u: typeof me, read: string, parts = { stage: true, followUp: true, tags: true }) =>
  (await as(u)).inject({ method: "POST", url: `/api/v1/ai/reads/${read}/apply`, payload: parts });

beforeAll(async () => {
  h = await createHarness({ ai: { name: "fake", model: "fake-1", read: (o) => provider.read(o) } });
  h.clock.now = new Date("2026-10-21T06:00:00Z"); // Wednesday 11:30 am in Kolkata
  await h.ownerPool.query(
    `UPDATE settings SET timezone = 'Asia/Kolkata', integrations = jsonb_set(integrations, '{ai}', '{"enabled": true}'::jsonb) WHERE id = 1`,
  );
  me = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "leads.edit", scope: "own" },
    ],
    totp: false,
  });
  const pipelineId = (await h.config()).pipelineId;
  open = (
    await h.ownerPool.query<{ id: string }>(
      "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' AND archived_at IS NULL ORDER BY position",
      [pipelineId],
    )
  ).rows.map((r) => r.id);
  tag = (
    await h.ownerPool.query<{ id: string }>(
      "INSERT INTO tags (id, label) VALUES (gen_random_uuid(), 'decision pending') RETURNING id",
    )
  ).rows[0]!.id;
});
afterAll(() => h.close());
beforeEach(() => {
  provider = fakeProvider();
});

describe("reading a call note", () => {
  it("reads a call note into a suggestion the business can apply", async () => {
    const [first, second] = open;
    const { lead, activity } = await leadWithCall(me.id);
    provider = fakeProvider({
      next_step: answer({
        stageId: second,
        followUp: { at: "2026-10-24T11:00", title: "Site visit" },
        tagIds: [tag],
      }),
    });
    const r = await suggest(me, lead, activity);
    expect(r.statusCode).toBe(200);
    expect(r.json().read).toMatchObject({
      id: expect.any(String),
      suggestion: { stageId: second, followUp: { at: "2026-10-24T11:00" }, tagIds: [tag] },
    });
    expect(first).toBeDefined();
  });

  it("drops ids the business doesn't have", async () => {
    const { lead, activity } = await leadWithCall(me.id);
    provider = fakeProvider({
      next_step: answer({ stageId: "0190e0c0-0000-7000-8000-00000000dead", tagIds: ["nope"] }),
    });
    const s = (await suggest(me, lead, activity)).json().read.suggestion;
    expect(s).toMatchObject({ stageId: null, tagIds: [] });
  });

  it("never suggests a follow-up in the past", async () => {
    const { lead, activity } = await leadWithCall(me.id);
    provider = fakeProvider({
      next_step: answer({ followUp: { at: "2026-10-21T09:00", title: "Call back" } }),
    });
    expect((await suggest(me, lead, activity)).json().read.suggestion.followUp).toBeNull();
  });

  it("no contacts reach the provider, only facts from the record and the note", async () => {
    const { lead, activity } = await leadWithCall(me.id, "Wants the 3D design first.");
    await suggest(me, lead, activity);
    const sent = provider.calls.at(-1)!.input;
    expect(sent).toContain("Wants the 3D design first.");
    expect(sent).toContain("Sneha");
    expect(sent).not.toMatch(/9876543210|sneha@example\.com/);
  });

  it("only a note or a logged call with words in it, on this lead", async () => {
    const { lead } = await leadWithCall(me.id);
    const other = await leadWithCall(me.id);
    expect((await suggest(me, lead, other.activity)).statusCode).toBe(404);
  });
});

describe("applying it", () => {
  it("apply moves the stage, sets the follow-up and adds the tag, as the person", async () => {
    const second = open[1]!;
    const { lead, activity } = await leadWithCall(me.id);
    provider = fakeProvider({
      next_step: answer({
        stageId: second,
        followUp: { at: "2026-10-24T11:00", title: "Site visit" },
        tagIds: [tag],
      }),
    });
    const read = (await suggest(me, lead, activity)).json().read.id;
    const r = await apply(me, read);
    expect(r.json()).toEqual({ applied: ["stage", "followUp", "tags"], skipped: [] });
    const [row] = await h.queryAll<{ stage_id: string }>("SELECT stage_id FROM leads WHERE id = $1", [lead]);
    expect(row!.stage_id).toBe(second);
    const tasks = await h.queryAll<{ title: string; due_at: Date }>(
      "SELECT title, due_at FROM tasks WHERE lead_id = $1",
      [lead],
    );
    expect(tasks).toEqual([{ title: "Site visit", due_at: new Date("2026-10-24T05:30:00Z") }]); // 11:00 IST
    const acts = await h.queryAll<{ type: string; payload: { via?: string } }>(
      "SELECT type, payload FROM activities WHERE lead_id = $1 AND type IN ('stage_changed', 'follow_up_set')",
      [lead],
    );
    expect(acts.every((a) => a.payload.via === "ai_suggestion")).toBe(true);
    const [tagged] = await h.queryAll("SELECT 1 FROM lead_tags WHERE lead_id = $1 AND tag_id = $2", [
      lead,
      tag,
    ]);
    expect(tagged).toBeDefined();
  });

  it("only the parts the person kept", async () => {
    const second = open[1]!;
    const { lead, activity } = await leadWithCall(me.id);
    provider = fakeProvider({
      next_step: answer({ stageId: second, followUp: { at: "2026-10-24T11:00", title: "Site visit" } }),
    });
    const read = (await suggest(me, lead, activity)).json().read.id;
    expect((await apply(me, read, { stage: false, followUp: true, tags: false })).json().applied).toEqual([
      "followUp",
    ]);
    const [row] = await h.queryAll<{ stage_id: string }>("SELECT stage_id FROM leads WHERE id = $1", [lead]);
    expect(row!.stage_id).not.toBe(second);
  });

  it("apply after someone else moved the stage applies the rest and says what it skipped", async () => {
    const [, second, third] = open;
    const { lead, activity } = await leadWithCall(me.id);
    provider = fakeProvider({
      next_step: answer({ stageId: second, followUp: { at: "2026-10-24T11:00", title: "Site visit" } }),
    });
    const read = (await suggest(me, lead, activity)).json().read.id;
    await (
      await as(me)
    ).inject({ method: "POST", url: `/api/v1/leads/${lead}/stage`, payload: { stageId: third } });
    const r = (await apply(me, read)).json();
    expect(r.applied).toEqual(["followUp"]);
    expect(r.skipped).toEqual([{ part: "stage", why: "Someone moved this lead since the suggestion." }]);
  });

  it("a part LUME can't apply is skipped in words, and the others still go", async () => {
    const second = open[1]!;
    const field = (await h.config()).fields.value!; // the deal value: empty on this lead
    await h.ownerPool.query("UPDATE stages SET required_field_ids = ARRAY[$1::uuid] WHERE id = $2", [
      field,
      second,
    ]);
    const { lead, activity } = await leadWithCall(me.id);
    provider = fakeProvider({
      next_step: answer({ stageId: second, followUp: { at: "2026-10-24T11:00", title: "Site visit" } }),
    });
    const read = (await suggest(me, lead, activity)).json().read.id;
    const r = (await apply(me, read)).json();
    await h.ownerPool.query("UPDATE stages SET required_field_ids = '{}' WHERE id = $1", [second]);
    expect(r.applied).toEqual(["followUp"]);
    expect(r.skipped).toEqual([{ part: "stage", why: "Fill these in before moving to this stage" }]);
    expect(await h.queryAll("SELECT 1 FROM tasks WHERE lead_id = $1", [lead])).toHaveLength(1);
  });

  it("a second apply is refused, and so is applying a dismissed one", async () => {
    const { lead, activity } = await leadWithCall(me.id);
    const read = (await suggest(me, lead, activity)).json().read.id;
    expect((await apply(me, read)).statusCode).toBe(200);
    const again = await apply(me, read);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("ALREADY_DONE");
    const other = await leadWithCall(me.id);
    const read2 = (await suggest(me, other.lead, other.activity)).json().read.id;
    expect(
      (await (await as(me)).inject({ method: "POST", url: `/api/v1/ai/reads/${read2}/dismiss` })).statusCode,
    ).toBe(200);
    expect((await apply(me, read2)).statusCode).toBe(409);
  });

  it("a rep who can't see the lead gets 404 for read, apply and dismiss", async () => {
    const { lead, activity } = await leadWithCall(me.id);
    expect((await suggest(rep, lead, activity)).statusCode).toBe(404);
    const read = (await suggest(me, lead, activity)).json().read.id;
    expect((await apply(rep, read)).statusCode).toBe(404);
    expect(
      (await (await as(rep)).inject({ method: "POST", url: `/api/v1/ai/reads/${read}/dismiss` })).statusCode,
    ).toBe(404);
  });

  it("when LUME AI is off, the read says so and nothing is written", async () => {
    await h.ownerPool.query(`UPDATE settings SET integrations = integrations - 'ai' WHERE id = 1`);
    const { lead, activity } = await leadWithCall(me.id);
    expect((await suggest(me, lead, activity)).json()).toEqual({ unavailable: "off" });
    await h.ownerPool.query(
      `UPDATE settings SET integrations = jsonb_set(integrations, '{ai}', '{"enabled": true}'::jsonb) WHERE id = 1`,
    );
  });
});
