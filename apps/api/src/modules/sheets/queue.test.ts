import { newId } from "@lume/core";
import { schema } from "@lume/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { dueSources } from "./queue";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ preset: "general" });
});
afterAll(async () => h.close());

const add = async (status: string, nextSyncAt: string | null) => {
  const id = newId();
  await h.pool.query(
    "INSERT INTO lead_sources (id, type, name, status, next_sync_at) VALUES ($1, 'google_sheet', 'S', $2, $3)",
    [id, status, nextSyncAt],
  );
  return id;
};

describe("dueSources", () => {
  it("lists active sheets that are due, only while Sheets is switched on", async () => {
    const due = await add("active", "2000-01-01T00:00:00Z");
    const never = await add("active", null);
    await add("active", "2999-01-01T00:00:00Z");
    await add("paused", "2000-01-01T00:00:00Z");
    await add("needs_attention", "2000-01-01T00:00:00Z");
    const db = drizzle(h.pool, { schema });
    expect(await dueSources(db)).toEqual([]);
    await h.pool.query(`UPDATE settings SET integrations = '{"googleSheets":{"enabled":true}}' WHERE id = 1`);
    expect((await dueSources(db)).sort()).toEqual([due, never].sort());
  });
});
