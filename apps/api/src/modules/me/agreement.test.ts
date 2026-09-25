import { LEGAL_VERSION } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => h.close());

describe("the licence agreement, terms and privacy policy", () => {
  it("must be agreed to before anything else, and agreeing records who, which version, when and from where", async () => {
    const u = await h.seedUser({ grants: [] });
    const c = await h.signIn(u);
    const before = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(before.flags.needsAgreement).toBe(true);
    expect(before.agreement).toEqual({ version: null, current: LEGAL_VERSION });

    const agreed = await c.inject({
      method: "POST",
      url: "/api/v1/me/agreement",
      payload: { version: LEGAL_VERSION },
      headers: { "user-agent": "LUME test browser" },
    });
    expect(agreed.statusCode).toBe(204);
    const after = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(after.flags.needsAgreement).toBe(false);
    expect(after.agreement).toEqual({ version: LEGAL_VERSION, current: LEGAL_VERSION });

    const evidence = await h.pool.query(
      "SELECT version, user_agent, accepted_at FROM legal_acceptances WHERE user_id = $1",
      [u.id],
    );
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]).toMatchObject({ version: LEGAL_VERSION, user_agent: "LUME test browser" });
    const audited = await h.pool.query(
      "SELECT 1 FROM audit_log WHERE action = 'user.agreed' AND entity_id = $1",
      [u.id],
    );
    expect(audited.rowCount).toBe(1);
  });

  it("refuses an old version, so nobody agrees to words they weren't shown", async () => {
    const c = await h.signIn(await h.seedUser({ grants: [] }));
    const r = await c.inject({
      method: "POST",
      url: "/api/v1/me/agreement",
      payload: { version: "2020-01-01" },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("STALE_TERMS");
  });

  it("can be agreed to before a required two-step enrolment, since it comes first", async () => {
    const u = await h.seedUser({ grants: [{ key: "users.manage", scope: null }] }); // a role that requires 2FA
    const c = await h.signIn(u);
    const me = (await c.inject({ method: "GET", url: "/api/v1/auth/me" })).json();
    expect(me.flags.needsTwoFactorEnrolment).toBe(true);
    const r = await c.inject({
      method: "POST",
      url: "/api/v1/me/agreement",
      payload: { version: LEGAL_VERSION },
    });
    expect(r.statusCode).toBe(204);
  });
});
