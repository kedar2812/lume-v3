import pg from "pg";
import { ALL_GRANTS, PAUSED_MESSAGE, type Grant } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

/** Phase 6A Task 3: a burst is stopped at the act that crosses the line, not up to 5 minutes later. */
let h: Harness;
let owner: AuthedClient;
let ownerUser: SeededUser;
let securityAdmin: SeededUser;
let fullAdmin: AuthedClient;
let fullAdminUser: SeededUser;
const repGrants: Grant[] = [
  ...(["leads.view", "leads.contact.reveal", "messages.send", "messages.send_queue"] as const).map((key) => ({
    key,
    scope: "own" as const,
  })),
];
let rep: SeededUser;
let repClient: AuthedClient;
let lead: string;

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  ownerUser = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  owner = await h.signIn(ownerUser);
  securityAdmin = await h.seedUser({
    grants: [{ key: "security.manage", scope: null }],
    totp: true,
    name: "Hana Ito",
  });
  fullAdminUser = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Ade Admin" });
  fullAdmin = await h.signIn(fullAdminUser);
});
afterAll(() => h.close());
// The audit log is append-only: every test watches a person of its own, with a lead of their own.
beforeEach(async () => {
  rep = await h.seedUser({ grants: repGrants, name: "Rory Reid" });
  repClient = await h.signIn(rep);
  lead = await h.seedLead({ ownerId: rep.id, name: "Dana Whitfield", phone: "+971501112233" });
  await setRules({});
});

const setRules = (anomaly: Record<string, unknown>) =>
  h.ownerPool.query(
    "UPDATE settings SET security = jsonb_set(security, '{anomaly}', $1::jsonb) WHERE id = 1",
    [JSON.stringify(anomaly)],
  );
const reveal = (c: AuthedClient, id = lead) =>
  c.inject({ method: "POST", url: `/api/v1/leads/${id}/contact/reveal` });
const open = (c: AuthedClient, id: string) => c.inject({ method: "GET", url: `/api/v1/leads/${id}` });
async function revealTimes(n: number) {
  let last;
  for (let i = 0; i < n; i++) last = await reveal(repClient);
  return last!;
}
async function backup<R>(text: string, params: unknown[] = []): Promise<R[]> {
  const c = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as R[];
  } finally {
    await c.end();
  }
}
const one = async <R>(text: string, params: unknown[]) => (await h.pool.query(text, params)).rows[0] as R;

describe("contacts revealed (the report's test)", () => {
  it("the 31st reveal in an hour, with pause on: refused, paused, sessions ended, admins told — all kept", async () => {
    const thirtieth = await revealTimes(30);
    expect(thirtieth.statusCode).toBe(200);
    const r = await reveal(repClient);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: { code: "SUSPENDED", message: PAUSED_MESSAGE } });
    expect(r.body).not.toMatch(/1112233/);
    // Committed, though the answer was a refusal (Review Focus 1).
    expect(await one("SELECT status FROM users WHERE id = $1", [rep.id])).toEqual({ status: "suspended" });
    expect(
      await one("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL", [
        rep.id,
      ]),
    ).toEqual({ n: 0 });
    expect(
      await one(
        "SELECT observed, threshold, action, status FROM security_alerts WHERE user_id = $1 AND rule = 'reveals'",
        [rep.id],
      ),
    ).toEqual({ observed: 31, threshold: 30, action: "suspended", status: "open" });
    expect(
      await one(
        "SELECT count(*)::int AS n FROM audit_log WHERE actor_user_id = $1 AND action = 'lead.contact.reveal'",
        [rep.id],
      ),
    ).toEqual({ n: 31 });
    const told = await backup<{ user_id: string }>(
      "SELECT n.user_id FROM notifications n JOIN security_alerts a ON a.id::text = n.data->>'alertId' WHERE a.user_id = $1",
      [rep.id],
    );
    // Everyone who manages security: the owner, the security admin, and the admin holding every permission.
    expect(told.map((t) => t.user_id).sort()).toEqual(
      [ownerUser.id, securityAdmin.id, fullAdminUser.id].sort(),
    );
  });

  it("with alert only: the 31st contact is shown, they carry on, and admins are told", async () => {
    await setRules({ reveals: { action: "alert", threshold: 30 } });
    const r = await revealTimes(31);
    expect(r.statusCode).toBe(200);
    expect(r.json().phone).toMatch(/50 111 2233|501112233/);
    expect(await one("SELECT status FROM users WHERE id = $1", [rep.id])).toEqual({ status: "active" });
    expect(await one("SELECT action FROM security_alerts WHERE user_id = $1", [rep.id])).toEqual({
      action: "alerted",
    });
  });

  it("says near the limit from 80% of a pause rule: the 24th of 30, not the 23rd", async () => {
    expect((await revealTimes(23)).json().nearLimit).toBe(false);
    expect((await reveal(repClient)).json().nearLimit).toBe(true);
  });

  it("a rule switched off never alerts", async () => {
    await setRules({ reveals: { action: "off", threshold: 5 } });
    expect((await revealTimes(8)).statusCode).toBe(200);
    expect(await one("SELECT count(*)::int AS n FROM security_alerts WHERE user_id = $1", [rep.id])).toEqual({
      n: 0,
    });
  });

  it("never counts the owner, or an admin who sees every contact (Review Focus 3)", async () => {
    await setRules({ reveals: { action: "suspend", threshold: 5 } });
    for (let i = 0; i < 8; i++) {
      expect((await reveal(owner)).statusCode).toBe(200);
      expect((await reveal(fullAdmin)).statusCode).toBe(200);
    }
    const n = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM security_alerts a JOIN users u ON u.id = a.user_id WHERE u.name IN ('Maya Kapoor', 'Ade Admin')",
      [],
    );
    expect(n.n).toBe(0);
  });

  it("restored, the next reveal doesn't pause them again (Review Focus 4)", async () => {
    await setRules({ reveals: { action: "suspend", threshold: 5 } });
    expect((await revealTimes(6)).statusCode).toBe(403);
    const alert = await one<{ id: string }>("SELECT id FROM security_alerts WHERE user_id = $1", [rep.id]);
    await h.ownerPool.query("UPDATE users SET status = 'active', watch_from = now() WHERE id = $1", [rep.id]);
    await h.ownerPool.query(
      "UPDATE security_alerts SET status = 'resolved', resolution = 'restored', resolved_at = now() WHERE id = $1",
      [alert.id],
    );
    await h.ownerPool.query("SELECT pg_notify('lume_rbac', $1)", [rep.id]);
    await h.waitForRbacNotify();
    const again = await h.signIn(rep);
    expect((await reveal(again)).statusCode).toBe(200);
  });
});

describe("leads opened", () => {
  it("the open that crosses a pause rule is refused, without the lead", async () => {
    await setRules({ leadsOpened: { action: "suspend", threshold: 25 } });
    const ids = [lead];
    for (let i = 1; i <= 25; i++) ids.push(await h.seedLead({ ownerId: rep.id, name: `Opened ${i}` }));
    for (const id of ids.slice(0, 25)) expect((await open(repClient, id)).statusCode).toBe(200);
    const r = await open(repClient, ids[25]!);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("SUSPENDED");
    expect(r.body).not.toMatch(/Opened 25/);
    expect(await one("SELECT status FROM users WHERE id = $1", [rep.id])).toEqual({ status: "suspended" });
  });

  it("one lead opened 60 times is one lead (Review Focus 3)", async () => {
    await setRules({ leadsOpened: { action: "suspend", threshold: 25 } });
    for (let i = 0; i < 60; i++) expect((await open(repClient, lead)).statusCode).toBe(200);
  });

  it("near the limit, the lead comes with a quiet notice", async () => {
    await setRules({ leadsOpened: { action: "suspend", threshold: 25 } });
    const ids = [lead];
    for (let i = 1; i < 20; i++) ids.push(await h.seedLead({ ownerId: rep.id, name: `Near ${i}` }));
    let last;
    for (const id of ids) last = await open(repClient, id);
    expect(last!.json().watch).toEqual({ nearLimit: true });
    expect((await open(repClient, ids[0]!)).json().lead.id).toBe(ids[0]);
  });
});

describe("send-queue runs", () => {
  it("the 4th run in a day tells admins, and the run still starts", async () => {
    for (let i = 0; i < 4; i++) {
      const r = await repClient.inject({
        method: "POST",
        url: "/api/v1/queues",
        payload: { leadIds: [lead] },
      });
      expect(r.statusCode, r.body).toBe(201);
      await repClient.inject({ method: "POST", url: `/api/v1/queues/${r.json().queue.id}/cancel` });
    }
    expect(await one("SELECT action, observed FROM security_alerts WHERE user_id = $1", [rep.id])).toEqual({
      action: "alerted",
      observed: 4,
    });
  });
});
