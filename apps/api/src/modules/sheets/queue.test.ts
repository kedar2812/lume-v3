import { newId } from "@lume/core";
import { schema } from "@lume/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { dueSources, recoverStaleSyncs } from "./queue";

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

  describe("recoverStaleSyncs (final review)", () => {
    it("on start-up, syncs a restart left behind are closed and their sheets freed", async () => {
      const id = await add("active", null);
      const sync = newId();
      await h.pool.query(
        "INSERT INTO source_syncs (id, source_id, trigger, status) VALUES ($1, $2, 'refresh', 'running')",
        [sync, id],
      );
      await h.pool.query(
        "UPDATE lead_sources SET current_sync_id = $2, sync_lock_until = now() + interval '15 minutes' WHERE id = $1",
        [id, sync],
      );
      const db = drizzle(h.pool, { schema });
      expect(await recoverStaleSyncs(db)).toBe(1);
      const [s] = (
        await h.pool.query("SELECT current_sync_id, sync_lock_until FROM lead_sources WHERE id = $1", [id])
      ).rows;
      expect(s).toEqual({ current_sync_id: null, sync_lock_until: null });
      const [y] = (await h.pool.query("SELECT status, error FROM source_syncs WHERE id = $1", [sync])).rows;
      expect(y).toEqual({ status: "failed", error: "stopped" });
    });
  });
});
