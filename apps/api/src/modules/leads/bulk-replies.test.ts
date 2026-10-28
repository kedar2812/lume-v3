import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

/**
 * Two bulk actions for the Who replied board (W2, spec 2026-10-18 §4.2): do not contact, and a follow-up, each on many
 * leads at once through the Phase 7 engine, each undoable the way every bulk action is.
 */
let h: Harness;
let admin: AuthedClient;
let adminId: string;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  const u = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  adminId = u.id;
  admin = await h.signIn(u);
});
afterAll(() => h.close());

const runOf = async (c: AuthedClient, ids: string[], action: object) => {
  const r = await c.inject({
    method: "POST",
    url: "/api/v1/leads/bulk-runs",
    payload: { selection: { ids }, action },
  });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r.json().run as { id: string; status: string; done: number; skipped: number };
};
const undo = (c: AuthedClient, id: string) =>
  c.inject({ method: "POST", url: `/api/v1/leads/bulk-runs/${id}/undo` });
const dnc = async (id: string) =>
  (
    await h.queryAll<{ dnc_at: Date | null; dnc_by: string | null; dnc_reason: string | null }>(
      "SELECT dnc_at, dnc_by, dnc_reason FROM leads WHERE id = $1",
      [id],
    )
  )[0]!;
const openTasks = (id: string) =>
  h.queryAll<{ title: string; due_at: Date; assignee_id: string }>(
    "SELECT title, due_at, assignee_id FROM tasks WHERE lead_id = $1 AND status = 'open'",
    [id],
  );

describe("bulk: do not contact", () => {
  it("marks each lead, by this person, with why; one already marked keeps its own; undo lifts only what it set", async () => {
    const ids = [await h.seedLead({ ownerId: null }), await h.seedLead({ ownerId: null })];
    const before = await h.seedLead({ ownerId: null });
    await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${before}/do-not-contact`,
      payload: { reason: "Asked on a call" },
    });
    const run = await runOf(admin, [...ids, before], { type: "do_not_contact", reason: "Wrong number" });
    expect(run).toMatchObject({ status: "done", done: 2, skipped: 1 });
    for (const id of ids)
      expect(await dnc(id)).toMatchObject({ dnc_by: adminId, dnc_reason: "Wrong number" });
    expect((await dnc(before)).dnc_reason).toBe("Asked on a call");
    const acts = await h.queryAll("SELECT 1 FROM activities WHERE lead_id = $1 AND type = 'dnc_set'", [
      ids[0],
    ]);
    expect(acts).toHaveLength(1);

    const u = await undo(admin, run.id);
    expect(u.statusCode, u.body).toBe(200);
    for (const id of ids) expect((await dnc(id)).dnc_at).toBeNull();
    expect((await dnc(before)).dnc_reason).toBe("Asked on a call");
  });

  it("undo never lifts a do not contact set again since, by anyone (review L1)", async () => {
    const id = await h.seedLead({ ownerId: null });
    const run = await runOf(admin, [id], { type: "do_not_contact", reason: "Wrong number" });
    expect(run).toMatchObject({ status: "done", done: 1 });
    // Lifted, then set again: the same words, by the same person, but a new decision.
    expect(
      (await admin.inject({ method: "DELETE", url: `/api/v1/leads/${id}/do-not-contact` })).statusCode,
    ).toBe(200);
    await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${id}/do-not-contact`,
      payload: { reason: "Wrong number" },
    });
    const u = await undo(admin, run.id);
    expect(u.statusCode, u.body).toBe(200);
    await h.runBulk();
    const back = (
      await admin.inject({ method: "GET", url: `/api/v1/leads/bulk-runs/${u.json().run.id}` })
    ).json().run;
    expect(back).toMatchObject({ done: 0, skipped: 1, skippedBy: { CHANGED_SINCE: 1 } });
    expect(await dnc(id)).toMatchObject({ dnc_by: adminId, dnc_reason: "Wrong number" });
    expect((await dnc(id)).dnc_at).not.toBeNull();
  });

  it("someone who can't edit a lead is skipped on it", async () => {
    const owner = await h.seedUser({ grants: [] });
    const rep = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "all" },
        { key: "leads.bulk_edit", scope: "all" },
        { key: "leads.edit", scope: "own" },
      ],
    });
    const theirs = await h.seedLead({ ownerId: owner.id });
    const mine = await h.seedLead({ ownerId: rep.id });
    const run = await runOf(await h.signIn(rep), [theirs, mine], { type: "do_not_contact", reason: "Stop" });
    expect(run).toMatchObject({ done: 1, skipped: 1 });
    expect((await dnc(theirs)).dnc_at).toBeNull();
  });
});

describe("bulk: a follow-up", () => {
  it("one follow-up on each lead at the moment given, for this person; undo cancels exactly those", async () => {
    const ids = [await h.seedLead({ ownerId: null }), await h.seedLead({ ownerId: null })];
    const at = new Date(h.clock.now.getTime() + 3 * 86_400_000).toISOString();
    const kept = await h.seedLead({ ownerId: null });
    const own = await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${kept}/tasks`,
      payload: { title: "Already planned" },
    });
    expect(own.statusCode, own.body).toBe(201);
    const run = await runOf(admin, [...ids, kept], { type: "follow_up", at, title: "Call about the price" });
    expect(run).toMatchObject({ status: "done", done: 3 });
    for (const id of ids)
      expect(await openTasks(id)).toEqual([
        { title: "Call about the price", due_at: new Date(at), assignee_id: adminId },
      ]);
    expect((await openTasks(kept)).map((t) => t.title).sort()).toEqual([
      "Already planned",
      "Call about the price",
    ]);

    const u = await undo(admin, run.id);
    expect(u.statusCode, u.body).toBe(200);
    for (const id of ids) expect(await openTasks(id)).toEqual([]);
    expect((await openTasks(kept)).map((t) => t.title)).toEqual(["Already planned"]);
  });

  it("undo leaves a follow-up handed to someone else since, says so, and puts back the rest (review L4)", async () => {
    const repUser = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "own" },
        { key: "leads.bulk_edit", scope: "own" },
        { key: "leads.edit", scope: "own" },
      ],
    });
    const other = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
    const rep = await h.signIn(repUser);
    const ids = [await h.seedLead({ ownerId: repUser.id }), await h.seedLead({ ownerId: repUser.id })];
    const at = new Date(h.clock.now.getTime() + 3 * 86_400_000).toISOString();
    const run = await runOf(rep, ids, { type: "follow_up", at, title: "Call back" });
    expect(run).toMatchObject({ status: "done", done: 2 });
    // An admin hands one of them to someone else: it's theirs now, not the rep's to cancel.
    await h.queryAll("UPDATE tasks SET assignee_id = $2 WHERE lead_id = $1 AND status = 'open'", [
      ids[0],
      other.id,
    ]);
    const u = await undo(rep, run.id);
    expect(u.statusCode, u.body).toBe(200);
    await h.runBulk();
    expect((await openTasks(ids[0]!)).map((t) => t.assignee_id)).toEqual([other.id]);
    expect(await openTasks(ids[1]!)).toEqual([]);
    const back = (
      await rep.inject({ method: "GET", url: `/api/v1/leads/bulk-runs/${u.json().run.id}` })
    ).json().run;
    expect(back).toMatchObject({ done: 1, skipped: 1, skippedBy: { FOLLOW_UP_NOT_YOURS: 1 } });
  });

  it("a moment already past is refused before anything is done", async () => {
    const id = await h.seedLead({ ownerId: null });
    const r = await admin.inject({
      method: "POST",
      url: "/api/v1/leads/bulk-runs",
      payload: {
        selection: { ids: [id] },
        action: {
          type: "follow_up",
          at: new Date(h.clock.now.getTime() - 60_000).toISOString(),
          title: "Too late",
        },
      },
    });
    expect(r.statusCode).toBe(400);
    expect(await openTasks(id)).toEqual([]);
  });
});
