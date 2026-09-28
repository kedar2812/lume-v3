import { ALL_GRANTS, newId } from "@lume/core";
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

const url = "/api/v1/settings/follow-ups";

describe("Settings → Follow-ups (Phase 3B, Task 1)", () => {
  it("escalation is on, after 24 hours, until someone changes it", async () => {
    const r = await admin.inject({ method: "GET", url });
    expect(r.json()).toMatchObject({ escalation: { enabled: true, hours: 24 }, digest: { enabled: true } });
  });

  it("changing it is audited, and only whole hours from 1 to a week are allowed", async () => {
    const ok = await admin.inject({
      method: "PUT",
      url,
      payload: { escalation: { enabled: true, hours: 6 } },
    });
    expect(ok.json()).toMatchObject({ escalation: { enabled: true, hours: 6 } });
    expect((await admin.inject({ method: "GET", url })).json().escalation.hours).toBe(6);
    const logged = await h.queryAll<{ diff: { escalation: { hours: number } } }>(
      "SELECT diff FROM audit_log WHERE action = 'settings.follow_ups'",
    );
    expect(logged.at(-1)!.diff.escalation.hours).toBe(6);
    for (const hours of [0, 169, 2.5])
      expect(
        (await admin.inject({ method: "PUT", url, payload: { escalation: { enabled: true, hours } } }))
          .statusCode,
      ).toBe(400);
  });

  it("only someone who manages settings may read or change it", async () => {
    expect((await rep.inject({ method: "GET", url })).statusCode).toBe(403);
    expect(
      (await rep.inject({ method: "PUT", url, payload: { escalation: { enabled: false, hours: 24 } } }))
        .statusCode,
    ).toBe(403);
  });
});

describe("Settings → Follow-ups: 3B final review", () => {
  it("each section changes on its own, and the morning email can be switched off for everyone", async () => {
    await admin.inject({ method: "PUT", url, payload: { escalation: { enabled: true, hours: 12 } } });
    const r = await admin.inject({ method: "PUT", url, payload: { digest: { enabled: false } } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ escalation: { enabled: true, hours: 12 }, digest: { enabled: false } });
    await admin.inject({ method: "PUT", url, payload: { digest: { enabled: true } } });
  });

  it("switching escalation on starts from now: what was already overdue doesn't flood managers", async () => {
    const assignee = (await h.seedUser({ grants: ALL_GRANTS, totp: true })).id;
    const lead = await h.seedLead({ ownerId: assignee, name: "Long Forgotten" });
    const id = newId();
    await h.queryAll(
      "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Call back', now() - interval '30 days', $1)",
      [id, lead, assignee],
    );
    await admin.inject({ method: "PUT", url, payload: { escalation: { enabled: false, hours: 24 } } });
    await admin.inject({ method: "PUT", url, payload: { escalation: { enabled: true, hours: 24 } } });
    const [row] = await h.queryAll<{ escalated_at: Date | null }>(
      "SELECT escalated_at FROM tasks WHERE id = $1",
      [id],
    );
    expect(row!.escalated_at).not.toBeNull();
  });
});

describe("0024: what escalation and the digest remember", () => {
  it("a follow-up can be marked escalated, and a digest is kept once per person per local day", async () => {
    const u = (await h.seedUser({ grants: [], totp: true })).id;
    const run = () =>
      h.ownerPool.query("INSERT INTO digest_runs (user_id, local_date, items) VALUES ($1, '2026-09-28', 3)", [
        u,
      ]);
    await run();
    await expect(run()).rejects.toThrow(/digest_runs_pkey/);
    await h.ownerPool.query("SELECT escalated_at FROM tasks LIMIT 0");
  });
});
