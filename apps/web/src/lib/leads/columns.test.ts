import { describe, expect, it } from "vitest";
import { availableColumns, resolveColumns } from "./columns";
import { testCatalog } from "./test-catalog";

describe("table columns", () => {
  it("never offers a contact column to a masked role (report §12.2 #4)", () => {
    const ids = availableColumns(testCatalog(), false).map((c) => c.id);
    expect(ids).not.toContain("phone");
    expect(ids).not.toContain("email");
    expect(ids).not.toContain("instagram");
    expect(ids).toContain("name");
  });

  it("offers contacts to a full-contact role, and custom fields the caller can see", () => {
    const cat = testCatalog();
    const ids = availableColumns(cat, true).map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining(["name", "phone", "email", "stage", "owner", "value", "custom:struggles"]),
    );
    const hidden = {
      ...cat,
      fields: cat.fields.map((f) => (f.key === "struggles" ? { ...f, access: "hidden" as const } : f)),
    };
    expect(availableColumns(hidden, true).map((c) => c.id)).not.toContain("custom:struggles");
  });

  it("keeps a saved order, drops columns that no longer exist, and always keeps the name first", () => {
    const available = availableColumns(testCatalog(), true);
    expect(resolveColumns(["owner", "gone:field", "stage", "name"], available).map((c) => c.id)).toEqual([
      "name",
      "owner",
      "stage",
    ]);
    expect(resolveColumns(null, available).map((c) => c.id)).toEqual([
      "name",
      "stage",
      "owner",
      "phone",
      "value",
      "updated",
    ]);
  });

  it("leaves the default's contact column out for a masked role", () => {
    const cols = resolveColumns(null, availableColumns(testCatalog(), false)).map((c) => c.id);
    expect(cols).toEqual(["name", "stage", "owner", "value", "updated"]);
  });
});
