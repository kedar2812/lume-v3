import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
let cfg: Awaited<ReturnType<Harness["config"]>>;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  cfg = await h.config();
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

const bulk = (c: AuthedClient, body: object) =>
  c.inject({ method: "POST", url: "/api/v1/leads/bulk", payload: body });

describe("bulk actions (report §14)", () => {
  it("moves many leads, skipping ones that can't move without undoing the rest", async () => {
    const owner = await h.seedUser({ grants: [] });
    const ids = [await h.seedLead({ ownerId: owner.id }), await h.seedLead({ ownerId: owner.id })];
    const r = await bulk(admin, {
      ids: [...ids, "0190e0c0-0000-7000-8000-00000000dead"],
      action: { type: "stage", stageId: cfg.stages.Lost },
    });
    expect(r.json()).toEqual({
      updated: [],
      skipped: [
        { id: ids[0], code: "LOST_REASON_REQUIRED" },
        { id: ids[1], code: "LOST_REASON_REQUIRED" },
        { id: "0190e0c0-0000-7000-8000-00000000dead", code: "LEAD_NOT_FOUND" },
      ],
    });
    const ok = await bulk(admin, { ids, action: { type: "stage", stageId: cfg.stages.Replied } });
    expect(ok.json()).toEqual({ updated: ids, skipped: [] });
  });

  it("keeps the note when many leads are marked lost together", async () => {
    const id = await h.seedLead({ ownerId: null });
    const reason = (
      await h.ownerPool.query<{ id: string }>("SELECT id FROM lost_reasons ORDER BY position LIMIT 1")
    ).rows[0]!.id;
    const r = await bulk(admin, {
      ids: [id],
      action: {
        type: "stage",
        stageId: cfg.stages.Lost,
        lostReasonId: reason,
        lostNote: "Went quiet after the call",
      },
    });
    expect(r.json()).toEqual({ updated: [id], skipped: [] });
    const lead = (await admin.inject({ method: "GET", url: `/api/v1/leads/${id}` })).json().lead;
    expect(lead).toMatchObject({ lostReasonId: reason, lostNote: "Went quiet after the call" });
  });

  it("tags, reassigns and deletes", async () => {
    const tag = (
      await admin.inject({ method: "POST", url: "/api/v1/tags", payload: { label: "Hot" } })
    ).json().tag;
    const a = await h.seedUser({ grants: [] });
    const b = await h.seedUser({ grants: [] });
    const ids = [await h.seedLead({ ownerId: a.id }), await h.seedLead({ ownerId: a.id })];
    expect((await bulk(admin, { ids, action: { type: "tags", add: [tag.id] } })).json().updated).toEqual(ids);
    expect(
      (await admin.inject({ method: "GET", url: `/api/v1/leads?tagId=${tag.id}` })).json().items,
    ).toHaveLength(2);
    expect((await bulk(admin, { ids, action: { type: "assign", ownerId: b.id } })).json().updated).toEqual(
      ids,
    );
    expect((await bulk(admin, { ids, action: { type: "delete" } })).json().updated).toEqual(ids);
    expect((await admin.inject({ method: "GET", url: `/api/v1/leads/${ids[0]}` })).statusCode).toBe(404);
  });

  it("a scoped bulk editor only touches leads in scope, and needs the action's permission too", async () => {
    const u = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "own" },
        { key: "leads.bulk_edit", scope: "own" },
        { key: "leads.change_stage", scope: "own" },
      ],
    });
    const c = await h.signIn(u);
    const mine = await h.seedLead({ ownerId: u.id });
    const other = await h.seedUser({ grants: [] });
    const theirs = await h.seedLead({ ownerId: other.id });
    const r = await bulk(c, { ids: [mine, theirs], action: { type: "stage", stageId: cfg.stages.Replied } });
    expect(r.json()).toEqual({ updated: [mine], skipped: [{ id: theirs, code: "LEAD_NOT_FOUND" }] });
    const del = await bulk(c, { ids: [mine], action: { type: "delete" } });
    expect(del.json()).toEqual({ updated: [], skipped: [{ id: mine, code: "FORBIDDEN" }] });
    expect(
      (await bulk(c, { ids: Array.from({ length: 101 }, () => mine), action: { type: "delete" } }))
        .statusCode,
    ).toBe(400);
  });
});

describe("set_phone_country (spec §10: the bulk phone fix)", () => {
  const setCountry = (c: AuthedClient, ids: string[], country: string) =>
    bulk(c, { ids, action: { type: "set_phone_country", country } });

  it("gives unreadable numbers a country, and leaves the rest alone with reasons", async () => {
    const a = await h.seedLead({ ownerId: null, phoneRaw: "0501234567", phoneStatus: "needs_country" });
    const b = await h.seedLead({ ownerId: null, phone: "+971509998888" });
    const c = await h.seedLead({ ownerId: null });
    const d = await h.seedLead({ ownerId: null, phoneRaw: "123", phoneStatus: "invalid" });
    const r = (await setCountry(admin, [a, b, c, d], "AE")).json();
    expect(r.updated).toEqual([a]);
    expect(r.skipped).toEqual([
      { id: b, code: "ALREADY_VALID" },
      { id: c, code: "NO_NUMBER" },
      { id: d, code: "STILL_INVALID" },
    ]);
    const [lead] = await h.queryAll(
      "SELECT phone_e164, phone_status, phone_country_iso FROM leads WHERE id = $1",
      [a],
    );
    expect(lead).toEqual({ phone_e164: "+971501234567", phone_status: "valid", phone_country_iso: "AE" });
    const [act] = await h.queryAll(
      "SELECT type, payload FROM activities WHERE lead_id = $1 ORDER BY occurred_at DESC LIMIT 1",
      [a],
    );
    expect(act).toEqual({ type: "phone_country_set", payload: { country: "AE" } }); // no digits in the history
  });

  it("works on a masked rep's own leads without revealing a digit, and never on others'", async () => {
    const repUser = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "own" },
        { key: "leads.edit", scope: "own" },
        { key: "leads.bulk_edit", scope: "own" },
      ],
    });
    const rep = await h.signIn(repUser);
    const mine = await h.seedLead({
      ownerId: repUser.id,
      phoneRaw: "0501112222",
      phoneStatus: "needs_country",
    });
    const theirs = await h.seedLead({ ownerId: null, phoneRaw: "0503334444", phoneStatus: "needs_country" });
    const res = await setCountry(rep, [mine, theirs], "AE");
    const r = res.json();
    expect(r.updated).toEqual([mine]);
    expect(r.skipped.map((s: { id: string }) => s.id)).toEqual([theirs]);
    expect(res.body).not.toMatch(/501112222|503334444/);
  });

  it("refuses an unknown country", async () => {
    const a = await h.seedLead({ ownerId: null, phoneRaw: "0501234567", phoneStatus: "needs_country" });
    expect((await setCountry(admin, [a], "ZZ")).statusCode).toBe(400);
    expect((await setCountry(admin, [a], "ae")).statusCode).toBe(400);
  });
});
