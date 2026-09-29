import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true }));
});
afterAll(() => h.close());

const url = "/api/v1/settings/messaging";

describe("Settings → Messages (4C Task 1)", () => {
  it("runs of 50 and 150 a day, until someone changes them", async () => {
    expect((await admin.inject({ method: "GET", url })).json()).toEqual({ queueSize: 50, dailyCap: 150 });
  });

  it("each changes on its own, in range, and the change is audited", async () => {
    const a = await admin.inject({ method: "PUT", url, payload: { queueSize: 80 } });
    expect(a.json()).toEqual({ queueSize: 80, dailyCap: 150 });
    const b = await admin.inject({ method: "PUT", url, payload: { dailyCap: 300 } });
    expect(b.json()).toEqual({ queueSize: 80, dailyCap: 300 });
    for (const bad of [
      { queueSize: 0 },
      { queueSize: 201 },
      { dailyCap: 0 },
      { dailyCap: 501 },
      { dailyCap: 2.5 },
    ]) {
      const r = await admin.inject({ method: "PUT", url, payload: bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
    const [row] = (
      await h.pool.query(
        "SELECT diff FROM audit_log WHERE action = 'settings.messaging' ORDER BY id DESC LIMIT 1",
      )
    ).rows;
    expect(row.diff).toEqual({ dailyCap: 300 });
  });

  it("is for people who manage settings", async () => {
    expect((await rep.inject({ method: "GET", url })).statusCode).toBe(403);
    expect((await rep.inject({ method: "PUT", url, payload: { queueSize: 10 } })).statusCode).toBe(403);
  });
});
