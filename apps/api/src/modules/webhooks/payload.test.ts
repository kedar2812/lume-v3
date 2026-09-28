import { describe, expect, it } from "vitest";
import { cellsFor, flatten, parseBody, pathsOf } from "./payload";

const json = (v: unknown) => Buffer.from(JSON.stringify(v));

describe("parseBody (2C spec §4 step 4)", () => {
  it("reads a JSON object, and a plain HTML form", () => {
    expect(parseBody(json({ name: "Aisha" }), "application/json; charset=utf-8")).toEqual({
      ok: true,
      value: { name: "Aisha" },
    });
    expect(parseBody(Buffer.from("a=1&b=two+words"), "application/x-www-form-urlencoded")).toEqual({
      ok: true,
      value: { a: "1", b: "two words" },
    });
  });

  it("refuses bad JSON, a list at the top, and any other type", () => {
    expect(parseBody(Buffer.from("{nope"), "application/json")).toEqual({
      ok: false,
      status: 400,
      code: "BAD_JSON",
    });
    expect(parseBody(json([{ name: "A" }]), "application/json")).toEqual({
      ok: false,
      status: 400,
      code: "NOT_OBJECT",
    });
    expect(parseBody(Buffer.from("name=A"), "text/plain")).toEqual({
      ok: false,
      status: 415,
      code: "UNSUPPORTED_TYPE",
    });
    expect(parseBody(json({}), undefined)).toMatchObject({ ok: false, code: "UNSUPPORTED_TYPE" });
  });
});

describe("flatten (2C spec §2 nested values)", () => {
  const payload = {
    name: "Aisha Khan",
    contact: { phone: "+971501234567", email: null },
    tags: ["vip", "ad"],
    custom_fields: { budget: 900, callback: true },
    items: [{ a: 1 }],
    deep: { a: { b: { c: { d: { e: { f: 1 } } } } } },
  };

  it("gives one cell per path, and lists what can't be a cell", () => {
    const { cells, unmappable } = flatten(payload);
    expect(Object.fromEntries(cells)).toEqual({
      name: "Aisha Khan",
      "contact.phone": "+971501234567",
      "contact.email": "",
      "tags[]": "vip, ad",
      "custom_fields.budget": "900",
      "custom_fields.callback": "true",
    });
    expect(unmappable).toEqual(["items", "deep.a.b.c.d"]);
  });

  it("paths come in the order they were first seen", () => {
    expect(pathsOf(payload)).toEqual([
      "name",
      "contact.phone",
      "contact.email",
      "tags[]",
      "custom_fields.budget",
      "custom_fields.callback",
    ]);
  });

  it("cellsFor lines the cells up with the saved headers, blank where a post left one out", () => {
    const { cells } = flatten(payload);
    expect(cellsFor(["contact.phone", "name", "utm.source"], cells)).toEqual([
      "+971501234567",
      "Aisha Khan",
      "",
    ]);
  });
});
