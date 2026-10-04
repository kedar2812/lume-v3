import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_GRANTS } from "@lume/core";
import { JUNE, analyticsSeed, at } from "../../../test/analytics-seed";
import { createHarness, type Harness, type SeededUser } from "../../../test/harness";
import { rollupDays } from "./rollup";

let h: Harness;
let admin: SeededUser;
let rep: SeededUser;
let viewer: SeededUser;
let pipelineId: string;
const TZ = "Asia/Kolkata";
const Q = "range=custom&from=2026-06-01&to=2026-06-30";

beforeAll(async () => {
  h = await createHarness();
  await h.ownerPool.query("UPDATE settings SET timezone = $1 WHERE id = 1", [TZ]);
  const s = analyticsSeed(h);
  admin = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    grants: [
      { key: "analytics.view", scope: "own" },
      { key: "leads.view", scope: "own" },
    ],
  });
  // Sees analytics but may not export.
  viewer = await h.seedUser({ grants: [{ key: "analytics.view", scope: "all" }] });
  pipelineId = (await h.config()).pipelineId;
  // A source whose name a spreadsheet would run as a formula: it must arrive as text.
  const src = await s.source('=HYPERLINK("http://example.com")');
  for (let i = 0; i < 6; i++) await s.lead({ owner: admin.id, at: at(6, i + 1), source: src });
  for (let i = 0; i < 4; i++) await s.lead({ owner: rep.id, at: at(6, i + 10) });
  // One from May: outside the range, never in June's list.
  await s.lead({ owner: admin.id, at: at(5, 20) });
  await rollupDays(h.pool, JUNE, TZ);
});
afterAll(async () => h.close());

const tokenFor = async (u: SeededUser, metric = "new_leads") =>
  (await (await h.signIn(u)).inject({ method: "GET", url: `/api/v1/analytics/overview?${Q}` })).json().drill[
    metric
  ] as string;

describe("open a number in Leads, export its leads, export a board's numbers (8D-1 Task 12)", () => {
  it("the Leads list shows exactly the leads behind a number, and its counts agree", async () => {
    const token = await tokenFor(admin);
    const a = await h.signIn(admin);
    const list = (
      await a.inject({ method: "GET", url: `/api/v1/leads?limit=100&drill=${encodeURIComponent(token)}` })
    ).json();
    expect(list.items).toHaveLength(10);
    const drilled = (
      await a.inject({ method: "GET", url: `/api/v1/analytics/drilldown?token=${encodeURIComponent(token)}` })
    ).json();
    expect(list.items.map((x: { id: string }) => x.id).sort()).toEqual(
      drilled.items.map((x: { id: string }) => x.id).sort(),
    );
    const counts = (
      await a.inject({
        method: "GET",
        url: `/api/v1/leads/counts?pipelineId=${pipelineId}&drill=${encodeURIComponent(token)}`,
      })
    ).json();
    expect(counts.total).toBe(10);
  });

  it("a rep's own number opens their own leads; someone else's token isn't theirs; an old one has expired", async () => {
    const mine = await tokenFor(rep);
    const r = await h.signIn(rep);
    expect(
      (
        await r.inject({ method: "GET", url: `/api/v1/leads?limit=100&drill=${encodeURIComponent(mine)}` })
      ).json().items,
    ).toHaveLength(4);
    const theirs = await tokenFor(admin);
    const other = await r.inject({ method: "GET", url: `/api/v1/leads?drill=${encodeURIComponent(theirs)}` });
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe("DRILL_NOT_FOUND");
    h.clock.advance(16 * 60_000);
    const old = await r.inject({ method: "GET", url: `/api/v1/leads?drill=${encodeURIComponent(mine)}` });
    expect(old.statusCode).toBe(410);
    expect(old.json().error.code).toBe("DRILL_EXPIRED");
  });

  it("a saved view never keeps a drill token (it would expire)", async () => {
    const token = await tokenFor(admin);
    const a = await h.signIn(admin);
    const made = await a.inject({
      method: "POST",
      url: "/api/v1/views",
      payload: { name: "From Analytics", color: "accent", filters: { drill: token, ownerId: "me" } },
    });
    expect(made.statusCode, made.body).toBeLessThan(300);
    const v = made.json().view ?? made.json();
    expect(v.filters).toEqual({ ownerId: "me" });
  });

  it("exporting a number's leads makes a traced file of exactly those leads", async () => {
    const token = await tokenFor(admin);
    const res = await (
      await h.signIn(admin)
    ).inject({
      method: "POST",
      url: "/api/v1/leads/export",
      payload: { format: "csv", label: "New leads, June", filters: { drill: token }, columns: ["name"] },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().export.rows).toBe(10);
  });

  it("a board's numbers as CSV: labels and numbers only, formula-safe, audited; only with leads.export", async () => {
    const a = await h.signIn(admin);
    const res = await a.inject({ method: "GET", url: `/api/v1/analytics/sources/csv?${Q}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    // A real byte-order mark first, so Excel reads accents (₹, é) right.
    expect(res.rawPayload.subarray(0, 3).toString("hex")).toBe("efbbbf");
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="lume-sources-2026-06-01-2026-06-30.csv"',
    );
    const lines = res.body
      .replace(/^\uFEFF/, "")
      .trim()
      .split("\r\n");
    expect(lines[0]).toBe(
      "Source,Leads,Share of leads,Win rate,Won,Revenue won,Spend,Cost per lead,Revenue per 1 spent",
    );
    expect(lines).toHaveLength(3); // the header, the formula-named source, and "Added in LUME"
    expect(res.body).toContain(`"'=HYPERLINK(""http://example.com"")"`);
    expect(res.body).not.toMatch(/@example\.com|\+\d{6,}/);
    const audit = await h.queryAll<{ diff: { module: string } }>(
      "SELECT diff FROM audit_log WHERE action = 'analytics.export' ORDER BY id DESC LIMIT 1",
    );
    expect(audit[0]!.diff).toMatchObject({ module: "sources", from: "2026-06-01", to: "2026-06-30" });
    const no = await (
      await h.signIn(viewer)
    ).inject({ method: "GET", url: `/api/v1/analytics/sources/csv?${Q}` });
    expect(no.statusCode).toBe(403);
    expect(no.json().error.code).toBe("NO_EXPORT_ACCESS");
  });

  it("every board exports", async () => {
    const a = await h.signIn(admin);
    for (const m of [
      "overview",
      "funnel",
      "team",
      "sources",
      "revenue",
      "lost",
      "timing",
      "templates",
      "quality",
    ]) {
      const res = await a.inject({ method: "GET", url: `/api/v1/analytics/${m}/csv?${Q}` });
      expect(res.statusCode, `${m}: ${res.body.slice(0, 200)}`).toBe(200);
      expect(res.body.split("\r\n").length, m).toBeGreaterThan(1);
    }
  });
});
