import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { startImportQueue } from "./queue";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ preset: "general" });
});
afterAll(async () => h.close());

it("runs a started import through the real queue, as lume_app, and picks up a queued one after a restart", async () => {
  const admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  const upload = async (text: string) =>
    (
      await admin.inject({
        method: "POST",
        url: "/api/v1/imports",
        payload: Buffer.from(text),
        headers: { "content-type": "application/octet-stream", "x-file-name": "q.csv" },
      })
    ).json();
  // Started while "the API was down": only the harness's inline list heard about it.
  const early = await upload("Name\nQueued Before Start\n");
  await admin.inject({ method: "POST", url: `/api/v1/imports/${early.id}/start` });

  const queue = await startImportQueue({
    connectionString: h.url("lume_app"),
    app: h.app,
    pool: h.pool,
    keyring: h.keyring,
  });
  try {
    const later = await upload("Name\nSent Through Queue\n");
    await admin.inject({ method: "POST", url: `/api/v1/imports/${later.id}/start` });
    await queue.enqueue(later.id);
    const status = async (id: string) =>
      (await h.pool.query<{ status: string }>("SELECT status FROM imports WHERE id = $1", [id])).rows[0]!
        .status;
    const deadline = Date.now() + 25_000;
    while ((await status(early.id)) !== "done" || (await status(later.id)) !== "done") {
      if (Date.now() > deadline)
        throw new Error(`still ${await status(early.id)} / ${await status(later.id)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    const names = await h.queryAll<{ name: string }>(
      "SELECT name FROM leads WHERE name IN ('Queued Before Start', 'Sent Through Queue') ORDER BY name",
    );
    expect(names.map((n) => n.name)).toEqual(["Queued Before Start", "Sent Through Queue"]);
  } finally {
    await queue.stop();
  }
}, 40_000);
