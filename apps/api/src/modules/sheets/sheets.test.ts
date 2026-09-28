import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let bare: Harness; // a server with no Google key
let admin: AuthedClient;
let otherAdmin: AuthedClient;
let otherAdminId: string;
const HEAD = ["Timestamp", "Name", "Phone"];
const r = (i: number) => [
  `2026-09-${String(i).padStart(2, "0")} 09:30`,
  `Sheets Api ${i}`,
  `05088${String(i).padStart(5, "0")}`,
];
const link = (id: string, gid = 5) => `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}`;

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true });
  bare = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  const other = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  otherAdminId = other.id;
  otherAdmin = await h.signIn(other);
});
afterAll(async () => {
  await h.close();
  await bare.close();
});

const call = (
  c: AuthedClient,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
) =>
  c.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
/** A fresh spreadsheet in the fake, shared with LUME, and its id. */
function sheet(rows: string[][], shared = true) {
  const id = `1Sheet${newId().replace(/-/g, "")}`;
  h.fake!.put(id, {
    title: "Website enquiries",
    sharedWith: shared ? [h.fake!.email] : [],
    tabs: [{ sheetId: 5, title: "Form responses", rows: [HEAD, ...rows] }],
  });
  return id;
}
/** Draft → save, as the wizard does; returns the saved source. */
async function connect(c: AuthedClient, id: string, startFrom: "all" | "new" = "all") {
  const d = await call(c, "POST", "/api/v1/sheets/drafts", { link: link(id), sheetId: 5 });
  expect(d.statusCode).toBe(201);
  const saved = await call(c, "POST", "/api/v1/sheets/sources", {
    importId: d.json().draft.id,
    name: "Website enquiries",
    pollSeconds: 120,
    startFrom,
  });
  expect(saved.statusCode).toBe(201);
  return saved.json();
}

describe("the Sheets module", () => {
  it("is off by default, and can't be switched on without a Google key", async () => {
    const b = await bare.signIn(await bare.seedUser({ grants: ALL_GRANTS, totp: true }));
    expect((await call(b, "GET", "/api/v1/integrations")).json()).toEqual({
      googleSheets: { enabled: false, available: false, email: null, connectWithGoogle: false },
      webhooks: { enabled: false, manychat: false },
    });
    const off = await call(b, "PUT", "/api/v1/integrations/google-sheets", { enabled: true });
    expect(off.statusCode).toBe(409);
    expect(off.json().error.code).toBe("NOT_CONFIGURED");
    expect(
      (await call(admin, "POST", "/api/v1/sheets/inspect", { link: link("x".repeat(30)) })).json().error.code,
    ).toBe("SHEETS_OFF");
  });

  it("switches on, audited, and shows the email to share sheets with", async () => {
    expect(
      (await call(admin, "PUT", "/api/v1/integrations/google-sheets", { enabled: true })).statusCode,
    ).toBe(200);
    expect((await call(admin, "GET", "/api/v1/integrations")).json()).toEqual({
      googleSheets: { enabled: true, available: true, email: h.fake!.email, connectWithGoogle: false },
      webhooks: { enabled: false, manychat: false },
    });
    const [a] = await h.queryAll<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'integration.enabled'",
    );
    expect(a).toBeDefined();
  });
});

describe("connecting a sheet", () => {
  it("inspect: a bad link, an unshared sheet (naming the email), and a readable one", async () => {
    expect(
      (await call(admin, "POST", "/api/v1/sheets/inspect", { link: "https://example.com" })).json().error
        .code,
    ).toBe("LINK_INVALID");
    const locked = await call(admin, "POST", "/api/v1/sheets/inspect", { link: link(sheet([r(1)], false)) });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toMatchObject({ code: "SHEET_NO_ACCESS" });
    expect(locked.json().error.message).toContain(h.fake!.email);
    const ok = (await call(admin, "POST", "/api/v1/sheets/inspect", { link: link(sheet([r(1)])) })).json();
    expect(ok).toMatchObject({
      title: "Website enquiries",
      gid: 5,
      tabs: [{ sheetId: 5, title: "Form responses" }],
    });
  });

  it("a draft reads the tab through the 2A steps; saving with every row imports them all", async () => {
    const id = sheet([r(1), r(2)]);
    const d = (await call(admin, "POST", "/api/v1/sheets/drafts", { link: link(id), sheetId: 5 })).json();
    expect(d.sheet).toMatchObject({
      title: "Website enquiries",
      tabTitle: "Form responses",
      moreRows: false,
      editing: null,
    });
    expect(d.draft).toMatchObject({ headers: HEAD, rowCount: 2, headerRow: 1 });
    expect(d.draft.mapping.columns.find((c: { column: number }) => c.column === 1)).toMatchObject({
      to: "field",
      field: "name",
    });
    // The 2A endpoints work on it unchanged.
    expect((await call(admin, "POST", `/api/v1/imports/${d.draft.id}/preview`, {})).statusCode).toBe(200);
    const saved = (
      await call(admin, "POST", "/api/v1/sheets/sources", {
        importId: d.draft.id,
        name: "Site form",
        pollSeconds: 300,
        startFrom: "all",
      })
    ).json();
    expect(saved).toMatchObject({ name: "Site form", status: "active", pollSeconds: 300, syncing: true });
    expect(await h.queryAll("SELECT 1 FROM imports WHERE id = $1", [d.draft.id])).toHaveLength(0);
    await h.runSyncs();
    const list = (await call(admin, "GET", "/api/v1/sheets/sources")).json().sources;
    expect(list.find((s: { id: string }) => s.id === saved.id)).toMatchObject({
      newToday: 2,
      newAllTime: 2,
      problems: 0,
      syncing: false,
    });
    // Sheet drafts never show up among imports.
    expect(
      (await call(admin, "GET", "/api/v1/imports"))
        .json()
        .imports.some((i: { id: string }) => i.id === d.draft.id),
    ).toBe(false);
  });

  it("“only rows from now on” imports nothing that was already there", async () => {
    const id = sheet([r(3), r(4)]);
    const s = await connect(admin, id, "new");
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({
      newAllTime: 0,
    });
    h.fake!.append(id, "Form responses", [r(5)]);
    await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`);
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({
      newAllTime: 1,
    });
  });

  it("a brand-new form sheet with only its header can be connected, and its first row comes in", async () => {
    const id = sheet([]);
    const d = await call(admin, "POST", "/api/v1/sheets/drafts", { link: link(id), sheetId: 5 });
    expect(d.statusCode).toBe(201);
    expect(d.json().draft).toMatchObject({ headers: HEAD, rowCount: 0 });
    const saved = await call(admin, "POST", "/api/v1/sheets/sources", {
      importId: d.json().draft.id,
      name: "Fresh form",
      pollSeconds: 120,
      startFrom: "all",
    });
    expect(saved.statusCode).toBe(201);
    await h.runSyncs();
    h.fake!.append(id, "Form responses", [r(13)]);
    await call(admin, "POST", `/api/v1/sheets/sources/${saved.json().id}/sync`);
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${saved.json().id}`)).json()).toMatchObject({
      newAllTime: 1,
    });
  });

  it("the same tab can't be connected twice", async () => {
    const id = sheet([r(6)]);
    await connect(admin, id);
    const d = (await call(admin, "POST", "/api/v1/sheets/drafts", { link: link(id), sheetId: 5 })).json();
    const again = await call(admin, "POST", "/api/v1/sheets/sources", {
      importId: d.draft.id,
      name: "Twice",
      pollSeconds: 120,
      startFrom: "all",
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("SHEET_ALREADY_CONNECTED");
  });

  it("someone who can manage integrations but not import leads can't connect a sheet", async () => {
    const setter = await h.signIn(
      await h.seedUser({ grants: [{ key: "integrations.manage", scope: "all" }], totp: true }),
    );
    const d = await call(setter, "POST", "/api/v1/sheets/drafts", { link: link(sheet([r(7)])), sheetId: 5 });
    expect(d.statusCode).toBe(403);
    expect(d.json().error.code).toBe("CANNOT_IMPORT");
  });
});

describe("looking after a sheet", () => {
  it("Review Focus 5: a renamed column is fixed by editing the columns; whoever saves takes it over", async () => {
    const id = sheet([r(8)]);
    const s = await connect(admin, id);
    await h.runSyncs();
    h.fake!.setRows(id, "Form responses", [["Timestamp", "Full name", "Phone"], r(8), r(9)]);
    await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`);
    await h.runSyncs();
    const paused = (await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json();
    expect(paused).toMatchObject({ status: "needs_attention", attention: { code: "COLUMNS_CHANGED" } });
    expect((await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`)).json().error.code).toBe(
      "NEEDS_EDIT",
    );
    const edit = (await call(otherAdmin, "POST", "/api/v1/sheets/drafts", { sourceId: s.id })).json();
    expect(edit.sheet.editing).toBe(s.id);
    expect(edit.draft.headers).toEqual(["Timestamp", "Full name", "Phone"]);
    const saved = await call(otherAdmin, "POST", "/api/v1/sheets/sources", {
      importId: edit.draft.id,
      name: s.name,
      pollSeconds: 120,
      startFrom: "all",
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      id: s.id,
      status: "active",
      attention: null,
      runAs: { id: otherAdminId },
    });
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({
      newAllTime: 2,
    });
    expect((await h.queryAll("SELECT config_version FROM lead_sources WHERE id = $1", [s.id]))[0]).toEqual({
      config_version: 2,
    });
  });

  it("Critical (final review): editing which columns recognise a row never re-imports what was there", async () => {
    const id = sheet([r(20), r(21), r(22)]);
    const s = await connect(admin, id);
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({
      newAllTime: 3,
    });
    // Edit: stop using the Timestamp column (it was part of how rows are recognised).
    const edit = (await call(admin, "POST", "/api/v1/sheets/drafts", { sourceId: s.id })).json();
    const mapping = {
      ...edit.draft.mapping,
      columns: edit.draft.mapping.columns.map((c: { column: number }) =>
        c.column === 0 ? { column: 0, to: "ignore" } : c,
      ),
    };
    expect((await call(admin, "PATCH", `/api/v1/imports/${edit.draft.id}`, { mapping })).statusCode).toBe(
      200,
    );
    await call(admin, "POST", "/api/v1/sheets/sources", {
      importId: edit.draft.id,
      name: s.name,
      pollSeconds: 120,
      startFrom: "all",
    });
    await h.runSyncs();
    const leads = await h.queryAll<{ id: string }>(
      "SELECT id FROM leads WHERE source_id = $1 AND deleted_at IS NULL",
      [s.id],
    );
    expect(leads).toHaveLength(3);
    const again = await h.queryAll(
      "SELECT 1 FROM activities WHERE type = 'imported_again' AND lead_id = ANY($1)",
      [leads.map((l) => l.id)],
    );
    expect(again).toHaveLength(0);
    // …and a row added after the edit still comes in.
    h.fake!.append(id, "Form responses", [r(23)]);
    await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`);
    await h.runSyncs();
    expect(
      await h.queryAll("SELECT 1 FROM leads WHERE source_id = $1 AND deleted_at IS NULL", [s.id]),
    ).toHaveLength(4);
  });

  it("pause, resume, remove (leads keep their source), and Test again after access comes back", async () => {
    const id = sheet([r(10)]);
    const s = await connect(admin, id);
    await h.runSyncs();
    expect(
      (await call(admin, "PATCH", `/api/v1/sheets/sources/${s.id}`, { paused: true })).json().status,
    ).toBe("paused");
    expect((await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`)).json().error.code).toBe(
      "NOT_ACTIVE",
    );
    expect(
      (
        await call(admin, "PATCH", `/api/v1/sheets/sources/${s.id}`, { paused: false, pollSeconds: 600 })
      ).json(),
    ).toMatchObject({ status: "active", pollSeconds: 600 });
    h.fake!.unshare(id);
    h.fake!.append(id, "Form responses", [r(11)]);
    await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`);
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json().attention.code).toBe(
      "ACCESS_LOST",
    );
    h.fake!.share(id);
    expect((await call(admin, "POST", `/api/v1/sheets/sources/${s.id}/sync`)).statusCode).toBe(200); // Test again
    await h.runSyncs();
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({
      status: "active",
      newAllTime: 2,
    });
    expect((await call(admin, "DELETE", `/api/v1/sheets/sources/${s.id}`)).statusCode).toBe(204);
    expect(
      (await call(admin, "GET", "/api/v1/sheets/sources"))
        .json()
        .sources.some((x: { id: string }) => x.id === s.id),
    ).toBe(false);
    expect(
      await h.queryAll("SELECT 1 FROM leads WHERE source_id = $1 AND deleted_at IS NULL", [s.id]),
    ).toHaveLength(2);
  });

  it("a sheet's raw rows are shown only to whoever runs it or sees every contact (finding 8)", async () => {
    const id = sheet([r(30), ["not a date", "Hidden Row", "0508800031"]]);
    const s = await connect(admin, id);
    await h.runSyncs();
    const masked = await h.signIn(
      await h.seedUser({
        grants: [
          { key: "integrations.manage", scope: null },
          { key: "leads.import", scope: null },
          { key: "leads.view", scope: "all" },
        ],
        totp: true,
      }),
    );
    const csv = await call(masked, "GET", `/api/v1/sheets/sources/${s.id}/problems.csv`);
    expect(csv.statusCode).toBe(403);
    expect(csv.json().error.code).toBe("ROWS_HIDDEN");
    expect((await call(masked, "POST", "/api/v1/sheets/drafts", { sourceId: s.id })).json().error.code).toBe(
      "ROWS_HIDDEN",
    );
    expect((await call(masked, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({
      canSeeRows: false,
    });
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json()).toMatchObject({
      canSeeRows: true,
    });
  });

  it("problem rows are listed, downloadable, and can be dismissed", async () => {
    const id = sheet([r(12), ["not a date", "Broken Row", "0508800013"]]);
    const s = await connect(admin, id);
    await h.runSyncs();
    const detail = (await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json();
    expect(detail.problems).toBe(1);
    expect(detail.problemRows).toMatchObject([
      { rowNumber: 3, problems: [{ code: expect.stringMatching(/DATE/) }] },
    ]);
    expect(detail.syncs[0]).toMatchObject({ status: "done", created: 1, errors: 1 });
    const csv = await call(admin, "GET", `/api/v1/sheets/sources/${s.id}/problems.csv`);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.body).toContain("Broken Row");
    const gone = await call(
      admin,
      "POST",
      `/api/v1/sheets/sources/${s.id}/rows/${detail.problemRows[0].id}/dismiss`,
    );
    expect(gone.statusCode).toBe(204);
    expect((await call(admin, "GET", `/api/v1/sheets/sources/${s.id}`)).json().problems).toBe(0);
  });
});
