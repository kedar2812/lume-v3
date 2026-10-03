import ExcelJS from "exceljs";
import Papa from "papaparse";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { setTraceInflateCapForTests } from "./trace";

/** Phase 6B Task 3: give LUME a file found outside the business, and it says whose export it was. */
let h: Harness;
let admin: AuthedClient;
let adminUser: SeededUser;
let exporterOnly: AuthedClient;

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  adminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Hana Ito" });
  admin = await h.signIn(adminUser);
  exporterOnly = await h.signIn(
    await h.seedUser({
      grants: [
        { key: "leads.view", scope: "all" },
        { key: "leads.export", scope: null },
      ],
      totp: true,
      name: "Ed Exporter",
    }),
  );
  for (const [name, phone, email] of [
    ["Dana Whitfield", "+971501112233", "dana@example.com"],
    ["Lina Farah", "+971502223344", "lina@example.com"],
    ["Omar Haddad", "+971503334455", "omar@example.com"],
  ] as const)
    await h.seedLead({ ownerId: adminUser.id, name, phone, email });
});
afterAll(() => h.close());

type Made = { id: string; code: string };
async function exportOf(format: "csv" | "xlsx", columns = ["name", "phone", "email"]) {
  const made = (
    await admin.inject({
      method: "POST",
      url: "/api/v1/leads/export",
      payload: { format, label: "Hot leads", filters: {}, columns },
    })
  ).json().export as Made;
  const file = await admin.inject({ method: "GET", url: `/api/v1/leads/exports/${made.id}/download` });
  return { made, body: file.body, raw: file.rawPayload };
}
const trace = (body: Buffer | string, name = "found.csv") =>
  admin.inject({
    method: "POST",
    url: "/api/v1/security/trace",
    headers: { "content-type": "application/octet-stream", "x-file-name": name },
    payload: typeof body === "string" ? Buffer.from(body, "utf8") : body,
  });
const lookUp = (code: string) =>
  admin.inject({ method: "POST", url: "/api/v1/security/trace", payload: { code } });
const parse = (body: string) =>
  Papa.parse<string[]>(body.replace(/^\uFEFF/, ""), { skipEmptyLines: true }).data;
const unparse = (rows: string[][], delimiter = ",") => Papa.unparse(rows, { delimiter });

describe("Trace a file (6B Task 3)", () => {
  it("finds the export by its LUME ref column, and says who, when, what and every download", async () => {
    const { made, body } = await exportOf("csv");
    const r = await trace(body);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().match).toMatchObject({
      code: made.code,
      who: { name: "Hana Ito" },
      label: "Hot leads",
      rows: 3,
      format: "csv",
      foundBy: "column",
      downloads: [{ at: expect.any(String), device: expect.any(String) }],
    });
  });

  it("finds it by the check row when the column was deleted and the rows re-sorted (Review Focus 2)", async () => {
    const { made, body } = await exportOf("csv");
    const rows = parse(body).map((r) => r.slice(0, -1));
    const [head, ...rest] = rows;
    rest.sort((a, b) => a[0]!.localeCompare(b[0]!)).reverse();
    const r = await trace(unparse([head!, ...rest]));
    expect(r.json().match).toMatchObject({ code: made.code, foundBy: "check_row" });
  });

  it("reads Excel too, with the column gone", async () => {
    const { made, raw } = await exportOf("xlsx");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(raw as unknown as ArrayBuffer);
    book.getWorksheet("Leads")!.spliceColumns(4, 1); // LUME ref was the 4th column
    const out = Buffer.from(await book.xlsx.writeBuffer());
    const r = await trace(out, "copy.xlsx");
    expect(r.json().match).toMatchObject({ code: made.code, foundBy: "check_row" });
  });

  it("copes with a semicolon file with extra columns in front", async () => {
    const { made, body } = await exportOf("csv");
    const rows = parse(body).map((r, i) => [i === 0 ? "Notes" : "called twice", ...r.slice(0, -1)]);
    const r = await trace(unparse(rows, ";"));
    expect(r.json().match).toMatchObject({ code: made.code, foundBy: "check_row" });
  });

  it("finds it by the check row's phone alone, when that number names one export", async () => {
    const { made, body } = await exportOf("csv", ["name", "phone"]);
    const rows = parse(body).map((r) => r.slice(0, -1));
    await h.ownerPool.query("UPDATE lead_exports SET check_phone = check_phone WHERE id = $1", [made.id]);
    const r = await trace(unparse(rows));
    const dup = (
      await h.pool.query(
        "SELECT count(*)::int AS n FROM lead_exports WHERE check_phone = (SELECT check_phone FROM lead_exports WHERE id = $1)",
        [made.id],
      )
    ).rows[0].n;
    if (dup === 1) expect(r.json().match).toMatchObject({ code: made.code, foundBy: "check_row" });
    else expect(r.json().match).toBeNull();
  });

  it("looks up a code however it's typed, and says plainly when nothing matches", async () => {
    const { made } = await exportOf("csv");
    const typed = made.code.toLowerCase().replace("-", " ");
    expect((await lookUp(typed)).json().match).toMatchObject({ code: made.code, foundBy: "column" });
    expect((await lookUp("ZZZZ-ZZZZ")).json()).toEqual({ match: null });
    expect((await lookUp("not a code")).statusCode).toBe(400);
    const plain = unparse([
      ["Name", "Phone"],
      ["Someone Else", "+971500000000"],
    ]);
    expect((await trace(plain)).json()).toEqual({ match: null });
  });

  it("a file mixing two exports' codes traces to the first", async () => {
    const a = await exportOf("csv");
    const b = await exportOf("csv");
    const rows = [...parse(a.body), ...parse(b.body).slice(1)];
    expect((await trace(unparse(rows))).json().match.code).toBe(a.made.code);
  });

  it("refuses what isn't a spreadsheet in LUME's words, and anything over 10 MB", async () => {
    const pdf = await trace(Buffer.from("%PDF-1.7\n\u0000\u0001binary"), "report.pdf");
    expect(pdf.statusCode).toBe(400);
    expect(pdf.json().error).toEqual({
      code: "UNREADABLE",
      message: "LUME can't read this file. Give it a CSV or Excel file.",
    });
    const big = await trace(Buffer.alloc(10 * 1024 * 1024 + 10, 65));
    expect(big.statusCode).toBe(413);
  });

  it("is for people who manage security, keeps nothing, and is audited without the file", async () => {
    const { made, body } = await exportOf("csv");
    expect(
      (
        await exporterOnly.inject({
          method: "POST",
          url: "/api/v1/security/trace",
          payload: { code: made.code },
        })
      ).statusCode,
    ).toBe(403);
    const before = (await h.pool.query("SELECT count(*)::int AS n FROM lead_exports")).rows[0].n;
    await trace(body);
    expect((await h.pool.query("SELECT count(*)::int AS n FROM lead_exports")).rows[0].n).toBe(before);
    const audit = (
      await h.pool.query(
        "SELECT diff FROM audit_log WHERE action = 'security.trace' AND actor_user_id = $1 ORDER BY id DESC LIMIT 1",
        [adminUser.id],
      )
    ).rows[0];
    expect(audit.diff).toEqual({ found: made.code });
    expect(JSON.stringify(audit.diff)).not.toMatch(/Dana|example\.com/);
  });
});

describe("the 6B review's fix pass (Trace)", () => {
  it("traces a CSV export bigger than an import may be (over 20,000 rows)", async () => {
    const { made, body } = await exportOf("csv");
    const [header, first] = parse(body);
    const rows = [header!, ...Array.from({ length: 20_001 }, () => first!)];
    const r = await trace(unparse(rows));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().match).toMatchObject({ code: made.code, foundBy: "column" });
  });

  it("answers, never crashes, on cells that only look like a check row", async () => {
    const { made, body } = await exportOf("csv");
    const rows = parse(body).map((r) => r.slice(0, -1));
    const hostile = [
      'a"b{c}@example.invalid',
      ",@example.invalid",
      "x,y@example.invalid",
      "@example.invalid",
    ];
    const r = await trace(unparse([...rows, hostile]));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().match).toMatchObject({ code: made.code, foundBy: "check_row" });
    const none = await trace(
      unparse([
        ["Name", "Email"],
        ["X", 'q"}{@example.invalid'],
      ]),
    );
    expect(none.statusCode, none.body).toBe(200);
    expect(none.json().match).toBeNull();
  });

  it("refuses an Excel file that opens to more than LUME reads, before opening it", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Leads");
    for (let i = 0; i < 3000; i++) sheet.addRow([`Lead number ${i}`, "the same words over and over again"]);
    const big = Buffer.from(await book.xlsx.writeBuffer());
    setTraceInflateCapForTests(64 * 1024);
    try {
      const r = await trace(big, "big.xlsx");
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.code).toBe("TOO_BIG");
      // A small one still reads under the same cap.
      const { made, raw } = await exportOf("xlsx");
      const ok = await trace(raw, "small.xlsx");
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().match).toMatchObject({ code: made.code });
    } finally {
      setTraceInflateCapForTests(null);
    }
  });
});
