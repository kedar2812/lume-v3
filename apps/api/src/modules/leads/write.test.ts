import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
let repUser: SeededUser;
let rep: AuthedClient;
let cfg: Awaited<ReturnType<Harness["config"]>>;
const SALES = [
  { key: "leads.view", scope: "own" },
  { key: "leads.edit", scope: "own" },
  { key: "leads.change_stage", scope: "own" },
  { key: "leads.contact.reveal", scope: "own" },
] as const;

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  cfg = await h.config();
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  repUser = await h.seedUser({ grants: [...SALES] });
  rep = await h.signIn(repUser);
});
afterAll(async () => h.close());

const stage = (c: AuthedClient, id: string, body: object) =>
  c.inject({ method: "POST", url: `/api/v1/leads/${id}/stage`, payload: body });

describe("stage moves (report §5.3, §14)", () => {
  it("moves, records history and bumps version; won and lost stamp their dates", async () => {
    const id = await h.seedLead({ ownerId: repUser.id });
    const moved = (await stage(rep, id, { stageId: cfg.stages["Call booked"] })).json().lead;
    expect(moved).toMatchObject({ stageId: cfg.stages["Call booked"], version: 2 });
    const won = (await stage(rep, id, { stageId: cfg.stages.Won })).json().lead;
    expect(won.wonAt).not.toBeNull();
    const back = (await stage(rep, id, { stageId: cfg.stages.New })).json().lead;
    expect(back.wonAt).toBeNull();
    // History tables sit under FORCE RLS too: read them with full scope.
    const rows = await h.queryAll<{ n: number }>(
      "SELECT count(*)::int n FROM lead_stage_history WHERE lead_id = $1 AND changed_by = $2",
      [id, repUser.id],
    );
    expect(rows[0]!.n).toBe(3);
  });

  it("Lost requires an active lost reason", async () => {
    const id = await h.seedLead({ ownerId: repUser.id });
    expect((await stage(rep, id, { stageId: cfg.stages.Lost })).json().error.code).toBe(
      "LOST_REASON_REQUIRED",
    );
    const lost = (
      await stage(rep, id, {
        stageId: cfg.stages.Lost,
        lostReasonId: cfg.lostReasons[0],
        lostNote: "Went quiet",
      })
    ).json().lead;
    expect(lost).toMatchObject({ lostReasonId: cfg.lostReasons[0], lostNote: "Went quiet" });
    expect(lost.lostAt).not.toBeNull();
  });

  it("enforces the target stage's required fields", async () => {
    await admin.inject({
      method: "PATCH",
      url: `/api/v1/stages/${cfg.stages["Call done"]}`,
      payload: { requiredFieldIds: [cfg.fields.email] },
    });
    const id = await h.seedLead({ ownerId: repUser.id });
    const r = await stage(rep, id, { stageId: cfg.stages["Call done"] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: "REQUIRED_FIELDS", details: { fields: ["email"] } });
    await admin.inject({
      method: "PATCH",
      url: `/api/v1/stages/${cfg.stages["Call done"]}`,
      payload: { requiredFieldIds: [] },
    });
  });

  it("an out-of-scope lead can't be moved (404)", async () => {
    const other = await h.seedUser({ grants: [] });
    const id = await h.seedLead({ ownerId: other.id });
    expect((await stage(rep, id, { stageId: cfg.stages.Replied })).statusCode).toBe(404);
  });
});

describe("assignment (report §7.4 #4)", () => {
  it("reassigning a lead removes the previous rep's access immediately", async () => {
    const mate = await h.seedUser({ grants: [...SALES] });
    const id = await h.seedLead({ ownerId: repUser.id });
    expect((await rep.inject({ method: "GET", url: `/api/v1/leads/${id}` })).statusCode).toBe(200);
    const r = await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${id}/assign`,
      payload: { ownerId: mate.id, reason: "rebalance" },
    });
    expect(r.json()).toEqual({ id, ownerId: mate.id, visible: true });
    expect((await rep.inject({ method: "GET", url: `/api/v1/leads/${id}` })).statusCode).toBe(404);
    expect((await rep.inject({ method: "GET", url: `/api/v1/leads/${id}/activities` })).statusCode).toBe(404);
    expect(
      (await (await h.signIn(mate)).inject({ method: "GET", url: `/api/v1/leads/${id}` })).statusCode,
    ).toBe(200);
  });

  it("a rep who may assign their own leads can hand one away and loses sight of it", async () => {
    const assigner = await h.seedUser({ grants: [...SALES, { key: "leads.assign", scope: "own" }] });
    const c = await h.signIn(assigner);
    const mate = await h.seedUser({ grants: [] });
    const id = await h.seedLead({ ownerId: assigner.id });
    const r = await c.inject({
      method: "POST",
      url: `/api/v1/leads/${id}/assign`,
      payload: { ownerId: mate.id },
    });
    expect(r.json()).toEqual({ id, ownerId: mate.id, visible: false });
    expect((await c.inject({ method: "GET", url: `/api/v1/leads/${id}` })).statusCode).toBe(404);
  });

  it("refuses disabled users and unassigning below all scope", async () => {
    const off = await h.seedUser({ grants: [], status: "disabled" });
    const id = await h.seedLead({ ownerId: repUser.id });
    expect(
      (
        await admin.inject({
          method: "POST",
          url: `/api/v1/leads/${id}/assign`,
          payload: { ownerId: off.id },
        })
      ).json().error.code,
    ).toBe("UNKNOWN_USER");
    const assigner = await h.signIn(
      await h.seedUser({ grants: [...SALES, { key: "leads.assign", scope: "own" }] }),
    );
    expect(
      (
        await assigner.inject({
          method: "POST",
          url: `/api/v1/leads/${id}/assign`,
          payload: { ownerId: null },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("notes and activities", () => {
  it("adds a note and lists activities newest first", async () => {
    const id = await h.seedLead({ ownerId: repUser.id });
    const n = await rep.inject({
      method: "POST",
      url: `/api/v1/leads/${id}/notes`,
      payload: { body: "Prefers evenings" },
    });
    expect(n.statusCode).toBe(201);
    // The new note has the same shape as a listed one, so a screen can show it without a refetch.
    expect(n.json().activity).toMatchObject({
      type: "note",
      payload: { body: "Prefers evenings" },
      occurredAt: expect.any(String),
      user: { id: repUser.id, name: expect.any(String) },
    });
    await stage(rep, id, { stageId: cfg.stages.Replied });
    const acts = (await rep.inject({ method: "GET", url: `/api/v1/leads/${id}/activities` })).json().items;
    expect(acts.map((a: { type: string }) => a.type).slice(0, 2)).toEqual(["stage_changed", "note"]);
    expect(acts[1]).toMatchObject({ payload: { body: "Prefers evenings" }, user: { id: repUser.id } });
  });
});

describe("Reveal (report §12.2 #3)", () => {
  it("shows one lead's full contact, meters and audits it, and never caches it", async () => {
    const id = await h.seedLead({ ownerId: repUser.id, phone: "+971501234567", email: "reveal@example.com" });
    const r = await rep.inject({
      method: "POST",
      url: `/api/v1/leads/${id}/contact/reveal`,
      headers: { "idempotency-key": "reveal-key-0001" },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ phone: "+971 50 123 4567", email: "reveal@example.com", instagram: null });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(
      (await h.pool.query("SELECT count FROM reveal_counters WHERE user_id = $1", [repUser.id])).rows[0]
        .count,
    ).toBe(1);
    expect(
      (
        await h.pool.query(
          "SELECT count(*)::int n FROM audit_log WHERE action = 'lead.contact.reveal' AND entity_id = $1",
          [id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await h.pool.query("SELECT count(*)::int n FROM idempotency_keys WHERE key = 'reveal-key-0001'"))
        .rows[0].n,
    ).toBe(0);
  });

  it("needs the reveal permission and scope", async () => {
    const other = await h.seedUser({ grants: [] });
    const theirs = await h.seedLead({ ownerId: other.id, phone: "+971501234567" });
    expect(
      (await rep.inject({ method: "POST", url: `/api/v1/leads/${theirs}/contact/reveal` })).statusCode,
    ).toBe(404);
    const viewer = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const mine = await h.seedLead({ ownerId: viewer.id, phone: "+971501234567" });
    expect(
      (await (await h.signIn(viewer)).inject({ method: "POST", url: `/api/v1/leads/${mine}/contact/reveal` }))
        .statusCode,
    ).toBe(403);
  });
});
