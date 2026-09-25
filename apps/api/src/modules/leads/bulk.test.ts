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
