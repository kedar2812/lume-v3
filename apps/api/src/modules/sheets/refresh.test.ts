import { ALL_GRANTS, DEFAULT_RULES, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { sealConfig } from "./config";

let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;
let repEmail: string;
let spreadsheetId: string;
const HEAD = ["Timestamp", "Name", "Phone", "Owner"];

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true });
  const adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  const adminId = adminUser.id;
  admin = await h.signIn(adminUser);
  const repUser = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true });
  const repId = repUser.id;
  rep = await h.signIn(repUser);
  repEmail = (await h.queryAll<{ email: string }>("SELECT email FROM users WHERE id = $1", [repId]))[0]!
    .email;
  await admin.inject({
    method: "PUT",
    url: "/api/v1/integrations/google-sheets",
    payload: { enabled: true },
  });
  spreadsheetId = `ss-${newId()}`;
  h.fake!.put(spreadsheetId, {
    title: "Enquiries",
    sharedWith: [h.fake!.email],
    tabs: [{ sheetId: 0, title: "Leads", rows: [HEAD] }],
  });
  const pipelineId = (await h.queryAll<{ id: string }>("SELECT id FROM pipelines WHERE is_default"))[0]!.id;
  const stageId = (
    await h.queryAll<{ id: string }>(
      "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position LIMIT 1",
      [pipelineId],
    )
  )[0]!.id;
  const id = newId();
  await h.pool.query(
    `INSERT INTO lead_sources (id, type, name, status, config_enc, mapping, rules, headers, column_settings, run_as)
     VALUES ($1, 'google_sheet', 'Enquiries', 'active', $2, $3, $4, $5, '{"dateOrders":{"0":"YMD"},"decimalMarks":{}}', $6)`,
    [
      id,
      sealConfig(h.keyring, id, {
        spreadsheetId,
        sheetId: 0,
        tabTitle: "Leads",
        headerRow: 1,
        auth: "service_account",
      }),
      {
        columns: [
          { column: 0, to: "field", field: "lead_created_at" },
          { column: 1, to: "field", field: "name" },
          { column: 2, to: "field", field: "phone" },
          { column: 3, to: "field", field: "owner" },
        ],
        createMissingTags: false,
      },
      DEFAULT_RULES({ pipelineId, stageId, country: "AE" }),
      JSON.stringify(HEAD),
      adminId,
    ],
  );
});
afterAll(async () => h.close());

const get = (c: AuthedClient, url: string) => c.inject({ method: "GET", url });
const post = (c: AuthedClient, url: string) => c.inject({ method: "POST", url });
const add = (rows: string[][]) => h.fake!.append(spreadsheetId, "Leads", rows);
/** Ages every refresh and finished sync, as if the windows of amendment A9 had passed. */
const forget = async () => {
  await h.pool.query("UPDATE source_refreshes SET created_at = created_at - interval '1 hour'");
  await h.pool.query("UPDATE source_syncs SET finished_at = finished_at - interval '1 hour'");
};
const n = (i: number) => `0509${String(i).padStart(6, "0")}`;

describe("status", () => {
  it("shows Refresh to anyone who sees leads, and what needs attention only to admins", async () => {
    expect((await get(rep, "/api/v1/sheets/status")).json()).toEqual({ refresh: true, attention: [] });
    expect((await get(admin, "/api/v1/sheets/status")).json()).toEqual({ refresh: true, attention: [] });
  });
});

describe("a Refresh", () => {
  it("counts what each person can see: the admin all three, the rep the one given to them", async () => {
    await post(admin, "/api/v1/leads/arrivals/seen");
    add([
      ["2026-09-27 08:00", "Refresh One", n(1), ""],
      ["2026-09-27 08:05", "Refresh Two", n(2), repEmail],
      ["2026-09-27 08:10", "Refresh Three", n(3), ""],
    ]);
    const a = (await post(admin, "/api/v1/sheets/refresh")).json();
    const b = (await post(rep, "/api/v1/sheets/refresh")).json();
    expect(a.id).not.toBe(b.id);
    expect((await get(admin, `/api/v1/sheets/refresh/${a.id}`)).json()).toMatchObject({
      status: "running",
      created: 0,
    });
    await h.runSyncs();
    const forAdmin = (await get(admin, `/api/v1/sheets/refresh/${a.id}`)).json();
    expect(forAdmin).toMatchObject({
      status: "done",
      rowsRead: 3,
      rowsTotal: 3,
      created: 3,
      merged: 0,
      unreachable: false,
    });
    expect(forAdmin.leadIds).toHaveLength(3);
    const forRep = (await get(rep, `/api/v1/sheets/refresh/${b.id}`)).json();
    expect(forRep).toMatchObject({ status: "done", created: 1 });
    // Only the person who pressed it can read it.
    expect((await get(rep, `/api/v1/sheets/refresh/${a.id}`)).statusCode).toBe(404);
  });

  it("Review Focus 2: a second press within 3 s is the same refresh; presses join one sync", async () => {
    await forget();
    add([["2026-09-27 09:00", "Refresh Four", n(4), ""]]);
    const a = (await post(admin, "/api/v1/sheets/refresh")).json();
    const again = (await post(admin, "/api/v1/sheets/refresh")).json();
    expect(again.id).toBe(a.id);
    const other = (await post(rep, "/api/v1/sheets/refresh")).json();
    const ids = await h.queryAll<{ sync_ids: string[] }>(
      "SELECT sync_ids FROM source_refreshes WHERE id = ANY($1)",
      [[a.id, other.id]],
    );
    expect(ids[0]!.sync_ids).toEqual(ids[1]!.sync_ids);
    await h.runSyncs();
  });

  it("merges count separately; nothing new is simply done with zeros", async () => {
    add([["2026-09-27 10:00", "Refresh One (again)", n(1), ""]]);
    await forget(); // past the 3 s and 10 s windows (amendment A9), so this is a new refresh and a new sync
    const a = (await post(admin, "/api/v1/sheets/refresh")).json();
    await h.runSyncs();
    expect((await get(admin, `/api/v1/sheets/refresh/${a.id}`)).json()).toMatchObject({
      created: 0,
      merged: 1,
    });
  });

  it("Google unreachable is said plainly, once the sync gives up", async () => {
    await h.pool.query("UPDATE lead_sources SET last_modified = NULL"); // make it read again
    h.fake!.fail(503, 20);
    await forget();
    const a = (await post(admin, "/api/v1/sheets/refresh")).json();
    await h.runSyncs();
    const p = (await get(admin, `/api/v1/sheets/refresh/${a.id}`)).json();
    expect(p).toMatchObject({ status: "done", unreachable: true });
    // When LUME tries again: the sheet's own next try, not a fixed "2 minutes".
    const [next] = await h.queryAll<{ s: number }>(
      "SELECT ceil(extract(epoch FROM next_sync_at - now()))::int AS s FROM lead_sources WHERE type = 'google_sheet' AND status = 'active'",
    );
    expect(p.retryInS).toBeGreaterThan(0);
    expect(Math.abs(p.retryInS - next!.s)).toBeLessThanOrEqual(2);
    h.fake!.fail(503, 0);
  });

  it("several sheets are asked for in one order, so two refreshes at once can't deadlock", async () => {
    const [src] = await h.queryAll<Record<string, unknown>>(
      "SELECT * FROM lead_sources WHERE type = 'google_sheet' AND status = 'active' LIMIT 1",
    );
    const extra = ["ffffffff-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000001"];
    // Their own empty sheet, so they bring no leads into the tests after this one.
    const empty = `ss-${newId()}`;
    h.fake!.put(empty, {
      title: "Empty",
      sharedWith: [h.fake!.email],
      tabs: [{ sheetId: 0, title: "Leads", rows: [HEAD] }],
    });
    for (const id of extra)
      await h.pool.query(
        `INSERT INTO lead_sources (id, type, name, status, config_enc, mapping, rules, headers, column_settings, run_as)
         VALUES ($1, 'google_sheet', $2, 'active', $3, $4, $5, $6, $7, $8)`,
        [
          id,
          `Extra ${id.slice(0, 4)}`,
          sealConfig(h.keyring, id, {
            spreadsheetId: empty,
            sheetId: 0,
            tabTitle: "Leads",
            headerRow: 1,
            auth: "service_account",
          }),
          src!.mapping,
          src!.rules,
          JSON.stringify(src!.headers),
          src!.column_settings,
          src!.run_as,
        ],
      );
    await forget();
    const a = (await post(admin, "/api/v1/sheets/refresh")).json();
    const [r] = await h.queryAll<{ sources: string[] }>(
      `SELECT array_agg(s.source_id ORDER BY x.n) AS sources
         FROM source_refreshes f, unnest(f.sync_ids) WITH ORDINALITY AS x(id, n)
         JOIN source_syncs s ON s.id = x.id WHERE f.id = $1`,
      [a.id],
    );
    expect(r!.sources).toEqual([...r!.sources].sort());
    await h.runSyncs();
    await h.pool.query("UPDATE lead_sources SET status = 'paused' WHERE id = ANY($1)", [extra]);
  });
});

describe("arrivals", () => {
  it("counts leads that arrived since your last visit, not the ones you made yourself", async () => {
    await post(admin, "/api/v1/leads/arrivals/seen");
    expect((await get(admin, "/api/v1/leads/arrivals")).json()).toMatchObject({ count: 0, ids: [] });
    await h.pool.query("UPDATE lead_sources SET next_sync_at = now(), last_modified = NULL, failures = 0");
    add([["2026-09-27 11:00", "Arrival One", n(5), ""]]);
    await forget();
    await post(admin, "/api/v1/sheets/refresh");
    await h.runSyncs();
    const mine = await admin.inject({
      method: "POST",
      url: "/api/v1/leads",
      payload: { name: "Typed By Me" },
    });
    expect(mine.statusCode).toBe(201);
    const a = (await get(admin, "/api/v1/leads/arrivals")).json();
    expect(a.count).toBe(1);
    expect(typeof a.since).toBe("string");
    const list = (await get(admin, `/api/v1/leads?arrivedAfter=${encodeURIComponent(a.since)}`)).json();
    expect(list.items.map((l: { name: string }) => l.name)).toEqual(["Arrival One"]);
  });
});
