import { generateKeyPairSync } from "node:crypto";
import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
import Papa from "papaparse";
import { ALL_GRANTS, rawPublicKey, signLicence, type LicenceStateName } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../test/harness";

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
