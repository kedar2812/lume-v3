import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

const firsts = async (leadId: string) =>
  (
    await h.queryAll<{ c: Date | null; r: Date | null }>(
      "SELECT first_contact_at c, first_reply_at r FROM lead_firsts WHERE lead_id = $1",
      [leadId],
    )
  )[0] ?? null;
const activity = (leadId: string, type: string, at: string) =>
  h.queryAll(
    "INSERT INTO activities (id, lead_id, type, occurred_at) VALUES (gen_random_uuid(), $1, $2, $3::timestamptz)",
    [leadId, type, at],
  );

describe("first contact and first reply (8A Task 1)", () => {
  it("the first message, call or booking is the first contact; a later one doesn't move it, an earlier one does", async () => {
    const owner = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
    const lead = await h.seedLead({ ownerId: owner.id });
    expect(await firsts(lead)).toBeNull();
    await activity(lead, "note", "2026-09-01T10:00:00Z"); // a note isn't contact
    expect(await firsts(lead)).toBeNull();
    await activity(lead, "whatsapp_opened", "2026-09-01T11:00:00Z");
    expect((await firsts(lead))!.c!.toISOString()).toBe("2026-09-01T11:00:00.000Z");
    await activity(lead, "call_logged", "2026-09-02T09:00:00Z");
    expect((await firsts(lead))!.c!.toISOString()).toBe("2026-09-01T11:00:00.000Z");
    await activity(lead, "meeting_booked", "2026-09-01T10:30:00Z"); // recorded late, happened earlier
    expect((await firsts(lead))!.c!.toISOString()).toBe("2026-09-01T10:30:00.000Z");
    expect((await firsts(lead))!.r).toBeNull();
    await activity(lead, "reply_logged", "2026-09-03T08:00:00Z");
    await activity(lead, "reply_logged", "2026-09-04T08:00:00Z");
    expect((await firsts(lead))!.r!.toISOString()).toBe("2026-09-03T08:00:00.000Z");
  });

  it("leaves the lead itself alone: its version and updated time don't move", async () => {
    const owner = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
    const lead = await h.seedLead({ ownerId: owner.id });
    const before = (
      await h.queryAll<{ v: number; u: Date }>("SELECT version v, updated_at u FROM leads WHERE id = $1", [
        lead,
      ])
    )[0]!;
    await activity(lead, "whatsapp_opened", "2026-09-05T10:00:00Z");
    const after = (
      await h.queryAll<{ v: number; u: Date }>("SELECT version v, updated_at u FROM leads WHERE id = $1", [
        lead,
      ])
    )[0]!;
    expect(after).toEqual(before);
  });

  it("logging a call counts as contact, says how it went, and only for someone who may edit the lead", async () => {
    const rep = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "own" },
        { key: "leads.edit", scope: "own" },
      ],
    });
    const other = await h.seedUser({ grants: [] });
    const mine = await h.seedLead({ ownerId: rep.id });
    const theirs = await h.seedLead({ ownerId: other.id });
    const c = await h.signIn(rep);
    const r = await c.inject({
      method: "POST",
      url: `/api/v1/leads/${mine}/calls`,
      payload: { outcome: "no_answer", note: "Rang twice" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().activity).toMatchObject({
      type: "call_logged",
      payload: { outcome: "no_answer", note: "Rang twice" },
    });
    expect((await firsts(mine))!.c).not.toBeNull();
    const refused = await c.inject({
      method: "POST",
      url: `/api/v1/leads/${theirs}/calls`,
      payload: { outcome: "talked" },
    });
    expect(refused.statusCode).toBe(404); // not theirs to see, as every lead route answers
    const bad = await c.inject({
      method: "POST",
      url: `/api/v1/leads/${mine}/calls`,
      payload: { outcome: "voicemail" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("a call that's a lead's first contact says how long after the enquiry it came; the next doesn't", async () => {
    const me = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "own" },
        { key: "leads.edit", scope: "own" },
      ],
    });
    const lead = await h.seedLead({ ownerId: me.id });
    await h.queryAll("UPDATE leads SET created_at = now() - interval '44 minutes' WHERE id = $1", [lead]);
    const c = await h.signIn(me);
    const first = await c.inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/calls`,
      payload: { outcome: "talked" },
    });
    expect(first.json().firstContact.minutes).toBeGreaterThanOrEqual(43);
    expect(first.json().firstContact.minutes).toBeLessThan(46);
    // An imported lead that carries its own enquiry date (a date, no time): said in days, never a made-up minute.
    const old = await h.seedLead({ ownerId: me.id });
    await h.queryAll("UPDATE leads SET lead_created_at = (now() - interval '3 days')::date WHERE id = $1", [
      old,
    ]);
    const oldCall = await c.inject({
      method: "POST",
      url: `/api/v1/leads/${old}/calls`,
      payload: { outcome: "talked" },
    });
    expect(oldCall.json().firstContact).toEqual({ days: 3 });
    const again = await c.inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/calls`,
      payload: { outcome: "talked" },
    });
    expect(again.json().firstContact).toBeNull();
  });

  it("the app can read when leads were first reached, and the worker can't", async () => {
    const owner = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
    const lead = await h.seedLead({ ownerId: owner.id });
    await activity(lead, "whatsapp_opened", "2026-09-06T10:00:00Z");
    const app = await h.pool.query("SELECT count(*)::int n FROM lead_firsts WHERE lead_id = $1", [lead]);
    expect(app.rows[0].n).toBe(1);
    const worker = new (await import("pg")).default.Pool({ connectionString: h.url("lume_worker"), max: 1 });
    await expect(worker.query("SELECT 1 FROM lead_firsts LIMIT 1")).rejects.toThrow(/permission denied/);
    await worker.end();
  });
});
