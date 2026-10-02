import ExcelJS from "exceljs";
import Papa from "papaparse";
import { ALL_GRANTS, type Grant } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { setExportCapForTests } from "./make";

/** Phase 6B Task 2: an export of the current view, its mark, its download and its expiry. */
let h: Harness;
let admin: AuthedClient;
let adminUser: SeededUser;
let teamLead: AuthedClient;
let masked: AuthedClient;
let maskedUser: SeededUser;
let rep: SeededUser;
let other: SeededUser;

const exporter = (scope: "team" | "all", contacts: boolean): Grant[] => [
  { key: "leads.view", scope },
  { key: "leads.export", scope: null },
  ...(contacts ? [{ key: "leads.contact.full" as const, scope }] : []),
];

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Hana Ito" });
  admin = await h.signIn(adminUser);
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Rory Reid" });
  other = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Sam Okafor" });
  const lead = await h.seedUser({ grants: exporter("team", true), totp: true, name: "Tara Lead" });
  await h.seedTeam(lead.id, [rep.id]);
  teamLead = await h.signIn(lead);
  maskedUser = await h.seedUser({ grants: exporter("all", false), totp: true, name: "Mo Masked" });
  masked = await h.signIn(maskedUser);
  for (const [name, owner, phone, email] of [
    ["Dana Whitfield", rep.id, "+971501112233", "dana@example.com"],
    ["Lina Farah", rep.id, "+971502223344", "lina@example.com"],
    ["Omar Haddad", other.id, "+971503334455", "omar@example.com"],
    ['=HYPERLINK("http://x")', other.id, "+971504445566", null],
  ] as const)
    await h.seedLead({ ownerId: owner, name, phone, ...(email ? { email } : {}) });
});
afterAll(() => h.close());

type Made = {
  export: { id: string; code: string; rows: number; format: string; label: string; available: boolean };
};
const make = (c: AuthedClient, body: Record<string, unknown>) =>
  c.inject({ method: "POST", url: "/api/v1/leads/export", payload: body });
const columns = ["name", "stage", "owner", "phone", "email"];
const csv = (body: string) =>
  Papa.parse<string[]>(body.replace(/^\uFEFF/, ""), { skipEmptyLines: true }).data;
const download = (c: AuthedClient, id: string) =>
  c.inject({ method: "GET", url: `/api/v1/leads/exports/${id}/download` });

describe("an export of the current view (6B Task 2)", () => {
  it("is a CSV of the view's columns, the code on every row, and one check row", async () => {
    const r = await make(admin, { format: "csv", label: "All leads", filters: { sort: "name" }, columns });
    expect(r.statusCode, r.body).toBe(201);
    const made = (r.json() as Made).export;
    expect(made).toMatchObject({ rows: 4, format: "csv", label: "All leads", available: true });
    expect(made.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const file = await download(admin, made.id);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toMatch(/text\/csv/);
    expect(file.headers["content-disposition"]).toMatch(
      new RegExp(`attachment; filename="LUME leads .+ ${made.code}\\.csv"`),
    );
    const rows = csv(file.body);
    expect(rows[0]).toEqual(["Name", "Stage", "Owner", "Phone", "Email", "LUME ref"]);
    expect(rows).toHaveLength(1 + 4 + 1);
    for (const row of rows.slice(1)) expect(row.at(-1)).toBe(made.code);
    const checks = rows.filter((row) => /@example\.invalid$/.test(row[4] ?? ""));
    expect(checks).toHaveLength(1);
    expect(checks[0]![3]).toMatch(/^\+44 7700 900\d{3}$/);
    expect(rows.map((row) => row[0])).toContain("Dana Whitfield");
  });

  it("is an Excel file holding the same", async () => {
    const r = await make(admin, { format: "xlsx", label: "All leads", filters: {}, columns });
    const made = (r.json() as Made).export;
    const file = await download(admin, made.id);
    expect(file.headers["content-type"]).toMatch(/spreadsheetml/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file.rawPayload as unknown as ArrayBuffer);
    const sheet = book.getWorksheet("Leads")!;
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      "Name",
      "Stage",
      "Owner",
      "Phone",
      "Email",
      "LUME ref",
    ]);
    expect(sheet.rowCount).toBe(1 + 4 + 1);
    expect(sheet.getRow(2).getCell(6).value).toBe(made.code);
  });

  it("never writes a live formula (Review Focus 4)", async () => {
    const r = await make(admin, { format: "csv", label: "All leads", filters: {}, columns: ["name"] });
    const rows = csv((await download(admin, (r.json() as Made).export.id)).body);
    expect(rows.map((row) => row[0])).toContain(`'=HYPERLINK("http://x")`);
    const x = await make(admin, { format: "xlsx", label: "All leads", filters: {}, columns: ["name"] });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(
      (await download(admin, (x.json() as Made).export.id)).rawPayload as unknown as ArrayBuffer,
    );
    const names = book.getWorksheet("Leads")!.getColumn(1).values;
    expect(names).toContain(`'=HYPERLINK("http://x")`);
  });

  it("holds only what the exporter may see (Review Focus 1)", async () => {
    // A team lead: their team's leads only.
    const t = await make(teamLead, { format: "csv", label: "Team", filters: {}, columns });
    const team = csv((await download(teamLead, (t.json() as Made).export.id)).body).map((r) => r[0]);
    expect(team).toEqual(expect.arrayContaining(["Dana Whitfield", "Lina Farah"]));
    expect(team).not.toContain("Omar Haddad");
    // A masked exporter: masked contacts.
    const m = await make(masked, { format: "csv", label: "All", filters: {}, columns });
    const rows = csv((await download(masked, (m.json() as Made).export.id)).body);
    const dana = rows.find((r) => r[0] === "Dana Whitfield")!;
    expect(dana[3]).not.toContain("111 2233");
    expect(dana[3]).toMatch(/•/);
    // A hidden field is never a column, whatever the browser asks for.
    const role = (
      await h.ownerPool.query("SELECT role_id FROM user_roles WHERE user_id = $1", [maskedUser.id])
    ).rows[0];
    const field = (await h.ownerPool.query("SELECT id FROM field_definitions WHERE key = 'email'")).rows[0];
    await h.ownerPool.query(
      "INSERT INTO role_field_access (role_id, field_id, access) VALUES ($1, $2, 'hidden') ON CONFLICT DO NOTHING",
      [role.role_id, field.id],
    );
    await h.ownerPool.query("SELECT pg_notify('lume_rbac', '')");
    await h.waitForRbacNotify();
    const hidden = await make(masked, { format: "csv", label: "All", filters: {}, columns });
    expect(csv((await download(masked, (hidden.json() as Made).export.id)).body)[0]).toEqual([
      "Name",
      "Stage",
      "Owner",
      "Phone",
      "LUME ref",
    ]);
  });

  it("refuses a view with nothing in it, and one too big for one file", async () => {
    const none = await make(admin, {
      format: "csv",
      label: "Nobody",
      filters: { q: "no lead is called this" },
      columns,
    });
    expect(none.statusCode).toBe(422);
    expect(none.json().error.code).toBe("NOTHING_TO_EXPORT");
    setExportCapForTests(2);
    try {
      const big = await make(admin, { format: "csv", label: "All", filters: {}, columns });
      expect(big.statusCode).toBe(422);
      expect(big.json().error).toMatchObject({ code: "TOO_MANY" });
      expect(big.json().error.message).toMatch(/up to 2 leads in one file/);
    } finally {
      setExportCapForTests(null);
    }
  });

  it("is audited when made and on each download, and only its maker may download it", async () => {
    const made = (
      await make(admin, { format: "csv", label: "All leads", filters: {}, columns: ["name"] })
    ).json() as Made;
    await download(admin, made.export.id);
    await download(admin, made.export.id);
    const actions = (
      await h.pool.query(
        "SELECT action, diff FROM audit_log WHERE actor_user_id = $1 AND (diff->>'code') = $2 ORDER BY id",
        [adminUser.id, made.export.code],
      )
    ).rows;
    expect(actions.map((a) => a.action)).toEqual([
      "lead.export",
      "lead.export.download",
      "lead.export.download",
    ]);
    expect(actions[0].diff).toMatchObject({ rows: 4, format: "csv", label: "All leads" });
    expect((await download(teamLead, made.export.id)).statusCode).toBe(404);
    const row = (await h.pool.query("SELECT downloads FROM lead_exports WHERE id = $1", [made.export.id]))
      .rows[0];
    expect(row.downloads).toBe(2);
  });

  it("expires after 24 hours: the file goes, the record stays (Review Focus 3)", async () => {
    const made = (
      await make(admin, { format: "csv", label: "All leads", filters: {}, columns: ["name"] })
    ).json() as Made;
    await h.ownerPool.query(
      "UPDATE lead_exports SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [made.export.id],
    );
    const gone = await download(admin, made.export.id);
    expect(gone.statusCode).toBe(410);
    expect(gone.json().error).toEqual({
      code: "EXPIRED",
      message: "This file has expired. Export the view again.",
    });
    const { clearExpiredExports } = await import("./service");
    expect(await clearExpiredExports(h.pool)).toBeGreaterThanOrEqual(1);
    const row = (
      await h.pool.query("SELECT file_enc IS NULL AS cleared, code FROM lead_exports WHERE id = $1", [
        made.export.id,
      ])
    ).rows[0];
    expect(row).toEqual({ cleared: true, code: made.export.code });
  });

  it("lists every export for people who manage security", async () => {
    const r = await admin.inject({ method: "GET", url: "/api/v1/leads/exports" });
    expect(r.statusCode).toBe(200);
    const first = r.json().exports[0];
    expect(first).toMatchObject({
      who: { name: expect.any(String) },
      code: expect.any(String),
      rows: expect.any(Number),
    });
    expect((await teamLead.inject({ method: "GET", url: "/api/v1/leads/exports" })).statusCode).toBe(403);
  });

  it("brought back in through an import: the real leads come in, the check row never does (Review Focus 5)", async () => {
    const made = (
      await make(admin, { format: "csv", label: "All leads", filters: {}, columns })
    ).json() as Made;
    const body = (await download(admin, made.export.id)).body.replace(/^\uFEFF/, "");
    const d = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/imports",
        payload: Buffer.from(body),
        headers: { "content-type": "application/octet-stream", "x-file-name": "back-in.csv" },
      })
    ).json();
    const draft = (await admin.inject({ method: "GET", url: `/api/v1/imports/${d.id}/draft` })).json();
    const refCol = (draft.headers as string[]).indexOf("LUME ref");
    expect(draft.mapping.columns[refCol]).toEqual({ column: refCol, to: "ignore" });
    expect((await admin.inject({ method: "POST", url: `/api/v1/imports/${d.id}/start` })).statusCode).toBe(
      200,
    );
    await h.runImports();
    // The four real leads come through (they already exist here, so they merge); the check row is refused.
    const imp = (await h.pool.query("SELECT created, merged, errors FROM imports WHERE id = $1", [d.id]))
      .rows[0];
    expect(imp.created + imp.merged).toBe(4);
    expect(imp.errors).toBe(1);
    const bad = (
      await h.pool.query("SELECT problems FROM import_rows WHERE import_id = $1 AND result = 'error'", [d.id])
    ).rows;
    expect(bad[0].problems[0]).toMatchObject({
      code: "LUME_CHECK_ROW",
      message: "A LUME export's check row: not a real lead",
    });
    const leads = await h.queryAll<{ email: string | null }>(
      "SELECT email FROM leads WHERE deleted_at IS NULL",
    );
    expect(leads.some((l) => /example\.invalid/.test(l.email ?? ""))).toBe(false);
  });
});
