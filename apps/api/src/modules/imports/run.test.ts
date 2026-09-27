import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
const upload = async (c: AuthedClient, text: string, name = "leads.csv") =>
  (
    await c.inject({
      method: "POST",
      url: "/api/v1/imports",
      payload: Buffer.from(text),
      headers: { "content-type": "application/octet-stream", "x-file-name": name },
    })
  ).json();
const start = (c: AuthedClient, id: string) =>
  c.inject({ method: "POST", url: `/api/v1/imports/${id}/start` });
// Lead tables are under row-level security: read them with full scope.
const leadsNamed = (name: string) =>
  h.queryAll<Record<string, unknown> & { id: string }>(
    "SELECT *, lead_created_at::text AS created_on FROM leads WHERE name = $1 AND deleted_at IS NULL",
    [name],
  );
const imp = async (id: string) => (await h.pool.query("SELECT * FROM imports WHERE id = $1", [id])).rows[0];

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("a run", () => {
  it("creates leads with their source, date, stage and an imported activity, and counts everything", async () => {
    const d = await upload(
      admin,
      "Name,Phone,Date,Stage\nAisha Khan,050 123 4567,04/03/2026,Contacted\n,,,\nBad,0501,01/01/2099,New\n",
    );
    expect((await start(admin, d.id)).statusCode).toBe(200);
    await h.runImports();
    const done = await imp(d.id);
    expect(done).toMatchObject({ status: "done", created: 1, errors: 1, empty: 1 });
    const [lead] = await leadsNamed("Aisha Khan");
    expect(lead).toMatchObject({
      phone_e164: "+971501234567",
      created_on: "2026-03-04",
      source_id: done.source_id,
    });
    const acts = await h.queryAll<{ type: string }>("SELECT type FROM activities WHERE lead_id = $1", [
      lead!.id,
    ]);
    expect(acts.map((a) => a.type)).toContain("imported");
  });

  it("Review Focus 2: the same number written two ways merges into one lead", async () => {
    const d = await upload(
      admin,
      "Name,Phone,Email\nZoe Park,+971 50 222 3333,\nZoe P,050 222 3333,zoe@x.com\n",
    );
    await start(admin, d.id);
    await h.runImports();
    expect(await leadsNamed("Zoe Park")).toHaveLength(1);
    expect(await leadsNamed("Zoe P")).toHaveLength(0);
    expect((await leadsNamed("Zoe Park"))[0]!.email).toBe("zoe@x.com"); // filled by the merge
    expect(await imp(d.id)).toMatchObject({ created: 1, merged: 1 });
  });

  it("re-importing the same file creates nothing new, and never overwrites", async () => {
    const text = "Name,Phone,Value\nRe Import,0504445555,100\n";
    const a = await upload(admin, text);
    await start(admin, a.id);
    await h.runImports();
    await h.queryAll("UPDATE leads SET value = 999 WHERE name = 'Re Import'");
    const b = await upload(admin, text);
    expect(b.alreadyImported).not.toBeNull();
    await start(admin, b.id);
    await h.runImports();
    expect(await leadsNamed("Re Import")).toHaveLength(1);
    expect(Number((await leadsNamed("Re Import"))[0]!.value)).toBe(999);
    expect(await imp(b.id)).toMatchObject({ created: 0, merged: 1 });
  });

  it("Review Focus 4: start twice runs once", async () => {
    const d = await upload(admin, "Name\nOnly Once\n");
    const [a, b] = await Promise.all([start(admin, d.id), start(admin, d.id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    await h.runImports();
    expect(await leadsNamed("Only Once")).toHaveLength(1);
  });

  it("Review Focus 3: start re-validates against today's fields", async () => {
    const f = (
      await admin.inject({
        method: "POST",
        url: "/api/v1/fields",
        payload: { key: "tier", label: "Tier", type: "text" },
      })
    ).json().field;
    const d = await upload(admin, "Name,Tier\nA,Gold\n");
    expect(d.mapping.columns[1].field).toBe("tier");
    await admin.inject({ method: "POST", url: `/api/v1/fields/${f.id}/archive` });
    const r = await start(admin, d.id);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("MAPPING_INVALID");
    expect((await imp(d.id)).status).toBe("draft");
  });

  it("resumes after a crash without writing any row twice", async () => {
    const lines = Array.from({ length: 450 }, (_, i) => `Crash ${i},05${String(10000000 + i)}`).join("\n");
    const d = await upload(admin, `Name,Phone\n${lines}\n`);
    await start(admin, d.id);
    await h.runImports({ crashAfterRows: 230 }); // throws out of the runner after 230 committed rows
    expect((await imp(d.id)).created).toBe(230);
    await h.runImports(); // pg-boss's retry
    expect(await imp(d.id)).toMatchObject({ status: "done", created: 450 });
    const rows = await h.pool.query("SELECT count(*)::int AS n FROM import_rows WHERE import_id = $1", [
      d.id,
    ]);
    expect(rows.rows[0].n).toBe(450);
  });

  it("cancels before the next batch, and resumes the rest", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `Cancel ${i}`).join("\n");
    const d = await upload(admin, `Name\n${lines}\n`);
    await start(admin, d.id);
    await h.runImports({
      beforeBatch: async (n) => {
        if (n === 1) await admin.inject({ method: "POST", url: `/api/v1/imports/${d.id}/cancel` });
      },
    });
    expect(await imp(d.id)).toMatchObject({ status: "cancelled", created: 200 });
    expect((await admin.inject({ method: "POST", url: `/api/v1/imports/${d.id}/resume` })).statusCode).toBe(
      200,
    );
    await h.runImports();
    expect(await imp(d.id)).toMatchObject({ status: "done", created: 300 });
  });

  it("stops when the importer loses Import leads", async () => {
    const person = await h.seedUser({ grants: [...ALL_GRANTS], totp: true });
    const c = await h.signIn(person);
    const d = await upload(c, `Name\n${Array.from({ length: 250 }, (_, i) => `Access ${i}`).join("\n")}\n`);
    await start(c, d.id);
    await h.runImports({
      beforeBatch: async (n) => {
        if (n === 1) await h.revokeGrant(person.id, "leads.import");
      },
    });
    expect(await imp(d.id)).toMatchObject({
      status: "stopped_access",
      stop_reason: "access_changed",
      created: 200,
    });
  });

  it("two imports racing on the same contact make one lead", async () => {
    const a = await upload(admin, "Name,Email\nRace One,race@x.com\n");
    const b = await upload(admin, "Name,Email\nRace Two,race@x.com\n");
    await start(admin, a.id);
    await start(admin, b.id);
    await h.runImports({ parallel: true });
    const [n] = await h.queryAll<{ n: number }>(
      "SELECT count(*)::int AS n FROM leads WHERE email = 'race@x.com'",
    );
    expect(n!.n).toBe(1);
  });

  it("gives created leads the owner rule by turns, and never re-owns a merge", async () => {
    const p1 = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Turn One" });
    const p3 = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Turn Three" });
    const d = await upload(admin, "Name,Email\nRR A,rra@x.com\nRR B,rrb@x.com\nRR C,rrc@x.com\n");
    await admin.inject({
      method: "PATCH",
      url: `/api/v1/imports/${d.id}`,
      payload: { rules: { ...d.rules, owner: { mode: "round_robin", userIds: [p1.id, p3.id] } } },
    });
    await start(admin, d.id);
    await h.runImports();
    const owners = await h.queryAll<{ owner_id: string }>(
      "SELECT owner_id FROM leads WHERE name LIKE 'RR %' ORDER BY name",
    );
    expect(owners.map((r) => r.owner_id)).toEqual([p1.id, p3.id, p1.id]);
    // Importing the same people again merges: the turns never move a lead to someone else.
    const again = await upload(admin, "Name,Email\nRR A,rra@x.com\n");
    await admin.inject({
      method: "PATCH",
      url: `/api/v1/imports/${again.id}`,
      payload: { rules: { ...again.rules, owner: { mode: "round_robin", userIds: [p3.id] } } },
    });
    await start(admin, again.id);
    await h.runImports();
    const [a] = await h.queryAll<{ owner_id: string }>("SELECT owner_id FROM leads WHERE name = 'RR A'");
    expect(a!.owner_id).toBe(p1.id);
  });

  it("the report lists failed rows as CSV, safe to open in Excel", async () => {
    const d = await upload(admin, 'Name,Stage,Note\nGood,New,=1+2\nBad,Nowhere,=HYPERLINK("x")\n');
    await start(admin, d.id);
    await h.runImports();
    const r = await admin.inject({ method: "GET", url: `/api/v1/imports/${d.id}/errors.csv` });
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    expect(r.body.startsWith("﻿Problem,Name,Stage,Note")).toBe(true);
    expect(r.body).toContain("'=HYPERLINK");
    expect(r.body).not.toContain("Good");
  });

  it("lists rows for the person who ran it, and hides them from others", async () => {
    const d = await upload(admin, "Name,Stage\nListed,New\nNope,Nowhere\n");
    await start(admin, d.id);
    await h.runImports();
    const rows = (await admin.inject({ method: "GET", url: `/api/v1/imports/${d.id}/rows` })).json();
    expect(rows.rows.map((r: { result: string }) => r.result)).toEqual(["created", "error"]);
    expect(rows.rows[0].lead).toMatchObject({ visible: true, name: "Listed" });
    const rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.import", scope: null }] }));
    expect((await rep.inject({ method: "GET", url: `/api/v1/imports/${d.id}/rows` })).statusCode).toBe(403);
  });

  it("keeps extra numbers from a cell in the history, masked for anyone who sees masked contacts", async () => {
    const repUser = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const rep = await h.signIn(repUser);
    const d = await upload(admin, ["Name,Phone", "Two Numbers,050 111 2299 / 055 333 4499", ""].join("\n"));
    await admin.inject({
      method: "PATCH",
      url: `/api/v1/imports/${d.id}`,
      payload: { rules: { ...d.rules, owner: { mode: "user", userId: repUser.id } } },
    });
    await start(admin, d.id);
    await h.runImports();
    const [lead] = await leadsNamed("Two Numbers");
    const history = async (c: AuthedClient) =>
      (await c.inject({ method: "GET", url: `/api/v1/leads/${lead!.id}/activities` })).json().items;
    const repView = JSON.stringify(await history(rep));
    expect(repView).toContain("extraPhones");
    expect(repView).not.toMatch(/3334499|333 4499/);
    expect(JSON.stringify(await history(admin))).toContain("055 333 4499");
  });

  it("a row the database refuses is that row's problem, and the rest of the file still imports", async () => {
    const d = await upload(admin, ["Name", "Kept One", "Kept Two", "Refused Row", ""].join("\n"));
    await start(admin, d.id);
    await h.runImports({ breakRow: 4 }); // row 4 hits a real database error inside its transaction
    const done = await imp(d.id);
    expect(done).toMatchObject({ status: "done", created: 2, errors: 1 });
    const rows = await h.pool.query(
      "SELECT row_index, result, problems FROM import_rows WHERE import_id = $1 ORDER BY row_index",
      [d.id],
    );
    expect(rows.rows.map((r: { result: string }) => r.result)).toEqual(["created", "created", "error"]);
    expect(rows.rows[2].problems[0].code).toBe("ROW_NOT_SAVED");
    expect(await leadsNamed("Refused Row")).toHaveLength(0);
  });
});
