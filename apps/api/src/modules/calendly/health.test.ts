import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCalendlyFake, type CalendlyFake } from "../../../test/calendly-fake";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { checkCalendly } from "./health";

let h: Harness;
let fake: CalendlyFake;
let admin: AuthedClient;
let sourceId: string;

beforeAll(async () => {
  fake = await startCalendlyFake();
  h = await createHarness({ preset: "coaching", calendlyEndpoint: fake.url });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  expect(
    (
      await admin.inject({
        method: "POST",
        url: "/api/v1/integrations/calendly",
        payload: { token: fake.token },
      })
    ).statusCode,
  ).toBe(200);
  sourceId = (await h.ownerPool.query<{ id: string }>("SELECT id FROM lead_sources WHERE type = 'calendly'"))
    .rows[0]!.id;
});
afterAll(async () => {
  await h.close();
  await fake.close();
});

const check = () =>
  checkCalendly({ pool: h.pool, keyring: h.keyring, endpoint: fake.url, wait: async () => undefined });
const state = async () =>
  (
    await h.ownerPool.query<{ status: string; attention_code: string | null; last_error: string | null }>(
      "SELECT status, attention_code, last_error FROM lead_sources WHERE id = $1",
      [sourceId],
    )
  ).rows[0]!;

describe("Calendly's daily check (5B final review, Important 6)", () => {
  it("all well: nothing changes", async () => {
    await check();
    expect(await state()).toMatchObject({ status: "active", attention_code: null });
  });

  it("a token Calendly stopped honouring needs attention, in LUME's words; when it's honoured again, it clears", async () => {
    fake.revoked = true;
    try {
      await check();
    } finally {
      fake.revoked = false;
    }
    const s = await state();
    expect(s).toMatchObject({ status: "needs_attention", attention_code: "CALENDLY_TOKEN" });
    expect(s.last_error).toMatch(/access token/);
    expect(s.last_error).not.toContain(fake.token);
    expect(
      (await admin.inject({ method: "GET", url: "/api/v1/integrations/calendly" })).json(),
    ).toMatchObject({
      status: "needs_attention",
      lastError: s.last_error,
    });
    await check();
    expect(await state()).toMatchObject({ status: "active", attention_code: null, last_error: null });
  });

  it("a subscription Calendly disabled (the plan, or its person's access) needs attention", async () => {
    fake.subscriptions[0]!.state = "disabled";
    try {
      await check();
    } finally {
      fake.subscriptions[0]!.state = "active";
    }
    expect(await state()).toMatchObject({
      status: "needs_attention",
      attention_code: "CALENDLY_SUBSCRIPTION",
    });
    await check();
    expect(await state()).toMatchObject({ status: "active" });
  });

  it("Calendly down changes nothing; another problem LUME already said stays", async () => {
    fake.fail(503, 8);
    await check();
    fake.fail(503, 0);
    expect(await state()).toMatchObject({ status: "active" });
    await h.ownerPool.query(
      "UPDATE lead_sources SET status = 'needs_attention', attention_code = 'RUN_AS_ACCESS', last_error = 'x' WHERE id = $1",
      [sourceId],
    );
    await check();
    expect(await state()).toMatchObject({ status: "needs_attention", attention_code: "RUN_AS_ACCESS" });
  });
});
