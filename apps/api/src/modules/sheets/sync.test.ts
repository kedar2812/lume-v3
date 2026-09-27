import { ALL_GRANTS, DEFAULT_RULES, newId, type Mapping, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { sealConfig } from "./config";
import { requestSync } from "./requests";
import { runSync } from "./sync";

let h: Harness;
let adminId: string;
let rules: Rules;
const HEAD = ["Timestamp", "Name", "Phone", "Owner email"];
const mapping: Mapping = {
  columns: [
    { column: 0, to: "field", field: "lead_created_at" },
    { column: 1, to: "field", field: "name" },
    { column: 2, to: "field", field: "phone" },
    { column: 3, to: "field", field: "owner" },
  ],
  createMissingTags: false,
};
// Past dates only: LUME refuses a lead dated in the future (2A), and "today" is the real date.
const row = (i: number, name = `Sheet Lead ${i}`) => [
  `2026-08-${String((i % 28) + 1).padStart(2, "0")} 10:${String(i % 60).padStart(2, "0")}`,
  name,
  `05077${String(i).padStart(5, "0")}`,
  "",
];

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true });
  adminId = (await h.seedUser({ grants: ALL_GRANTS, totp: true })).id;
  const pipelineId = (await h.queryAll<{ id: string }>("SELECT id FROM pipelines WHERE is_default"))[0]!.id;
  const stageId = (
    await h.queryAll<{ id: string }>(
      "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position LIMIT 1",
      [pipelineId],
    )
  )[0]!.id;
  rules = { ...DEFAULT_RULES({ pipelineId, stageId, country: "AE" }), unknownOwner: "error" };
});
afterAll(async () => h.close());

/** A connected, active sheet source (what Task 8's save does), with the fake holding its rows. */
async function connect(rows: string[][], over: Record<string, unknown> = {}) {
  const spreadsheetId = `ss-${newId()}`;
  h.fake!.put(spreadsheetId, {
    title: "Website enquiries",
    sharedWith: [h.fake!.email],
    tabs: [{ sheetId: 7, title: "Form responses", rows: [HEAD, ...rows] }],
  });
  const id = newId();
  await h.pool.query(
    `INSERT INTO lead_sources (id, type, name, status, config_enc, mapping, rules, headers, column_settings, run_as, baseline)
     VALUES ($1, 'google_sheet', 'Website enquiries', 'active', $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      sealConfig(h.keyring, id, {
        spreadsheetId,
        sheetId: 7,
        tabTitle: "Form responses",
        headerRow: 1,
        auth: "service_account",
      }),
      over.mapping ?? mapping,
      over.rules ?? rules,
      JSON.stringify(HEAD),
      { dateOrders: { 0: "YMD" }, decimalMarks: {} },
      over.runAs ?? adminId,
      over.baseline ?? false,
    ],
  );
  return { id, spreadsheetId };
}
const db = () => drizzle(h.pool, { schema });
async function sync(sourceId: string) {
  const r = await db().transaction((tx) =>
    requestSync(tx, { sourceId, trigger: "manual", requestedBy: null }),
  );
  if (!r) throw new Error("source can't sync");
  await runSync({ app: h.app, pool: h.pool, keyring: h.keyring, google: h.google!, maxRows: 50 }, r.syncId);
  return (await h.pool.query("SELECT * FROM source_syncs WHERE id = $1", [r.syncId])).rows[0];
}
const source = async (id: string) =>
  (await h.pool.query("SELECT * FROM lead_sources WHERE id = $1", [id])).rows[0];
const leadsFrom = (id: string) =>
  h.queryAll<{ id: string; name: string }>(
    "SELECT id, name FROM leads WHERE source_id = $1 AND deleted_at IS NULL ORDER BY name",
    [id],
  );
const valueCalls = () => h.fake!.calls.filter((c) => c.endsWith("values:batchGet")).length;

beforeEach(() => h.fake!.calls.splice(0));

describe("a sync", () => {
  it("creates a lead per row, then does nothing more while the sheet is unchanged", async () => {
    const s = await connect([row(1), row(2), row(3)]);
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 3, rows_total: 3, rows_read: 3 });
    expect((await leadsFrom(s.id)).map((l) => l.name)).toEqual([
      "Sheet Lead 1",
      "Sheet Lead 2",
      "Sheet Lead 3",
    ]);
    const before = valueCalls();
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 0, rows_total: 0 });
    expect(valueCalls()).toBe(before); // Drive said "unchanged": no rows were read
    expect(await source(s.id)).toMatchObject({ rows_read: 3, failures: 0, current_sync_id: null });
  });

  it("reads only rows added since, and a repeat enquiry from the same person merges", async () => {
    const s = await connect([row(4), row(5)]);
    await sync(s.id);
    h.fake!.append(s.spreadsheetId, "Form responses", [
      row(6),
      ["2026-08-30 18:00", "Sheet Lead 4 again", row(4)[2]!, ""],
    ]);
    expect(await sync(s.id)).toMatchObject({ created: 1, merged: 1, rows_total: 2 });
    const acts = await h.queryAll<{ type: string }>(
      "SELECT a.type FROM activities a JOIN leads l ON l.id = a.lead_id WHERE l.name = 'Sheet Lead 4'",
    );
    expect(acts.map((a) => a.type)).toContain("imported_again");
  });

  it("a re-sorted sheet is read again in full, and nothing is created twice", async () => {
    const s = await connect([row(7), row(8), row(9)]);
    await sync(s.id);
    h.fake!.setRows(s.spreadsheetId, "Form responses", [HEAD, row(10), row(9), row(7), row(8)]);
    expect(await sync(s.id)).toMatchObject({ created: 1, rows_total: 1 });
    expect(await leadsFrom(s.id)).toHaveLength(4);
  });

  it("Review Focus 1: blank rows and short rows keep their row numbers", async () => {
    const s = await connect([row(11), [], ["2026-08-12 10:00", "Short Row"], [], row(13)]);
    await sync(s.id);
    const [act] = await h.queryAll<{ payload: { row: number; sheet: string } }>(
      "SELECT a.payload FROM activities a JOIN leads l ON l.id = a.lead_id WHERE l.name = 'Short Row' AND a.type = 'imported'",
    );
    expect(act!.payload).toMatchObject({ row: 4, sheet: "Website enquiries" });
  });

  it("a problem row is retried when the rules change, and one fixed in the sheet replaces it", async () => {
    const unknownOwner = ["2026-08-15 10:00", "Owner Unknown", "0507700015", "nobody@nowhere.test"];
    const s = await connect([row(14), unknownOwner, ["not a date", "Bad Date", "0507700016", ""]]);
    expect(await sync(s.id)).toMatchObject({ created: 1, errors: 2 });
    // Fix one in the sheet: a new date is a new fingerprint (the date cell is part of it); the old problem is superseded.
    h.fake!.setRows(s.spreadsheetId, "Form responses", [
      HEAD,
      row(14),
      unknownOwner,
      ["2026-08-16 10:00", "Bad Date", "0507700016", ""],
    ]);
    expect(await sync(s.id)).toMatchObject({ created: 1 });
    // Change the rule the other one broke: it's retried under the new rules, same entry.
    await h.pool.query(
      "UPDATE lead_sources SET rules = jsonb_set(rules, '{unknownOwner}', '\"fallback\"'), config_version = config_version + 1 WHERE id = $1",
      [s.id],
    );
    expect(await sync(s.id)).toMatchObject({ created: 1 });
    const results = await h.queryAll<{ result: string }>(
      "SELECT result FROM source_rows WHERE source_id = $1 ORDER BY row_number, result",
      [s.id],
    );
    expect(results.map((r) => r.result).sort()).toEqual(["created", "created", "created", "superseded"]);
  });

  it("Review Focus 3: a renamed tab is followed by its id", async () => {
    const s = await connect([row(17)]);
    await sync(s.id);
    h.fake!.renameTab(s.spreadsheetId, "Form responses", "Leads (renamed)");
    h.fake!.append(s.spreadsheetId, "Leads (renamed)", [row(18)]);
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 1 });
    expect((await source(s.id)).status).toBe("active");
  });

  it("a renamed mapped column pauses the sheet — LUME never guesses", async () => {
    const s = await connect([row(19)]);
    await sync(s.id);
    h.fake!.setRows(s.spreadsheetId, "Form responses", [
      ["Timestamp", "Full name", "Phone", "Owner email"],
      row(19),
      row(20),
    ]);
    expect(await sync(s.id)).toMatchObject({ status: "failed", error: "COLUMNS_CHANGED" });
    expect(await source(s.id)).toMatchObject({
      status: "needs_attention",
      attention_code: "COLUMNS_CHANGED",
    });
    expect((await source(s.id)).last_error).toMatch(/“Name” is now called “Full name”/);
    expect(await leadsFrom(s.id)).toHaveLength(1);
    const [a] = await h.queryAll<{ action: string }>("SELECT action FROM audit_log WHERE entity_id = $1", [
      s.id,
    ]);
    expect(a!.action).toBe("sheet.needs_attention");
  });

  it("a new column at the end is only offered", async () => {
    const s = await connect([row(21)]);
    h.fake!.setRows(s.spreadsheetId, "Form responses", [
      [...HEAD, "Budget"],
      [...row(21), "900"],
    ]);
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 1 });
    expect((await source(s.id)).new_columns).toEqual(["Budget"]);
  });

  it("an unshared sheet needs attention (access); a deleted one says so", async () => {
    const a = await connect([row(22)]);
    h.fake!.unshare(a.spreadsheetId);
    await sync(a.id);
    expect(await source(a.id)).toMatchObject({ status: "needs_attention", attention_code: "ACCESS_LOST" });
    expect((await source(a.id)).last_error).toContain(h.fake!.email);
    const b = await connect([row(23)]);
    h.fake!.remove(b.spreadsheetId);
    await sync(b.id);
    expect(await source(b.id)).toMatchObject({ attention_code: "SHEET_GONE" });
  });

  it("a Google project problem needs attention with a message for whoever installed LUME", async () => {
    const s = await connect([row(32)]);
    h.fake!.fail(403, 1, "accessNotConfigured");
    await sync(s.id);
    expect(await source(s.id)).toMatchObject({ status: "needs_attention", attention_code: "GOOGLE_SETUP" });
    expect((await source(s.id)).last_error).toMatch(/person who installed LUME/);
    h.fake!.fail(403, 0);
  });

  it("Google being down is a passing failure: the sheet stays active and backs off", async () => {
    const s = await connect([row(24)]);
    h.fake!.fail(503, 8);
    const before = Date.now();
    expect(await sync(s.id)).toMatchObject({ status: "failed" });
    const after = await source(s.id);
    expect(after).toMatchObject({ status: "active", failures: 1, current_sync_id: null });
    expect(new Date(after.next_sync_at).getTime()).toBeGreaterThanOrEqual(before + 240_000 - 1000);
    h.fake!.fail(503, 0);
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 1 });
    expect((await source(s.id)).failures).toBe(0);
  });

  it("Review Focus 5: the person it runs as losing Import pauses it with a reason", async () => {
    // Assign is granted too (the owner column gives leads away), so losing Import alone is what stops it.
    const rep = (
      await h.seedUser({
        grants: (["leads.import", "leads.view", "leads.create", "leads.assign"] as const).map((key) => ({
          key,
          scope: "all" as const,
        })),
        totp: true,
      })
    ).id;
    const s = await connect([row(25)], { runAs: rep });
    await h.revokeGrant(rep, "leads.import");
    expect(await sync(s.id)).toMatchObject({ status: "failed", error: "RUN_AS_ACCESS" });
    expect((await source(s.id)).last_error).toMatch(/can no longer add leads/);
    expect(await leadsFrom(s.id)).toHaveLength(0);
  });

  it("“only rows from now on”: the first sync records what's there and creates nothing", async () => {
    const s = await connect([row(26), row(27)], { baseline: true });
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 0 });
    expect(
      await h.queryAll("SELECT 1 FROM source_rows WHERE source_id = $1 AND result = 'skipped'", [s.id]),
    ).toHaveLength(2);
    h.fake!.append(s.spreadsheetId, "Form responses", [row(28)]);
    expect(await sync(s.id)).toMatchObject({ created: 1 });
    expect((await source(s.id)).baseline).toBe(false);
  });

  it("a sheet over the row limit needs attention", async () => {
    const s = await connect(Array.from({ length: 51 }, (_, i) => row(i + 100)));
    await sync(s.id);
    expect(await source(s.id)).toMatchObject({ status: "needs_attention", attention_code: "TOO_MANY_ROWS" });
  });
});

describe("stopping and locks (final review)", () => {
  it("pausing (or removing) a sheet stops a sync under way within 25 rows", async () => {
    const s = await connect(Array.from({ length: 40 }, (_, i) => row(i + 200)));
    const r = await db().transaction((tx) =>
      requestSync(tx, { sourceId: s.id, trigger: "manual", requestedBy: null }),
    );
    await runSync(
      {
        app: h.app,
        pool: h.pool,
        keyring: h.keyring,
        google: h.google!,
        maxRows: 50,
        testHooks: {
          afterRow: async (n) => {
            // What Pause does: the sheet stops being active and lets go of its sync.
            if (n === 5)
              await h.pool.query(
                "UPDATE lead_sources SET status = 'paused', current_sync_id = NULL WHERE id = $1",
                [s.id],
              );
          },
        },
      },
      r!.syncId,
    );
    const [y] = (
      await h.pool.query("SELECT status, error, created FROM source_syncs WHERE id = $1", [r!.syncId])
    ).rows;
    expect(y).toMatchObject({ status: "failed", error: "stopped", created: 25 });
    expect(await leadsFrom(s.id)).toHaveLength(25);
  });

  it("a sync that finds its sheet paused lets go of the lock, so Resume syncs at once", async () => {
    const s = await connect([row(31)]);
    const r = await db().transaction((tx) =>
      requestSync(tx, { sourceId: s.id, trigger: "manual", requestedBy: null }),
    );
    await h.pool.query("UPDATE lead_sources SET status = 'paused' WHERE id = $1", [s.id]);
    await runSync(
      { app: h.app, pool: h.pool, keyring: h.keyring, google: h.google!, maxRows: 50 },
      r!.syncId,
    );
    expect(await source(s.id)).toMatchObject({ current_sync_id: null, sync_lock_until: null });
    await h.pool.query("UPDATE lead_sources SET status = 'active' WHERE id = $1", [s.id]);
    expect(await sync(s.id)).toMatchObject({ status: "done", created: 1 });
  });
});

describe("requestSync (Review Focus 2)", () => {
  it("two requests at once make one sync; the second joins it", async () => {
    const s = await connect([row(29)]);
    const [a, b] = await Promise.all([
      db().transaction((tx) => requestSync(tx, { sourceId: s.id, trigger: "refresh", requestedBy: adminId })),
      db().transaction((tx) => requestSync(tx, { sourceId: s.id, trigger: "schedule", requestedBy: null })),
    ]);
    expect(a!.syncId).toBe(b!.syncId);
    expect([a!.fresh, b!.fresh].sort()).toEqual([false, true]);
    expect(await h.queryAll("SELECT 1 FROM source_syncs WHERE source_id = $1", [s.id])).toHaveLength(1);
  });

  it("a sync finished moments ago is reused when asked to; a paused source can't sync", async () => {
    const s = await connect([row(30)]);
    const done = await sync(s.id);
    const again = await db().transaction((tx) =>
      requestSync(tx, { sourceId: s.id, trigger: "refresh", requestedBy: adminId, reuseWithinMs: 10_000 }),
    );
    expect(again).toEqual({ syncId: done.id, fresh: false });
    await h.pool.query("UPDATE lead_sources SET status = 'paused' WHERE id = $1", [s.id]);
    expect(
      await db().transaction((tx) =>
        requestSync(tx, { sourceId: s.id, trigger: "manual", requestedBy: null }),
      ),
    ).toBeNull();
  });
});
