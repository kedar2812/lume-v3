import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { fakeProvider, type FakeProvider } from "../../ai/fake";

/** Catch me up (spec 2026-10-18 §5.3): three lines on a lead, offered after a hand-over or 14 quiet days. */
let h: Harness;
let provider: FakeProvider = fakeProvider();
let me: { id: string; email: string; password: string };
let other: { id: string; email: string; password: string };

const as = (u: typeof me): Promise<AuthedClient> => h.signIn(u);
const status = async (lead: string) =>
  (await (await as(me)).inject({ method: "GET", url: `/api/v1/leads/${lead}/ai` })).json();
const aiOn = (on: boolean) =>
  h.ownerPool.query(
    on
      ? `UPDATE settings SET integrations = jsonb_set(integrations, '{ai}', '{"enabled": true}'::jsonb) WHERE id = 1`
      : `UPDATE settings SET integrations = integrations - 'ai' WHERE id = 1`,
  );

beforeAll(async () => {
  h = await createHarness({ ai: { name: "fake", model: "fake-1", read: (o) => provider.read(o) } });
  await h.ownerPool.query("UPDATE settings SET timezone = 'Asia/Kolkata' WHERE id = 1");
  me = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  other = await h.seedUser({ grants: ALL_GRANTS, totp: false });
});
afterAll(() => h.close());
beforeEach(async () => {
  provider = fakeProvider();
  h.clock.now = new Date();
  await aiOn(true);
});

describe("when it's offered", () => {
  it("after a lead is handed to me", async () => {
    const lead = await h.seedLead({ ownerId: other.id, name: "Karthik Varma" });
    await h.queryAll("UPDATE leads SET last_activity_at = now() WHERE id = $1", [lead]);
    expect((await status(lead)).offerCatchUp).toBe(false);
    await (
      await as(me)
    ).inject({ method: "POST", url: `/api/v1/leads/${lead}/assign`, payload: { ownerId: me.id } });
    expect((await status(lead)).offerCatchUp).toBe(true);
  });

  it("not on a lead I just made: being its first owner isn't being handed it", async () => {
    const made = await (
      await as(me)
    ).inject({ method: "POST", url: "/api/v1/leads", payload: { name: "Karan Mehta" } });
    expect(made.statusCode).toBe(201);
    expect((await status(made.json().lead.id)).offerCatchUp).toBe(false);
  });

  it("after 14 quiet days, and not before", async () => {
    const lead = await h.seedLead({ ownerId: me.id, name: "Divya Nair" });
    await h.queryAll("UPDATE leads SET last_activity_at = now() - interval '13 days' WHERE id = $1", [lead]);
    expect((await status(lead)).offerCatchUp).toBe(false);
    await h.queryAll("UPDATE leads SET last_activity_at = now() - interval '15 days' WHERE id = $1", [lead]);
    expect((await status(lead)).offerCatchUp).toBe(true);
  });

  it("not when LUME AI is off", async () => {
    const lead = await h.seedLead({ ownerId: me.id, name: "Arjun Chowdary" });
    await h.queryAll("UPDATE leads SET last_activity_at = now() - interval '30 days' WHERE id = $1", [lead]);
    await aiOn(false);
    expect(await status(lead)).toEqual({ offerCatchUp: false, pending: null });
  });
});

describe("the catch-up", () => {
  it("returns three lines from the provider, read from the lead's own history", async () => {
    const lead = await h.seedLead({ ownerId: me.id, name: "Meghana Rao" });
    await (
      await as(me)
    ).inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/notes`,
      payload: { body: "3BHK in Kokapet, possession in March." },
    });
    const r = await (await as(me)).inject({ method: "POST", url: `/api/v1/leads/${lead}/ai/catch-up` });
    expect(r.statusCode).toBe(200);
    expect(r.json().read.lines).toHaveLength(3);
    expect(provider.calls.at(-1)!.input).toContain("3BHK in Kokapet, possession in March.");
  });

  it("says when LUME AI is off", async () => {
    const lead = await h.seedLead({ ownerId: me.id, name: "Farhan Ali" });
    await aiOn(false);
    const r = await (await as(me)).inject({ method: "POST", url: `/api/v1/leads/${lead}/ai/catch-up` });
    expect(r.json()).toEqual({ unavailable: "off" });
  });
});

describe("a suggestion still waiting", () => {
  it("pending shows the latest next step not yet applied or dismissed, and where it came from", async () => {
    const lead = await h.seedLead({ ownerId: me.id, name: "Nikhil Sastry" });
    const call = await (
      await as(me)
    ).inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/calls`,
      payload: { outcome: "talked", note: "Call back on Saturday." },
    });
    const activity = call.json().activity.id as string;
    const read = (
      await (
        await as(me)
      ).inject({
        method: "POST",
        url: `/api/v1/leads/${lead}/ai/next-step`,
        payload: { activityId: activity },
      })
    ).json().read;
    const s = await status(lead);
    expect(s.pending).toMatchObject({
      id: read.id,
      suggestion: read.suggestion,
      dueAt: read.dueAt,
      from: { activityId: activity },
    });
    await (await as(me)).inject({ method: "POST", url: `/api/v1/ai/reads/${read.id}/dismiss` });
    expect((await status(lead)).pending).toBeNull();
  });
});
