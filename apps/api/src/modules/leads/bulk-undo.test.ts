import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { setChunkForTests, setInlineMaxForTests } from "./bulk-runs";

// Phase 7B Task 3: undo is a run too — each lead goes back only if nobody has changed it since.
let h: Harness;
let admin: AuthedClient;
let adminUser: SeededUser;
let cfg: Awaited<ReturnType<Harness["config"]>>;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  cfg = await h.config();
  adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  admin = await h.signIn(adminUser);
});
afterAll(() => h.close());
afterEach(() => {
  setInlineMaxForTests(null);
  setChunkForTests(null);
});

const runOf = async (c: AuthedClient, ids: string[], action: object) => {
  const r = await c.inject({
    method: "POST",
    url: "/api/v1/leads/bulk-runs",
    payload: { selection: { ids }, action },
  });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r.json().run as { id: string; status: string };
};
const undo = (c: AuthedClient, id: string) =>
  c.inject({ method: "POST", url: `/api/v1/leads/bulk-runs/${id}/undo` });
const read = async (c: AuthedClient, id: string) =>
  (await c.inject({ method: "GET", url: `/api/v1/leads/bulk-runs/${id}` })).json().run;
const lead = async (id: string) =>
  (
    await h.queryAll<Record<string, unknown>>(
      "SELECT owner_id, stage_id, lost_reason_id, lost_note, deleted_at, phone_e164, phone_status, phone_country_iso, version FROM leads WHERE id = $1",
      [id],
    )
  )[0]!;
const tagsOf = async (id: string) =>
  (
    await h.queryAll<{ tag_id: string }>("SELECT tag_id FROM lead_tags WHERE lead_id = $1 ORDER BY tag_id", [
      id,
    ])
  ).map((t) => t.tag_id);
const count = async (sql: string, params: unknown[]) => (await h.queryAll<{ n: number }>(sql, params))[0]!.n;

describe("7B: undo", () => {
  it("puts back exactly what each action changed", async () => {
    const dev = await h.seedUser({ grants: [] });
    const sam = await h.seedUser({ grants: [] });
    // assign
    const a = [await h.seedLead({ ownerId: dev.id }), await h.seedLead({ ownerId: null })];
    const ra = await runOf(admin, a, { type: "assign", ownerId: sam.id });
    const u = await undo(admin, ra.id);
    expect(u.statusCode, u.body).toBe(200);
    expect(u.json().run).toMatchObject({ status: "done", done: 2, undoOf: ra.id });
    expect([(await lead(a[0]!)).owner_id, (await lead(a[1]!)).owner_id]).toEqual([dev.id, null]);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM lead_assignment_history WHERE lead_id = ANY($1::uuid[]) AND reason = 'undo'",
        [a],
      ),
    ).toBe(2);
    expect(await read(admin, ra.id)).toMatchObject({ status: "undone", canUndo: false });
    // stage, lost with a reason and a note, then back
    const reason = (
      await h.queryAll<{ id: string }>("SELECT id FROM lost_reasons ORDER BY position LIMIT 1")
    )[0]!.id;
    const s = await h.seedLead({ ownerId: null });
    const rs = await runOf(admin, [s], {
      type: "stage",
      stageId: cfg.stages.Lost,
      lostReasonId: reason,
      lostNote: "Quiet",
    });
    expect((await lead(s)).stage_id).toBe(cfg.stages.Lost);
    await undo(admin, rs.id);
    expect(await lead(s)).toMatchObject({ stage_id: cfg.stages.New, lost_reason_id: null, lost_note: null });
    expect(
      await count(
        "SELECT count(*)::int AS n FROM lead_stage_history WHERE lead_id = $1 AND to_stage_id = $2",
        [s, cfg.stages.New],
      ),
    ).toBeGreaterThan(0);
    // tags: the exact old set
    const mk = async () =>
      (
        await admin.inject({
          method: "POST",
          url: "/api/v1/tags",
          payload: { label: `U ${newId().slice(-6)}` },
        })
      ).json().tag.id as string;
    const [keep, add, gone] = [await mk(), await mk(), await mk()];
    const t = await h.seedLead({ ownerId: null });
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2), ($1, $3)", [t, keep, gone]);
    const before = await tagsOf(t);
    const rt = await runOf(admin, [t], { type: "tags", add: [add], remove: [gone] });
    expect(await tagsOf(t)).toEqual([keep, add].sort());
    await undo(admin, rt.id);
    expect(await tagsOf(t)).toEqual(before);
    // delete: the lead comes back
    const d = await h.seedLead({ ownerId: null });
    const rd = await runOf(admin, [d], { type: "delete" });
    expect((await lead(d)).deleted_at).not.toBeNull();
    await undo(admin, rd.id);
    expect((await lead(d)).deleted_at).toBeNull();
    expect((await admin.inject({ method: "GET", url: `/api/v1/leads/${d}` })).statusCode).toBe(200);
    // phone: the old fields
    const p = await h.seedLead({ ownerId: null, phoneRaw: "0501234567", phoneStatus: "needs_country" });
    const was = await lead(p);
    const rp = await runOf(admin, [p], { type: "set_phone_country", country: "AE" });
    expect((await lead(p)).phone_status).toBe("valid");
    await undo(admin, rp.id);
    expect(await lead(p)).toMatchObject({
      phone_e164: was.phone_e164,
      phone_status: was.phone_status,
      phone_country_iso: was.phone_country_iso,
    });
  });

  it("never overwrites a newer change: a lead edited since is skipped as changed since (Review Focus 3)", async () => {
    const sam = await h.seedUser({ grants: [] });
    const dev = await h.seedUser({ grants: [] });
    const ids = [await h.seedLead({ ownerId: null }), await h.seedLead({ ownerId: null })];
    const r = await runOf(admin, ids, { type: "assign", ownerId: sam.id });
    await h.queryAll("UPDATE leads SET owner_id = $1, version = version + 1 WHERE id = $2", [dev.id, ids[1]]);
    const u = (await undo(admin, r.id)).json().run;
    expect(u).toMatchObject({ done: 1, skipped: 1, skippedBy: { CHANGED_SINCE: 1 } });
    expect((await lead(ids[0]!)).owner_id).toBeNull();
    expect((await lead(ids[1]!)).owner_id).toBe(dev.id);
  });

  it("once only, never an undo of an undo, and only for 24 hours", async () => {
    const sam = await h.seedUser({ grants: [] });
    const r = await runOf(admin, [await h.seedLead({ ownerId: null })], { type: "assign", ownerId: sam.id });
    const u = await undo(admin, r.id);
    expect(u.statusCode).toBe(200);
    const twice = await undo(admin, r.id);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe("ALREADY_UNDONE");
    const back = await undo(admin, u.json().run.id);
    expect(back.statusCode).toBe(422);
    expect(back.json().error.code).toBe("NOT_UNDOABLE");
    const late = await runOf(admin, [await h.seedLead({ ownerId: null })], {
      type: "assign",
      ownerId: sam.id,
    });
    h.clock.advance(24 * 3_600_000 + 60_000);
    admin = await h.signIn(adminUser); // a day on, the old session has lapsed too
    const expired = await undo(admin, late.id);
    expect(expired.statusCode).toBe(422);
    expect(expired.json().error).toMatchObject({
      code: "UNDO_EXPIRED",
      message: "Undo is available for 24 hours after a bulk action.",
    });
  });

  it("someone else's run: another rep can't see it; an admin with bulk_edit at 'all' may undo it", async () => {
    const grants: Grant[] = [
      { key: "leads.view", scope: "own" },
      { key: "leads.bulk_edit", scope: "own" },
      { key: "leads.assign", scope: "own" },
    ];
    const repUser = await h.seedUser({ grants });
    const rep = await h.signIn(repUser);
    const other = await h.signIn(await h.seedUser({ grants }));
    const l = await h.seedLead({ ownerId: repUser.id });
    const r = await runOf(rep, [l], { type: "assign", ownerId: repUser.id });
    expect((await undo(other, r.id)).statusCode).toBe(404);
    expect((await undo(admin, r.id)).statusCode).toBe(200);
  });

  it("undo of a partly cancelled run puts back only what was done; undo itself runs in chunks and survives a crash", async () => {
    setInlineMaxForTests(0);
    setChunkForTests(3);
    const sam = await h.seedUser({ grants: [] });
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await h.seedLead({ ownerId: null }));
    const r = await runOf(admin, ids, { type: "assign", ownerId: sam.id });
    await h.runBulk({
      afterChunk: async (n) => {
        if (n === 0) await admin.inject({ method: "POST", url: `/api/v1/leads/bulk-runs/${r.id}/cancel` });
      },
    });
    expect(await read(admin, r.id)).toMatchObject({ status: "cancelled", done: 3, canUndo: true });
    const u = await undo(admin, r.id);
    expect(u.statusCode).toBe(202);
    expect(u.json().run.total).toBe(3);
    await h.runBulk({
      midChunk: (n, i) => {
        if (n === 0 && i === 1) throw new Error("test crash");
      },
    });
    await h.runBulk();
    expect(await read(admin, u.json().run.id)).toMatchObject({ status: "done", done: 3 });
    expect(
      await count("SELECT count(*)::int AS n FROM leads WHERE id = ANY($1::uuid[]) AND owner_id IS NULL", [
        ids,
      ]),
    ).toBe(7);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM lead_assignment_history WHERE lead_id = ANY($1::uuid[]) AND reason = 'undo'",
        [ids],
      ),
    ).toBe(3);
  });

  // 7B final review, Important 2: a team lead hands leads to someone outside their team, then undoes it.
  it("someone without 'all' can undo their own assign, even of leads they no longer see", async () => {
    const lead1 = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "own" },
        { key: "leads.bulk_edit", scope: "own" },
        { key: "leads.assign", scope: "own" },
      ],
      name: "Ola Own",
    });
    const other = await h.seedUser({ grants: [], name: "Pat Elsewhere" });
    const ids = [await h.seedLead({ ownerId: lead1.id }), await h.seedLead({ ownerId: lead1.id })];
    const c = await h.signIn(lead1);
    const run = await runOf(c, ids, { type: "assign", ownerId: other.id });
    await h.runBulk();
    expect(await read(c, run.id)).toMatchObject({ status: "done", done: 2 });
    const u = await undo(c, run.id);
    expect(u.statusCode, u.body).toBeLessThan(300);
    await h.runBulk();
    expect(await read(c, u.json().run.id)).toMatchObject({ done: 2, skipped: 0 });
    for (const id of ids) expect((await lead(id)).owner_id).toBe(lead1.id);
  });

  // Important 5: leads the run didn't change are left alone, and a stage goes back with its time in stage.
  it("undo leaves alone the leads the action didn't change, and puts back when each entered its stage", async () => {
    const ids = [await h.seedLead({ ownerId: adminUser.id }), await h.seedLead({ ownerId: adminUser.id })];
    await h.queryAll(
      "UPDATE leads SET stage_id = $2, stage_entered_at = '2026-01-05T10:00:00Z' WHERE id = $1",
      [ids[0], cfg.stages.Replied],
    );
    await h.queryAll("UPDATE leads SET stage_entered_at = '2026-02-07T10:00:00Z' WHERE id = $1", [ids[1]]);
    const run = await runOf(admin, ids, { type: "stage", stageId: cfg.stages.Replied });
    await h.runBulk();
    const u = await undo(admin, run.id);
    await h.runBulk();
    expect(await read(admin, u.json().run.id)).toMatchObject({
      done: 1,
      skipped: 1,
      skippedBy: { UNCHANGED: 1 },
    });
    const entered = await h.queryAll<{ id: string; at: Date; stage: string }>(
      "SELECT id, stage_entered_at AS at, stage_id AS stage FROM leads WHERE id = ANY($1::uuid[])",
      [ids],
    );
    const at = (id: string) => entered.find((e) => e.id === id)!;
    expect(at(ids[0]!).at.toISOString()).toBe("2026-01-05T10:00:00.000Z"); // never moved, never touched
    expect(at(ids[1]!).at.toISOString()).toBe("2026-02-07T10:00:00.000Z"); // back where it was, since when it was
    expect(
      await count(
        "SELECT count(*)::int AS n FROM lead_stage_history WHERE lead_id = $1 AND from_stage_id = to_stage_id",
        [ids[0]],
      ),
    ).toBe(0);
  });

  // Important 6: undo can't put leads with someone disabled, or into a stage that's gone.
  it("undo skips leads whose old owner has left, or whose old stage was archived, and says so", async () => {
    const gone = await h.seedUser({ grants: [], name: "Gail Gone" });
    const riya = await h.seedUser({ grants: [], name: "Riya Here" });
    const ids = [await h.seedLead({ ownerId: gone.id }), await h.seedLead({ ownerId: adminUser.id })];
    const run = await runOf(admin, ids, { type: "assign", ownerId: riya.id });
    await h.runBulk();
    await h.ownerPool.query("UPDATE users SET status = 'disabled' WHERE id = $1", [gone.id]);
    const u = await undo(admin, run.id);
    await h.runBulk();
    expect(await read(admin, u.json().run.id)).toMatchObject({
      done: 1,
      skipped: 1,
      skippedBy: { OWNER_INACTIVE: 1 },
    });
    expect((await lead(ids[0]!)).owner_id).toBe(riya.id);
  });
});
