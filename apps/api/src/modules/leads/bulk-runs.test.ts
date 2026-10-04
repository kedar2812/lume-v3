import { ALL_GRANTS, newId, type Grant } from "@lume/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { clearOldBulkItems, setBulkCapForTests, setInlineMaxForTests } from "./bulk-runs";
import { setSearchCapForTests } from "./query";

// Phase 7B Task 1: every bulk action is a run; a selection is picked ids or "everything matching a filter".
let h: Harness;
let admin: AuthedClient;
let adminId: string;
beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  const a = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  adminId = a.id;
  admin = await h.signIn(a);
});
afterAll(() => h.close());
afterEach(() => {
  setBulkCapForTests(null);
  setInlineMaxForTests(null);
});

const run = (c: AuthedClient, body: object) =>
  c.inject({ method: "POST", url: "/api/v1/leads/bulk-runs", payload: body });
const owners = async (ids: string[]) =>
  (
    await h.queryAll<{ id: string; owner_id: string | null }>(
      "SELECT id, owner_id FROM leads WHERE id = ANY($1::uuid[])",
      [ids],
    )
  ).reduce<Record<string, string | null>>((m, r) => ({ ...m, [r.id]: r.owner_id }), {});
/** A fresh tag on these leads: a filter that matches exactly them, whatever else the database holds. */
const tagged = async (ids: string[]) => {
  const tag = newId();
  await h.queryAll("INSERT INTO tags (id, label) VALUES ($1, $2)", [tag, `B ${tag.slice(-8)}`]);
  for (const id of ids)
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [id, tag]);
  return tag;
};
const sales: Grant[] = [
  { key: "leads.view", scope: "own" },
  { key: "leads.bulk_edit", scope: "own" },
  { key: "leads.assign", scope: "own" },
];

describe("7B: a bulk action is a run", () => {
  it("picked ids, inline: answers done with the counts, and the leads moved", async () => {
    const to = await h.seedUser({ grants: [] });
    const ids = [
      await h.seedLead({ ownerId: null }),
      await h.seedLead({ ownerId: null }),
      await h.seedLead({ ownerId: null }),
    ];
    const r = await run(admin, { selection: { ids }, action: { type: "assign", ownerId: to.id } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().run).toMatchObject({
      status: "done",
      total: 3,
      done: 3,
      skipped: 0,
      failed: 0,
      action: { type: "assign" },
    });
    expect(Object.values(await owners(ids))).toEqual([to.id, to.id, to.id]);
  });

  it("the selection's edges: nothing, too many ids, duplicates once, and the cap exactly", async () => {
    const a = await h.seedLead({ ownerId: null });
    const b = await h.seedLead({ ownerId: null });
    const assign = { type: "assign", ownerId: adminId };
    const none = await run(admin, { selection: { ids: [] }, action: assign });
    expect(none.statusCode).toBe(422);
    expect(none.json().error.code).toBe("NOTHING_SELECTED");
    const nothing = await run(admin, { selection: { filters: { tagId: newId() } }, action: assign });
    expect(nothing.statusCode).toBe(422);
    expect(nothing.json().error.code).toBe("NOTHING_SELECTED");
    const many = Array.from({ length: 5001 }, () => newId());
    expect((await run(admin, { selection: { ids: many }, action: assign })).statusCode).toBe(400);
    const dup = await run(admin, { selection: { ids: [a, a, b] }, action: assign });
    expect(dup.json().run.total).toBe(2);

    setBulkCapForTests(3);
    const three = await tagged([
      await h.seedLead({ ownerId: null }),
      await h.seedLead({ ownerId: null }),
      await h.seedLead({ ownerId: null }),
    ]);
    expect(
      (await run(admin, { selection: { filters: { tagId: three } }, action: assign })).json().run.total,
    ).toBe(3);
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [
      await h.seedLead({ ownerId: null }),
      three,
    ]);
    const over = await run(admin, { selection: { filters: { tagId: three } }, action: assign });
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toMatchObject({
      code: "TOO_MANY",
      message: "Narrow the selection: up to 3 leads at a time.",
    });
  });

  it("a filter is read as the person, minus what they unticked, and says when the count moved (Review Focus 1)", async () => {
    const repUser = await h.seedUser({ grants: sales });
    const rep = await h.signIn(repUser);
    const other = await h.seedUser({ grants: [] });
    const mine = [
      await h.seedLead({ ownerId: repUser.id }),
      await h.seedLead({ ownerId: repUser.id }),
      await h.seedLead({ ownerId: repUser.id }),
    ];
    const theirs = await h.seedLead({ ownerId: other.id });
    const tag = await tagged([...mine, theirs]);
    const r = await run(rep, {
      selection: { filters: { tagId: tag }, except: [mine[2]], expected: 4 },
      action: { type: "assign", ownerId: repUser.id },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().run).toMatchObject({
      total: 2,
      done: 2,
      selection: { kind: "filter", total: 2, expected: 4, except: 1 },
    });
    const items = await h.queryAll<{ lead_id: string }>(
      "SELECT lead_id FROM bulk_run_items WHERE run_id = $1",
      [r.json().run.id],
    );
    expect(items.map((i) => i.lead_id).sort()).toEqual([mine[0], mine[1]].sort());
    expect((await owners([theirs]))[theirs]).toBe(other.id);
    // A capped search can't be a selection: it would act on an arbitrary part of what matches.
    await h.seedLead({ ownerId: null, name: "Quillon Abe" });
    await h.seedLead({ ownerId: null, name: "Quillon Bea" });
    setSearchCapForTests(1);
    try {
      const broad = await run(admin, {
        selection: { filters: { q: "Quillon" } },
        action: { type: "assign", ownerId: adminId },
      });
      expect(broad.statusCode).toBe(422);
      expect(broad.json().error.code).toBe("SEARCH_TOO_BROAD");
    } finally {
      setSearchCapForTests(null);
    }
  });

  it("the leads behind a number on Analytics: exactly those, never every lead the other filters show", async () => {
    const june = [await h.seedLead({ ownerId: null }), await h.seedLead({ ownerId: null })];
    for (const id of june)
      await h.queryAll("UPDATE leads SET created_at = '2026-06-10T05:00:00Z' WHERE id = $1", [id]);
    const token = (
      await admin.inject({
        method: "GET",
        url: "/api/v1/analytics/overview?range=custom&from=2026-06-01&to=2026-06-30",
      })
    ).json().drill.new_leads as string;
    const r = await run(admin, {
      selection: { filters: { drill: token }, expected: 2 },
      action: { type: "assign", ownerId: adminId },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().run).toMatchObject({
      total: 2,
      done: 2,
      selection: { kind: "filter", total: 2, analytics: true },
    });
    const items = await h.queryAll<{ lead_id: string }>(
      "SELECT lead_id FROM bulk_run_items WHERE run_id = $1",
      [r.json().run.id],
    );
    expect(items.map((i) => i.lead_id).sort()).toEqual([...june].sort());
    // A token that isn't theirs, or has run out, is refused, not read as no filter.
    const bad = await run(admin, {
      selection: { filters: { drill: "x".repeat(40) } },
      action: { type: "assign", ownerId: adminId },
    });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().error.code).toBe("DRILL_NOT_FOUND");
  });

  it("over the inline limit: queued, nothing changed yet; the queue runs it on the snapshot taken", async () => {
    setInlineMaxForTests(2);
    const to = await h.seedUser({ grants: [] });
    const ids = [
      await h.seedLead({ ownerId: null }),
      await h.seedLead({ ownerId: null }),
      await h.seedLead({ ownerId: null }),
    ];
    const tag = await tagged(ids);
    const r = await run(admin, {
      selection: { filters: { tagId: tag } },
      action: { type: "assign", ownerId: to.id },
    });
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().run).toMatchObject({ status: "queued", total: 3, done: 0 });
    expect(Object.values(await owners(ids))).toEqual([null, null, null]);
    // A lead tagged after the snapshot isn't part of the run.
    const late = await h.seedLead({ ownerId: null });
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [late, tag]);
    await h.runBulk();
    const read = await admin.inject({ method: "GET", url: `/api/v1/leads/bulk-runs/${r.json().run.id}` });
    expect(read.json().run).toMatchObject({ status: "done", done: 3 });
    expect(read.json().run.finishedAt).toBeTruthy();
    expect(Object.values(await owners(ids))).toEqual([to.id, to.id, to.id]);
    expect((await owners([late]))[late]).toBeNull();
  });

  it("a run is read by its maker or an admin; the list is the person's own, from the last 7 days", async () => {
    const repUser = await h.seedUser({ grants: sales });
    const rep = await h.signIn(repUser);
    const other = await h.signIn(await h.seedUser({ grants: sales }));
    const lead = await h.seedLead({ ownerId: repUser.id });
    const made = (
      await run(rep, { selection: { ids: [lead] }, action: { type: "assign", ownerId: repUser.id } })
    ).json().run;
    const path = `/api/v1/leads/bulk-runs/${made.id}`;
    expect((await rep.inject({ method: "GET", url: path })).statusCode).toBe(200);
    expect((await other.inject({ method: "GET", url: path })).statusCode).toBe(404);
    expect((await admin.inject({ method: "GET", url: path })).statusCode).toBe(200);
    // An old run of the rep's: past 7 days, so not listed.
    await h.ownerPool.query(
      `INSERT INTO bulk_runs (id, user_id, action, selection, status, total, created_at, finished_at)
       VALUES ($1, $2, '{"type":"delete"}', '{"kind":"ids","total":1}', 'done', 1, $3, $3)`,
      [newId(), repUser.id, new Date(h.clock.now.getTime() - 8 * 86_400_000)],
    );
    const mine = (await rep.inject({ method: "GET", url: "/api/v1/leads/bulk-runs" })).json().runs as {
      id: string;
      userId: string;
    }[];
    expect(mine.map((x) => x.id)).toEqual([made.id]);
    const everyone = (await admin.inject({ method: "GET", url: "/api/v1/leads/bulk-runs" })).json().runs as {
      id: string;
    }[];
    expect(everyone.map((x) => x.id)).toContain(made.id);
  });

  it("POST /leads/bulk still answers { updated, skipped }, through a run", async () => {
    const ids = [await h.seedLead({ ownerId: null }), await h.seedLead({ ownerId: null })];
    const r = await admin.inject({
      method: "POST",
      url: "/api/v1/leads/bulk",
      payload: { ids, action: { type: "assign", ownerId: adminId } },
    });
    expect(r.json()).toEqual({ updated: ids, skipped: [] });
    const [last] = await h.queryAll<{ status: string; total: number }>(
      "SELECT r.status, r.total FROM bulk_runs r JOIN bulk_run_items i ON i.run_id = r.id WHERE i.lead_id = $1",
      [ids[0]],
    );
    expect(last).toEqual({ status: "done", total: 2 });
  });

  it("a run's items are kept 30 days after it finishes, then cleared; the run itself stays", async () => {
    const mk = async (daysAgo: number) => {
      const id = newId();
      const when = new Date(Date.now() - daysAgo * 86_400_000);
      await h.ownerPool.query(
        `INSERT INTO bulk_runs (id, user_id, action, selection, status, total, done, created_at, finished_at)
         VALUES ($1, $2, '{"type":"delete"}', '{"kind":"ids","total":1}', 'done', 1, 1, $3, $3)`,
        [id, adminId, when],
      );
      await h.ownerPool.query(
        "INSERT INTO bulk_run_items (run_id, lead_id, position, result) VALUES ($1, $2, 1, 'done')",
        [id, newId()],
      );
      return id;
    };
    const old = await mk(31);
    const recent = await mk(29);
    await clearOldBulkItems(h.pool);
    const items = await h.queryAll<{ run_id: string }>(
      "SELECT run_id FROM bulk_run_items WHERE run_id = ANY($1::uuid[])",
      [[old, recent]],
    );
    expect(items.map((i) => i.run_id)).toEqual([recent]);
    const runs = await h.queryAll<{ id: string }>("SELECT id FROM bulk_runs WHERE id = ANY($1::uuid[])", [
      [old, recent],
    ]);
    expect(runs).toHaveLength(2);
  });

  // 7C final review, Important 1: a screen showing far fewer than match (counts missing or stale) is caught.
  it("refuses when far more match than the person was shown, and allows a few new arrivals", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(await h.seedLead({ ownerId: null }));
    const tag = await tagged(ids);
    const assign = { type: "assign", ownerId: adminId };
    const shown5 = await run(admin, {
      selection: { filters: { tagId: tag }, except: [], expected: 5 },
      action: assign,
    });
    expect(shown5.statusCode).toBe(409);
    expect(shown5.json().error).toMatchObject({ code: "MATCH_CHANGED" });
    expect(shown5.json().error.message).toBe(
      "40 leads match these filters now, not the 5 shown. Look again, then choose.",
    );
    const close = await run(admin, {
      selection: { filters: { tagId: tag }, except: [], expected: 38 },
      action: assign,
    });
    expect(close.statusCode).toBeLessThan(300);
  });
});
