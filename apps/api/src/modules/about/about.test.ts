import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("About", () => {
  it("tells anyone signed in the version, and that no restore test has run yet", async () => {
    const rep = await h.signIn(await h.seedUser({ grants: [] }));
    const about = (await rep.inject({ method: "GET", url: "/api/v1/about" })).json();
    expect(about.version).toMatch(/\S/);
    expect(about.lastRestoreTest).toBeNull();
  });

  it("reports the most recent restore test", async () => {
    await h.ownerPool.query(
      `INSERT INTO ops_restore_tests (started_at, finished_at, backup_name, ok, details)
       VALUES (now() - interval '8 days', now() - interval '8 days', 'lume-old.dump.age', false, '{}'),
              (now() - interval '1 day', now() - interval '1 day', 'lume-20260922T0200Z.dump.age', true, '{}')`,
    );
    const rep = await h.signIn(await h.seedUser({ grants: [] }));
    const about = (await rep.inject({ method: "GET", url: "/api/v1/about" })).json();
    expect(about.lastRestoreTest).toMatchObject({ ok: true, backup: "lume-20260922T0200Z.dump.age" });
  });
});
