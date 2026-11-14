import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { grantContext } from "./connect";

/** Live sheets (owner 2026-11-14): Refresh updates live sheets too, and its card counts them. */
let h: Harness;
let maya: SeededUser;
let admin: AuthedClient;
let rep: AuthedClient;

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true, oauth: { relayToken: "f".repeat(40) } });
  maya = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  admin = await h.signIn(maya);
  rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true }));
  expect(
    (
      await admin.inject({
        method: "PUT",
        url: "/api/v1/integrations/google-sheets",
        payload: { enabled: true },
      })
    ).statusCode,
  ).toBe(200);
});
afterAll(async () => h.close());

async function liveSheet(o: { pause?: string } = {}) {
  const grantId = newId();
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [maya.id]);
    await c.query(
      "INSERT INTO live_sheet_grants (id, user_id, google_email, grant_enc) VALUES ($1, $2, $3, $4)",
      [grantId, maya.id, `${grantId}@x.test`, h.keyring.encrypt("rt-ok", grantContext(grantId))],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  const id = newId();
  await h.ownerPool.query(
    `INSERT INTO live_sheets (id, name, preset, rule, edits, grant_id, made_by, runs_as, status, pause_reason, next_sync_at)
     VALUES ($1, 'S', 'meta', '{}', 'keep', $2, $3, $3, $4, $5, now() + interval '1 hour')`,
    [id, grantId, maya.id, o.pause ? "paused" : "live", o.pause ?? null],
  );
  return id;
}

describe("Refresh and live sheets", () => {
  it("with no sheet to read but a live sheet to write, Refresh shows", async () => {
    expect((await admin.inject({ method: "GET", url: "/api/v1/sheets/status" })).json().refresh).toBe(false);
    await liveSheet();
    expect((await admin.inject({ method: "GET", url: "/api/v1/sheets/status" })).json().refresh).toBe(true);
    // For everyone who sees Refresh: a live sheet is the business's, kept up to date for all.
    expect((await rep.inject({ method: "GET", url: "/api/v1/sheets/status" })).json().refresh).toBe(true);
  });

  it("asks every live sheet to update, counts them on the card, and is done when they are", async () => {
    await h.ownerPool.query("DELETE FROM live_sheet_runs");
    h.liveSheetQueue.length = 0;
    const gone = await liveSheet({ pause: "sheet_gone" });
    const r = await admin.inject({ method: "POST", url: "/api/v1/sheets/refresh" });
    expect(r.statusCode, r.body).toBe(200);
    const { id } = r.json();
    const before = (await admin.inject({ method: "GET", url: `/api/v1/sheets/refresh/${id}` })).json();
    expect(before.status).toBe("running");
    expect(before.liveSheets.total).toBeGreaterThanOrEqual(1);
    expect(before.liveSheets.done).toBe(0);
    // A sheet paused for Google isn't asked: it can't write until someone fixes it.
    expect(h.liveSheetQueue.map((j) => j.sheetId)).not.toContain(gone);
    await h.runLiveSheets();
    const after = (await admin.inject({ method: "GET", url: `/api/v1/sheets/refresh/${id}` })).json();
    expect(after.status).toBe("done");
    expect(after.liveSheets.done).toBe(after.liveSheets.total);
  });
});
