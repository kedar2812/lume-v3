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

const url = "/api/v1/settings/calendar";

describe("Settings → Calendar: which events are meetings with leads (5A, spec §2.2)", () => {
  it("only 'an attendee is a lead' is on, until someone changes it", async () => {
    expect((await admin.inject({ method: "GET", url })).json()).toEqual({
      rules: { attendeeIsLead: true, titleWords: [], calendarIds: [] },
    });
  });

  it("saves the rules, trimming the words and dropping blanks and repeats; audited with counts, never the words", async () => {
    const r = await admin.inject({
      method: "PUT",
      url,
      payload: {
        rules: {
          attendeeIsLead: false,
          titleWords: ["  Discovery call ", "demo", "", "   ", "DEMO", "Site visit"],
          calendarIds: ["sales@group.test", "sales@group.test"],
        },
      },
    });
    expect(r.statusCode).toBe(200);
    const want = {
      rules: {
        attendeeIsLead: false,
        titleWords: ["Discovery call", "demo", "Site visit"],
        calendarIds: ["sales@group.test"],
      },
    };
    expect(r.json()).toEqual(want);
    expect((await admin.inject({ method: "GET", url })).json()).toEqual(want);
    // stored where the sync reads it
    const [s] = (await h.ownerPool.query("SELECT calendar FROM settings WHERE id = 1")).rows;
    expect(s.calendar).toEqual(want);
    const [a] = (
      await h.pool.query(
        "SELECT diff FROM audit_log WHERE action = 'settings.calendar' ORDER BY id DESC LIMIT 1",
      )
    ).rows;
    expect(a.diff).toEqual({ attendeeIsLead: false, titleWords: 3, calendarIds: 1 });
    expect(JSON.stringify(a.diff)).not.toContain("Discovery");
  });

  it("refuses what it can't be", async () => {
    for (const bad of [
      {},
      { rules: { attendeeIsLead: true } },
      { rules: { attendeeIsLead: "yes", titleWords: [], calendarIds: [] } },
      { rules: { attendeeIsLead: true, titleWords: ["x".repeat(101)], calendarIds: [] } },
    ]) {
      const r = await admin.inject({ method: "PUT", url, payload: bad });
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("is the admins'", async () => {
    expect((await rep.inject({ method: "GET", url })).statusCode).toBe(403);
    expect(
      (
        await rep.inject({
          method: "PUT",
          url,
          payload: { rules: { attendeeIsLead: true, titleWords: [], calendarIds: [] } },
        })
      ).statusCode,
    ).toBe(403);
  });
});
