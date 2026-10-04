import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
const csv = (s: string) => Buffer.from(s, "utf8");
const upload = (c: AuthedClient, body: Buffer, name = "leads.csv") =>
  c.inject({
    method: "POST",
    url: "/api/v1/imports",
    payload: body,
    headers: { "content-type": "application/octet-stream", "x-file-name": name },
  });

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("upload", () => {
  it("reads the file, suggests a mapping and default rules, and keeps the file sealed", async () => {
    const r = await upload(admin, csv("Full name,Mobile,Email\nAisha Khan,050 123 4567,a@x.com\n"));
    expect(r.statusCode, r.body).toBe(201);
    const d = r.json();
    expect(d).toMatchObject({
      status: "draft",
      fileName: "leads.csv",
      rowCount: 1,
      encoding: "utf-8",
      delimiter: ",",
      headerRow: 1,
    });
    expect(d.mapping.columns.map((c: { field?: string }) => c.field)).toEqual(["name", "phone", "email"]);
    expect(d.rules).toMatchObject({ onMatch: "merge", noName: "use_contact" });
    const row = (await h.pool.query("SELECT file_enc FROM imports WHERE id = $1", [d.id])).rows[0];
    expect(row.file_enc.toString("utf8")).not.toContain("Aisha"); // encrypted at rest
  });

  it("refuses unreadable files with a specific code", async () => {
    expect((await upload(admin, csv(""))).json().error.code).toBe("FILE_EMPTY");
    expect((await upload(admin, csv("a,b\n1,2\n"), "leads.xlsx")).json().error.code).toBe("NOT_CSV_EXCEL");
    const big = await upload(admin, Buffer.alloc(10_485_761, 0x41));
    expect([400, 413]).toContain(big.statusCode);
  });

  it("warns when the same file was imported before", async () => {
    const body = csv("Name\nOnce\n");
    const first = (await upload(admin, body)).json();
    await h.pool.query(
      "UPDATE imports SET status = 'done', finished_at = now(), started_by = created_by WHERE id = $1",
      [first.id],
    );
    expect((await upload(admin, body)).json().alreadyImported).toMatchObject({ by: expect.any(String) });
  });

  it("needs Import leads", async () => {
    const rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] }));
    expect((await upload(rep, csv("Name\nA\n"))).statusCode).toBe(403);
  });
});

describe("settings and preview", () => {
  it("re-reads the file when the header row changes, and re-suggests the mapping", async () => {
    const d = (await upload(admin, csv("Export of March\nName,Phone\nA,0501234567\n"))).json();
    expect(d.headerRow).toBe(2);
    const p = (
      await admin.inject({ method: "PATCH", url: `/api/v1/imports/${d.id}`, payload: { headerRow: 1 } })
    ).json();
    expect(p.headers).toEqual(["Export of March"]);
    expect(p.mapping.columns.map((c: { to: string }) => c.to)).toEqual(["ignore"]);
  });

  it("previews the first rows: create, merge into a visible lead, repeats within the file, errors", async () => {
    const owner = await h.seedUser({ grants: ALL_GRANTS, name: "Leila Haddad" });
    await h.seedLead({ name: "Already Here", ownerId: owner.id, phone: "+971501112222" });
    const d = (
      await upload(
        admin,
        csv(
          "Name,Phone,Stage\nNew Person,0503334444,New\nAgain,050 111 2222,New\nTwice,0503334444,New\nBad,0505556666,Proposal Sent\n,,\nLast,0509990000,New\n",
        ),
      )
    ).json();
    const p = (
      await admin.inject({ method: "POST", url: `/api/v1/imports/${d.id}/preview`, payload: {} })
    ).json();
    // A blank row mid-file is reported as empty (trailing blank rows are dropped when the file is read).
    expect(p.rows.map((r: { outcome: string }) => r.outcome)).toEqual([
      "create",
      "merge",
      "merge",
      "error",
      "empty",
      "create",
    ]);
    expect(p.rows[1].mergeInto).toMatchObject({
      visible: true,
      name: "Already Here",
      ownerName: "Leila Haddad",
    });
    expect(p.rows[2].mergeInto).toEqual({ row: 2 }); // the first "New Person" row
    expect(p.rows[3].problems[0].code).toBe("STAGE_UNKNOWN");
    expect(p.summary).toMatchObject({ create: 2, merge: 2, error: 1, empty: 1 });
  });

  it("Review Focus 5: a merge into a lead the importer can't see stays anonymous", async () => {
    const importer = await h.signIn(
      await h.seedUser({
        grants: [
          { key: "leads.view", scope: "own" },
          { key: "leads.create", scope: null },
          { key: "leads.import", scope: null },
        ],
      }),
    );
    const other = await h.seedUser({ grants: ALL_GRANTS, name: "Someone Else" });
    await h.seedLead({ name: "Private Lead", ownerId: other.id, phone: "+971507778888" });
    const d = (await upload(importer, csv("Name,Phone\nX,0507778888\n"))).json();
    const p = (
      await importer.inject({ method: "POST", url: `/api/v1/imports/${d.id}/preview`, payload: {} })
    ).json();
    expect(p.rows[0]).toMatchObject({ outcome: "merge", mergeInto: { visible: false } });
    expect(JSON.stringify(p)).not.toContain("Private Lead");
    expect(JSON.stringify(p)).not.toContain("Someone Else");
  });

  it("shows unmatched values per column and blocks on a date column it can't read", async () => {
    const d = (
      await upload(admin, csv("Name,Date,Stage\nA,13/03/2026,Hot lead\nB,03/13/2026,Hot lead\n"))
    ).json();
    expect(d.analysis[2].unmatched).toEqual([{ value: "Hot lead", rows: 2 }]);
    expect(d.problems.map((p: { code: string }) => p.code)).toContain("DATE_ORDER_NEEDED");
  });

  it("keeps a draft to the person who uploaded it", async () => {
    const d = (await upload(admin, csv("Name\nA\n"))).json();
    const other = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
    expect((await other.inject({ method: "GET", url: `/api/v1/imports/${d.id}` })).statusCode).toBe(404);
    expect((await other.inject({ method: "DELETE", url: `/api/v1/imports/${d.id}` })).statusCode).toBe(404);
    const ids = (list: { imports: { id: string }[] }) => list.imports.map((i) => i.id);
    expect(ids((await other.inject({ method: "GET", url: "/api/v1/imports" })).json())).not.toContain(d.id);
    expect(ids((await admin.inject({ method: "GET", url: "/api/v1/imports" })).json())).toContain(d.id);
    expect((await admin.inject({ method: "DELETE", url: `/api/v1/imports/${d.id}` })).statusCode).toBe(204);
  });
});

describe("the finished report (owner, 2026-10-05: 12,000 imported, New today said 7)", () => {
  it("says how many came with their own enquiry date, and from when to when", async () => {
    const d = (await upload(admin, csv("Name\nA\nB\nC\n"))).json();
    const leads = [
      await h.seedLead({ ownerId: null, name: "Old enquiry" }),
      await h.seedLead({ ownerId: null, name: "Older enquiry" }),
      await h.seedLead({ ownerId: null, name: "No date" }),
    ];
    await h.queryAll("UPDATE leads SET lead_created_at = '2024-06-10' WHERE id = $1", [leads[0]]);
    await h.queryAll("UPDATE leads SET lead_created_at = '2025-02-01' WHERE id = $1", [leads[1]]);
    for (const [i, id] of leads.entries())
      await h.queryAll(
        "INSERT INTO import_rows (import_id, row_index, result, lead_id) VALUES ($1, $2, 'created', $3)",
        [d.id, i + 1, id],
      );
    await h.queryAll(
      "UPDATE imports SET status = 'done', finished_at = now(), started_by = created_by, created = 3 WHERE id = $1",
      [d.id],
    );
    const r = (await admin.inject({ method: "GET", url: `/api/v1/imports/${d.id}` })).json();
    expect(r.dated).toEqual({ n: 2, from: "2024-06-10", to: "2025-02-01" });
  });
});
