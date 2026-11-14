import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { grantContext } from "./connect";
import { dueSheets, recoverStaleRuns, requestRun, tickLiveSheets } from "./queue";

/** Live sheets (spec 2026-11-14 §6): when sheets run, and that a sheet runs once at a time. */
let h: Harness;
let maya: SeededUser;
beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true, oauth: { relayToken: "q".repeat(40) } });
  maya = await h.seedUser({ grants: ALL_GRANTS, totp: true });
});
afterAll(async () => h.close());
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM live_sheet_runs; DELETE FROM live_sheets");
});

async function sheet(o: { status?: string; pause?: string | null; due?: boolean; deleted?: boolean } = {}) {
  const grantId = newId();
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [maya.id]);
    await c.query(
      "INSERT INTO live_sheet_grants (id, user_id, google_email, grant_enc) VALUES ($1, $2, $3, $4)",
      [grantId, maya.id, `${grantId}@x.test`, h.keyring.encrypt("rt-ok", grantContext(grantId))],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  const id = newId();
  await h.ownerPool.query(
    `INSERT INTO live_sheets (id, name, preset, rule, edits, grant_id, made_by, runs_as, status, pause_reason, next_sync_at, deleted_at)
     VALUES ($1, 'S', 'meta', '{}', 'keep', $2, $3, $3, $4, $5, $6, $7)`,
    [
      id,
      grantId,
      maya.id,
      o.status ?? "live",
      o.pause ?? null,
      o.due === false ? new Date(Date.now() + 3_600_000) : new Date(Date.now() - 1000),
      o.deleted ? new Date() : null,
    ],
  );
  return id;
}

describe("when live sheets run", () => {
  it("three triggers at once make one run: Refresh, the schedule and Update now join the same", async () => {
    const id = await sheet();
    const runs = await Promise.all(
      (["refresh", "schedule", "now"] as const).map((trigger) =>
        requestRun(h.pool, { sheetId: id, trigger, requestedBy: null }),
      ),
    );
    expect(new Set(runs.map((r) => r.runId)).size).toBe(1);
    expect(runs.filter((r) => r.fresh)).toHaveLength(1);
    const { rows } = await h.ownerPool.query(
      "SELECT count(*)::int AS n FROM live_sheet_runs WHERE sheet_id = $1",
      [id],
    );
    expect(rows[0].n).toBe(1);
  });

  it("after a run finishes, the next trigger starts a new one", async () => {
    const id = await sheet();
    const a = await requestRun(h.pool, { sheetId: id, trigger: "now", requestedBy: null });
    await h.ownerPool.query("UPDATE live_sheet_runs SET status = 'done' WHERE id = $1", [a.runId]);
    const b = await requestRun(h.pool, { sheetId: id, trigger: "now", requestedBy: null });
    expect(b.fresh).toBe(true);
    expect(b.runId).not.toBe(a.runId);
  });

  it("due sheets run on the tick; a paused one only when a privacy pass can still run, never a deleted one", async () => {
    const live = await sheet();
    const later = await sheet({ due: false });
    const maker = await sheet({ status: "paused", pause: "maker_gone" });
    const tier = await sheet({ status: "paused", pause: "tier" });
    const byPerson = await sheet({ status: "paused", pause: "paused_by_person" });
    const google = await sheet({ status: "paused", pause: "google_disconnected" });
    const gone = await sheet({ status: "paused", pause: "sheet_gone" });
    const deleted = await sheet({ deleted: true });
    const due = new Set(await dueSheets(h.pool));
    for (const id of [live, maker, tier, byPerson]) expect(due.has(id)).toBe(true);
    for (const id of [later, google, gone, deleted]) expect(due.has(id)).toBe(false);
    const queued: string[] = [];
    expect(await tickLiveSheets({ pool: h.pool, enqueue: async (runId) => void queued.push(runId) })).toBe(4);
    // A second tick while those wait makes none.
    expect(await tickLiveSheets({ pool: h.pool, enqueue: async (runId) => void queued.push(runId) })).toBe(0);
    expect(queued).toHaveLength(4);
  });

  it("a run cut off by a restart is closed, so the sheet can run again", async () => {
    const id = await sheet();
    const a = await requestRun(h.pool, { sheetId: id, trigger: "now", requestedBy: null });
    await h.ownerPool.query("UPDATE live_sheet_runs SET status = 'running' WHERE id = $1", [a.runId]);
    expect(await recoverStaleRuns(h.pool)).toBe(1);
    expect((await requestRun(h.pool, { sheetId: id, trigger: "schedule", requestedBy: null })).fresh).toBe(
      true,
    );
  });
});
