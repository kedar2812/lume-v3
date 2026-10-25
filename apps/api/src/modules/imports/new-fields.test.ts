import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

/**
 * Columns that become new fields (a lead ads export: 2026-10-22, its form questions came in as raw labels, an empty
 * column became a field, a budget came in as text): what each column holds, read from every row; an empty column says
 * so and makes no field; a new choice field takes its options from the column's own values.
 */
let h: Harness;
let admin: AuthedClient;
const upload = async (text: string) =>
  (
    await admin.inject({
      method: "POST",
      url: "/api/v1/imports",
      payload: Buffer.from(text),
      headers: { "content-type": "application/octet-stream", "x-file-name": "lead-ads.csv" },
    })
  ).json();
const patch = async (id: string, body: object) =>
  admin.inject({ method: "PATCH", url: `/api/v1/imports/${id}`, payload: body });
const start = (id: string) => admin.inject({ method: "POST", url: `/api/v1/imports/${id}/start` });
const leadNamed = async (name: string) =>
  (
    await h.queryAll<{ custom: Record<string, unknown> }>(
      "SELECT custom FROM leads WHERE name = $1 AND deleted_at IS NULL",
      [name],
    )
  )[0]!;
const field = async (label: string) =>
  (
    await h.ownerPool.query<{ key: string; type: string; options: { id: string; label: string }[] }>(
      "SELECT key, type, options FROM field_definitions WHERE label = $1",
      [label],
    )
  ).rows[0];

// 30 rows, so the last ones are well past the five the screen shows.
const rows = Array.from({ length: 30 }, (_, i) => {
  const space = ["Residential", "Commercial", "residential"][i % 3];
  const rooms = i % 2 ? `"Kitchen, Bedroom"` : "Kitchen";
  const budget = i === 29 ? `"12,00,000"` : String(500000 + i * 1000);
  const when = `2026-11-${String((i % 28) + 1).padStart(2, "0")}`;
  return `Lead ${i},+91987650${String(1000 + i)},${space},${rooms},${budget},${when},,${i % 2 ? "yes" : "no"},note ${i}`;
});
const CSV = `full_name,phone_number,what_type_of_space_are_you_designing?,rooms,budget,moving_in,,is_organic,notes\n${rows.join("\n")}\n`;

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
});
afterAll(async () => h.close());

describe("columns that become new fields", () => {
  it("what each column holds, read from every row: how many rows fill it and what kind of values they are", async () => {
    const d = await upload(CSV);
    expect(d.profiles.map((p: { kind: string }) => p.kind)).toEqual([
      "text",
      "phone",
      "choice",
      "choice",
      "money",
      "date",
      "empty",
      "boolean",
      "text",
    ]);
    expect(d.profiles[6]).toMatchObject({ column: 6, filled: 0 });
    expect(d.profiles[2]).toMatchObject({ filled: 30, values: ["Residential", "Commercial"] });
    expect(d.profiles[3]).toMatchObject({ values: ["Kitchen", "Bedroom"] });
  });

  it("a column empty in every row can't become a field: it says so", async () => {
    const d = await upload(CSV);
    const r = await patch(d.id, {
      mapping: { ...d.mapping, columns: [{ column: 6, to: "new_field", label: "Column G", type: "text" }] },
    });
    const problems = r.json().problems as { column: number; code: string; message: string }[];
    expect(problems).toContainEqual({
      column: 6,
      code: "NEW_FIELD_EMPTY",
      message: "This column is empty in every row, so there's nothing to keep.",
    });
    expect((await start(d.id)).statusCode).toBe(400);
  });

  it("a new One choice or Several choices field gets its options from the column's values, and every row keeps its value", async () => {
    const d = await upload(CSV);
    const mapping = {
      createMissingTags: false,
      columns: [
        { column: 0, to: "field", field: "name" },
        { column: 1, to: "field", field: "phone" },
        { column: 2, to: "new_field", label: "Space type", type: "select" },
        { column: 3, to: "new_field", label: "Rooms", type: "multi_select" },
        { column: 4, to: "new_field", label: "Budget", type: "currency" },
      ],
    };
    const r = await patch(d.id, { mapping });
    expect(r.json().problems).toEqual([]);
    expect((await start(d.id)).statusCode).toBe(200);
    await h.runImports();
    const done = (await h.pool.query("SELECT created, errors FROM imports WHERE id = $1", [d.id])).rows[0];
    expect(done).toEqual({ created: 30, errors: 0 });

    const space = (await field("Space type"))!;
    expect(space.options.map((o) => o.label)).toEqual(["Residential", "Commercial"]);
    const rooms = (await field("Rooms"))!;
    expect(rooms.options.map((o) => o.label)).toEqual(["Kitchen", "Bedroom"]);
    const residential = space.options[0]!.id;
    expect((await leadNamed("Lead 2")).custom[space.key]).toBe(residential);
    expect((await leadNamed("Lead 1")).custom[rooms.key]).toEqual(rooms.options.map((o) => o.id));
    expect((await leadNamed("Lead 29")).custom[(await field("Budget"))!.key]).toBe(1200000);
  });
});
