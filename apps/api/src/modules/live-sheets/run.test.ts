import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALL_GRANTS, newId, type Grant, type LiveSheetRule, type PlanTier } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRelay } from "../../../../connect/src/relay";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import type { MadeRow } from "../../../test/live-sheets-fake";
import { grantContext } from "./connect";
import { runLiveSheet } from "./run";

/** Live sheets (spec 2026-11-14 §6): one run, start to finish, against the fake Google. */
const RELAY_TOKEN = "r".repeat(40);
let h: Harness;
let relay: http.Server;
let maya: SeededUser;
let stages: Record<string, string>;

async function withRelay(harness: Harness) {
  const server = http.createServer(
    createRelay({
      publicUrl: "http://relay.test",
      clientId: "cid",
      clientSecret: "cs",
      pickerKey: "pk",
      appId: "1",
      secret: "s".repeat(40),
      instances: [{ url: "https://lume.test", token: RELAY_TOKEN }],
      googleTokenUrl: `${harness.fake!.url}/token`,
      googleApiUrl: harness.fake!.url,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  harness.setRelayUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  return server;
}

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true, oauth: { relayToken: RELAY_TOKEN } });
  relay = await withRelay(h);
  maya = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  stages = (await h.config()).stages;
});
afterAll(async () => {
  relay.close();
  await h.close();
});
beforeEach(async () => {
  h.fake!.made.reset();
  await h.ownerPool.query(
    "DELETE FROM live_sheet_runs; DELETE FROM live_sheet_rows; DELETE FROM live_sheets",
  );
  await sweep(h, "DELETE FROM live_sheet_grants");
  await h.queryAll("UPDATE leads SET deleted_at = now() WHERE deleted_at IS NULL");
});

/** Runs SQL as LUME's own sweep (every grant), as a run reads them. */
async function sweep(harness: Harness, sql: string, params: unknown[] = []) {
  const c = await harness.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('lume.live_sheets_sweep', 'on', true), set_config('lume.lead_scope', 'all', true)",
    );
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r.rows;
  } finally {
    c.release();
  }
}

const rule = (over: Partial<LiveSheetRule> = {}): LiveSheetRule => ({
  stages: { mode: "reached", stageIds: [stages.Qualified!] },
  includeMissing: true,
  includeDnc: false,
  backfill: true,
  ...over,
});

/** A sheet as the form makes it (Task 7's create), with its first run queued. */
async function sheet(
  harness: Harness,
  o: {
    by?: SeededUser;
    preset?: "meta" | "own";
    rule?: LiveSheetRule;
    columns?: string[];
    edits?: "keep" | "replace";
    token?: string;
  } = {},
) {
  const by = o.by ?? maya;
  const grantId = newId();
  const enc = harness.keyring.encrypt(o.token ?? "rt-ok-live", grantContext(grantId));
  await sweep(harness, "SELECT 1");
  const c = await harness.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [by.id]);
    await c.query(
      "INSERT INTO live_sheet_grants (id, user_id, google_email, grant_enc) VALUES ($1, $2, $4, $3)",
      [grantId, by.id, enc, `${grantId}@business.test`],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  const id = newId();
  await harness.ownerPool.query(
    `INSERT INTO live_sheets (id, name, preset, rule, columns, edits, grant_id, made_by, runs_as)
     VALUES ($1, 'Qualified leads', $2, $3, $4, $5, $6, $7, $7)`,
    [
      id,
      o.preset ?? "meta",
      JSON.stringify(o.rule ?? rule()),
      JSON.stringify(o.columns ?? []),
      o.edits ?? "replace",
      grantId,
      by.id,
    ],
  );
  return id;
}
async function run(harness: Harness, sheetId: string, trigger = "now") {
  const runId = newId();
  await harness.ownerPool.query(
    "INSERT INTO live_sheet_runs (id, sheet_id, trigger, status) VALUES ($1, $2, $3, 'queued')",
    [runId, sheetId, trigger],
  );
  const out = await runLiveSheet({ app: harness.app, d: harness.deps, sheetId, runId });
  const [r] = await harness.ownerPool
    .query<{ status: string; total: number; written: number; error: string | null }>(
      "SELECT status, total, written, error FROM live_sheet_runs WHERE id = $1",
      [runId],
    )
    .then((x) => x.rows);
  const [s] = await harness.ownerPool
    .query<{
      status: string;
      pause_reason: string | null;
      spreadsheet_id: string | null;
      url: string | null;
      lead_count: number;
    }>("SELECT status, pause_reason, spreadsheet_id, url, lead_count FROM live_sheets WHERE id = $1", [
      sheetId,
    ])
    .then((x) => x.rows);
  return { out, run: r!, sheet: s! };
}
const tab = (harness: Harness, spreadsheetId: string) => harness.fake!.made.get(spreadsheetId)!.tabs[0]!;
const rowOf = (rows: MadeRow[], lead: string) => rows.find((r) => r.lead === lead);
let n = 0;
const lead = (
  o: { name?: string; stage?: string; email?: string | null; phone?: string | null; owner?: string } = {},
) =>
  h.seedLead({
    ownerId: o.owner ?? maya.id,
    name: o.name ?? `Riya Sharma ${++n}`,
    stage: o.stage ?? "Qualified",
    ...(o.email === null ? {} : { email: o.email ?? `riya${++n}@x.test` }),
    ...(o.phone === null ? {} : { phone: o.phone ?? `+9198000${String(++n).padStart(5, "0")}` }),
  });
const move = (id: string, stage: string) =>
  h.queryAll(
    `WITH l AS (UPDATE leads SET stage_id = $2, stage_entered_at = now(), updated_at = now() WHERE id = $1 RETURNING pipeline_id)
     INSERT INTO lead_stage_history (lead_id, to_stage_id, pipeline_id) SELECT $1, $2, pipeline_id FROM l`,
    [id, stages[stage]],
  );

describe("a live sheet's run", () => {
  it("makes the sheet and writes every matching lead; one with no phone or email goes in, its cells shaded", async () => {
    const a = await lead({ name: "Riya Sharma", email: "riya@x.test", phone: "+919876543210" });
    const none = await lead({ name: "Noor", email: null, phone: null });
    await lead({ stage: "New" }); // never reached Qualified
    const id = await sheet(h);
    const r = await run(h, id, "make");
    expect(r.out).toBe("done");
    expect(r.sheet).toMatchObject({ status: "live", pause_reason: null, lead_count: 2 });
    expect(r.sheet.url).toMatch(/^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
    const t = tab(h, r.sheet.spreadsheet_id!);
    expect(t.rows[0]!.cells).toEqual(["email", "phone", "fn", "ln", "country"]);
    expect(rowOf(t.rows, a)!.cells).toEqual(["riya@x.test", "919876543210", "Riya", "Sharma", "IN"]);
    const empty = rowOf(t.rows, none)!;
    expect(empty.cells.slice(0, 4)).toEqual(["", "", "Noor", ""]);
    expect(empty.bg[0]).toBe("#eef1f6");
    expect(r.run).toMatchObject({ status: "done", total: 2, written: 2 });
    // The About tab says the rule and the count, never anything about Meta.
    const about = h
      .fake!.made.get(r.sheet.spreadsheet_id!)!
      .tabs[1]!.rows.map((x) => String(x.cells[0] ?? ""));
    expect(about).toContain("Leads that reached Qualified");
    expect(about.some((l) => /2 leads/.test(l))).toBe(true);
    expect(about.join(" ")).not.toMatch(/meta/i);
  });

  it("leaves out leads with no phone or email when asked, and do-not-contact leads unless asked", async () => {
    await lead({ email: null, phone: null });
    const dnc = await lead();
    await h.queryAll("UPDATE leads SET dnc_at = now() WHERE id = $1", [dnc]);
    const keep = await lead();
    const r = await run(h, await sheet(h, { rule: rule({ includeMissing: false }) }), "make");
    expect(
      tab(h, r.sheet.spreadsheet_id!)
        .rows.slice(1)
        .map((x) => x.lead),
    ).toEqual([keep]);
    const all = await run(h, await sheet(h, { rule: rule({ includeDnc: true }) }), "make");
    expect(
      tab(h, all.sheet.spreadsheet_id!)
        .rows.slice(1)
        .map((x) => x.lead),
    ).toContain(dnc);
  });

  it("a lead marked do not contact after it went in leaves a reached sheet that leaves them out, paused or not (bug hunt 2026-11-17)", async () => {
    const a = await lead();
    const b = await lead();
    const id = await sheet(h); // reached, do-not-contact leads left out
    const sid = (await run(h, id, "make")).sheet.spreadsheet_id!;
    await h.queryAll("UPDATE leads SET dnc_at = now() WHERE id = $1", [a]);
    await run(h, id);
    expect(rowOf(tab(h, sid).rows, a)).toBeUndefined();
    expect(rowOf(tab(h, sid).rows, b)).toBeDefined();
    // Paused by a person: the privacy pass still takes them out.
    await h.ownerPool.query(
      "UPDATE live_sheets SET status = 'paused', pause_reason = 'paused_by_person' WHERE id = $1",
      [id],
    );
    await h.queryAll("UPDATE leads SET dnc_at = now() WHERE id = $1", [b]);
    await run(h, id, "schedule");
    expect(rowOf(tab(h, sid).rows, b)).toBeUndefined();
    // A sheet that asked for do-not-contact leads keeps them.
    const all = await sheet(h, { rule: rule({ includeDnc: true }) });
    const allSid = (await run(h, all, "make")).sheet.spreadsheet_id!;
    await run(h, all);
    expect(rowOf(tab(h, allSid).rows, a)).toBeDefined();
  });

  it("a rule with a won stage adds Meta's value column", async () => {
    const w = await lead({ stage: "Won" });
    await h.queryAll("UPDATE leads SET value = 15000, won_at = now() WHERE id = $1", [w]);
    const r = await run(
      h,
      await sheet(h, { rule: rule({ stages: { mode: "in", stageIds: [stages.Won!] } }) }),
      "make",
    );
    const t = tab(h, r.sheet.spreadsheet_id!);
    expect(t.rows[0]!.cells.at(-1)).toBe("value");
    expect(rowOf(t.rows, w)!.cells.at(-1)).toBe(15000);
  });

  it("reached keeps a lead that moved on; in removes it", async () => {
    const a = await lead();
    const reached = await sheet(h);
    const inNow = await sheet(h, { rule: rule({ stages: { mode: "in", stageIds: [stages.Qualified!] } }) });
    const r1 = await run(h, reached, "make");
    const r2 = await run(h, inNow, "make");
    await move(a, "Proposal");
    await run(h, reached);
    await run(h, inNow);
    expect(rowOf(tab(h, r1.sheet.spreadsheet_id!).rows, a)).toBeDefined();
    expect(rowOf(tab(h, r2.sheet.spreadsheet_id!).rows, a)).toBeUndefined();
  });

  it("a lead deleted from LUME leaves the sheet, whichever edits choice", async () => {
    for (const edits of ["keep", "replace"] as const) {
      const a = await lead();
      const b = await lead();
      const id = await sheet(h, { edits });
      const r = await run(h, id, "make");
      await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [a]);
      const again = await run(h, id);
      const rows = tab(h, r.sheet.spreadsheet_id!).rows;
      expect(rowOf(rows, a)).toBeUndefined();
      expect(rowOf(rows, b)).toBeDefined();
      expect(again.sheet.lead_count).toBe(1);
      // A lead gone from LUME altogether (no row at all, as after an operator's erasure): still known to leave.
      const ghost = newId();
      h.fake!.made.insertTagged(r.sheet.spreadsheet_id!, 0, 1, ghost, ["ghost@x.test"]);
      await h.ownerPool.query(
        "INSERT INTO live_sheet_rows (sheet_id, lead_id, hash, cells) VALUES ($1, $2, 'h', '[\"ghost@x.test\"]'::jsonb)",
        [id, ghost],
      );
      await h.ownerPool.query("UPDATE live_sheets SET google_modified_at = NULL WHERE id = $1", [id]);
      await run(h, id);
      expect(rowOf(tab(h, r.sheet.spreadsheet_id!).rows, ghost)).toBeUndefined();
      await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [b]);
    }
  });

  it("Keep them: a hand edit in a sorted sheet survives a change in LUME, which still updates the other cells", async () => {
    const a = await lead({ name: "Riya Sharma" });
    await lead({ name: "Aman Verma" });
    const id = await sheet(h, { edits: "keep" });
    const r = await run(h, id, "make");
    const sid = r.sheet.spreadsheet_id!;
    h.fake!.made.sort(sid, 0, 2, "asc");
    const at = tab(h, sid).rows.findIndex((x) => x.lead === a);
    h.fake!.made.editCell(sid, 0, at, 2, "Riyaa");
    await h.queryAll("UPDATE leads SET email = 'riya.new@x.test', updated_at = now() WHERE id = $1", [a]);
    await run(h, id);
    const row = rowOf(tab(h, sid).rows, a)!;
    expect(row.cells[2]).toBe("Riyaa");
    expect(row.cells[0]).toBe("riya.new@x.test");
  });

  it("Put LUME's back: a hand edit is written over at the next update", async () => {
    const a = await lead({ name: "Riya Sharma" });
    const id = await sheet(h, { edits: "replace" });
    const sid = (await run(h, id, "make")).sheet.spreadsheet_id!;
    h.fake!.made.editCell(sid, 0, 1, 2, "Riyaa");
    await run(h, id);
    expect(rowOf(tab(h, sid).rows, a)!.cells[2]).toBe("Riya");
  });

  it("a row deleted by hand stays deleted with Keep them, comes back with Put LUME's back", async () => {
    for (const [edits, back] of [
      ["keep", false],
      ["replace", true],
    ] as const) {
      const a = await lead();
      const id = await sheet(h, { edits });
      const sid = (await run(h, id, "make")).sheet.spreadsheet_id!;
      h.fake!.made.deleteRow(
        sid,
        0,
        tab(h, sid).rows.findIndex((x) => x.lead === a),
      );
      await run(h, id);
      expect(rowOf(tab(h, sid).rows, a) !== undefined).toBe(back);
      await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [a]);
    }
  });

  it("fills 1,300 leads past Google saying it's too busy: each exactly once, the count only ever rising", async () => {
    await h.queryAll(
      `INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, email, phone_e164, phone_status)
       SELECT gen_random_uuid(), s.pipeline_id, s.id, $1, 'Bulk ' || g, 'bulk' || g || '@x.test', '+9197' || lpad(g::text, 8, '0'), 'valid'
       FROM stages s, generate_series(1, 1300) g WHERE s.id = $2`,
      [maya.id, stages.Qualified],
    );
    const id = await sheet(h);
    const seen: number[] = [];
    const runId = newId();
    await h.ownerPool.query(
      "INSERT INTO live_sheet_runs (id, sheet_id, trigger, status) VALUES ($1, $2, 'make', 'queued')",
      [runId, id],
    );
    h.fake!.made.failNextBatch(429);
    await runLiveSheet({
      app: h.app,
      d: h.deps,
      sheetId: id,
      runId,
      sleep: async () => {},
      onProgress: (written) => {
        seen.push(written);
      },
    });
    const [s] = (await h.ownerPool.query("SELECT spreadsheet_id FROM live_sheets WHERE id = $1", [id])).rows;
    const ids = tab(h, s.spreadsheet_id)
      .rows.slice(1)
      .map((r) => r.lead);
    expect(ids).toHaveLength(1300);
    expect(new Set(ids).size).toBe(1300);
    expect(seen.at(-1)).toBe(1300);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1]!)).toBe(true);
  });

  it("paused by a person while a run is writing: the run finishes, the sheet stays paused", async () => {
    await lead();
    await lead();
    const id = await sheet(h);
    const runId = newId();
    await h.ownerPool.query(
      "INSERT INTO live_sheet_runs (id, sheet_id, trigger, status) VALUES ($1, $2, 'make', 'queued')",
      [runId, id],
    );
    await runLiveSheet({
      app: h.app,
      d: h.deps,
      sheetId: id,
      runId,
      onProgress: () =>
        void h.ownerPool.query(
          "UPDATE live_sheets SET status = 'paused', pause_reason = 'paused_by_person' WHERE id = $1",
          [id],
        ),
    });
    await new Promise((r) => setTimeout(r, 50));
    const [s] = (await h.ownerPool.query("SELECT status, pause_reason FROM live_sheets WHERE id = $1", [id]))
      .rows;
    expect(s).toEqual({ status: "paused", pause_reason: "paused_by_person" });
  });

  it("Google access taken away pauses it as disconnected; a deleted file pauses it as gone", async () => {
    await lead();
    const off = await sheet(h, { token: "rt-ok-revoked" });
    await run(h, off, "make");
    h.fake!.revokeOne("rt-ok-revoked");
    expect((await run(h, off)).sheet).toMatchObject({
      status: "paused",
      pause_reason: "google_disconnected",
    });
    const gone = await sheet(h);
    const sid = (await run(h, gone, "make")).sheet.spreadsheet_id!;
    h.fake!.made.removeFile(sid);
    expect((await run(h, gone)).sheet).toMatchObject({ status: "paused", pause_reason: "sheet_gone" });
  });

  it("the maker loses Export leads: paused, admins told; a lead deleted meanwhile still leaves the sheet", async () => {
    const rep = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Noor Ahmed" });
    const a = await lead();
    const id = await sheet(h, { by: rep });
    const sid = (await run(h, id, "make")).sheet.spreadsheet_id!;
    await h.revokeGrant(rep.id, "leads.export");
    expect((await run(h, id)).sheet).toMatchObject({ status: "paused", pause_reason: "maker_gone" });
    // Told as the maker reads it (a notice is its person's own).
    const c = await h.ownerPool.connect();
    let told: { title: string; body: string }[];
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('lume.user_id', $1, true)", [rep.id]);
      told = (
        await c.query(
          "SELECT title, body FROM notifications WHERE kind = 'system_alert' AND title LIKE '%Qualified leads%'",
        )
      ).rows;
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect(told.map((x) => x.title)).toContain("“Qualified leads” is paused");
    // Paused once, told once: the next run doesn't say it again.
    await run(h, id);
    await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [a]);
    await run(h, id, "schedule");
    expect(rowOf(tab(h, sid).rows, a)).toBeUndefined();
  });

  it("a sheet holds only the leads the person it runs as can see", async () => {
    const own: Grant[] = ALL_GRANTS.map((g) => (g.scope ? { ...g, scope: "own" } : g));
    const rep = await h.seedUser({ grants: own, totp: true, name: "Riya Rep" });
    const mine = await lead({ owner: rep.id });
    const theirs = await lead();
    const sid = (await run(h, await sheet(h, { by: rep }), "make")).sheet.spreadsheet_id!;
    const leads = tab(h, sid)
      .rows.slice(1)
      .map((r) => r.lead);
    expect(leads).toContain(mine);
    expect(leads).not.toContain(theirs);
  });

  it("my own columns: name first, a long field cut at Google's limit, one-word names kept whole", async () => {
    const cfg = await h.config();
    const field = Object.keys(cfg.fields).find((k) => !["name", "email", "phone"].includes(k));
    const a = await lead({ name: "Cher" });
    const id = await sheet(h, { preset: "own", columns: ["name", "email", "stage"] });
    const sid = (await run(h, id, "make")).sheet.spreadsheet_id!;
    const t = tab(h, sid);
    expect(t.rows[0]!.cells).toEqual(["Name", "Email", "Stage"]);
    expect(rowOf(t.rows, a)!.cells[0]).toBe("Cher");
    expect(rowOf(t.rows, a)!.cells[2]).toBe("Qualified");
    expect(field).toBeDefined();
  });
});

describe("a live sheet on a plan", () => {
  let p: Harness;
  let server: http.Server;
  const licence = testLicence({ instanceId: "LUME-TEST-LIVE", now: () => p.clock.now });
  const onTier = async (t: PlanTier | null) => {
    licence.setPlan({
      places: null,
      modules: ALL_MODULES,
      aiReadsHourly: null,
      aiLeadsMonthly: null,
      tier: t,
    });
    const c = await p.signIn(maya);
    expect((await c.inject({ method: "POST", url: "/api/v1/licence/check" })).statusCode).toBeLessThan(300);
  };
  beforeAll(async () => {
    p = await createHarness({
      preset: "general",
      google: true,
      oauth: { relayToken: RELAY_TOKEN },
      licence: licence.options,
    });
    server = await withRelay(p);
    maya = await p.seedUser({ grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
    stages = (await p.config()).stages;
  });
  afterAll(async () => {
    server.close();
    await p.close();
  });

  it("on Base it pauses, saying the plan; on Pro it runs; with no tier it runs", async () => {
    await p.seedLead({ ownerId: maya.id, stage: "Qualified", email: "a@x.test" });
    const id = await sheet(p);
    await onTier("base");
    expect((await run(p, id, "make")).sheet).toMatchObject({ status: "paused", pause_reason: "tier" });
    await onTier("pro");
    await p.ownerPool.query("UPDATE live_sheets SET status = 'making', pause_reason = NULL WHERE id = $1", [
      id,
    ]);
    expect((await run(p, id, "make")).sheet.status).toBe("live");
    await onTier(null);
    expect((await run(p, id)).sheet.status).toBe("live");
  });
});
