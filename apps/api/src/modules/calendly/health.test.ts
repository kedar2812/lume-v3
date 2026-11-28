import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCalendlyFake, type CalendlyFake } from "../../../test/calendly-fake";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { openCalendly, sealCalendly } from "./config";
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

/** LUME's booking link, which LUME AI shares (spec 2026-11-28; review 2026-11-28, Important 2 and 3). */
describe("the daily check and LUME's booking link", () => {
  const DISC = "https://api.calendly.com/event_types/DISC";
  const settings = async () => {
    const r = (
      await h.ownerPool.query<{ config_enc: Buffer }>("SELECT config_enc FROM lead_sources WHERE id = $1", [
        sourceId,
      ])
    ).rows[0]!;
    return openCalendly(h.keyring, sourceId, r.config_enc).settings;
  };
  const choose = async (page?: string) => {
    fake.links = [
      { uri: DISC, name: "Discovery call", duration: 30, owner: "Maya Kapoor", ...(page ? { page } : {}) },
    ];
    const r = await admin.inject({
      method: "PATCH",
      url: "/api/v1/integrations/calendly",
      payload: { bookWith: DISC },
    });
    expect(r.statusCode).toBe(200);
  };

  it("one chosen before LUME kept its page: the check fills the page and name in from Calendly", async () => {
    await choose();
    const r = (
      await h.ownerPool.query<{ config_enc: Buffer }>("SELECT config_enc FROM lead_sources WHERE id = $1", [
        sourceId,
      ])
    ).rows[0]!;
    const c = openCalendly(h.keyring, sourceId, r.config_enc);
    const older = { ...c.settings };
    delete older.bookUrl;
    delete older.bookName;
    await h.ownerPool.query("UPDATE lead_sources SET config_enc = $2 WHERE id = $1", [
      sourceId,
      sealCalendly(h.keyring, sourceId, { ...c, settings: older }),
    ]);
    await check();
    expect(await settings()).toMatchObject({
      bookUrl: "https://calendly.com/maya/DISC",
      bookName: "Discovery call",
    });
  });

  it("its address changed in Calendly: the new page is kept, so LUME AI never shares a dead one", async () => {
    await choose();
    fake.links[0]!.page = "https://calendly.com/maya/intro-call";
    fake.links[0]!.name = "Intro call";
    await check();
    expect(await settings()).toMatchObject({
      bookUrl: "https://calendly.com/maya/intro-call",
      bookName: "Intro call",
    });
  });

  it("gone from Calendly, then back: marked, then cleared", async () => {
    await choose();
    fake.links = [];
    await check();
    expect((await settings()).bookGone).toBe(true);
    fake.links = [{ uri: DISC, name: "Discovery call", duration: 30, owner: "Maya Kapoor" }];
    await check();
    expect((await settings()).bookGone).toBe(false);
  });

  it("an admin's save while the check waits on Calendly is kept, never written over", async () => {
    await choose();
    fake.links = [];
    // The admin turns the booking link off just as the check is about to write what it learned.
    const pool = {
      query: async (text: string, params?: unknown[]) => {
        if (text.startsWith("UPDATE lead_sources SET config_enc"))
          expect(
            (
              await admin.inject({
                method: "PATCH",
                url: "/api/v1/integrations/calendly",
                payload: { bookWith: null },
              })
            ).statusCode,
          ).toBe(200);
        return h.pool.query(text, params);
      },
    } as unknown as typeof h.pool;
    await checkCalendly({ pool, keyring: h.keyring, endpoint: fake.url, wait: async () => undefined });
    expect(await settings()).toMatchObject({ bookWith: null, bookUrl: null });
  });
});
