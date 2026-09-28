import { ALL_GRANTS, DEFAULT_RULES, newId, type Mapping, type Rules } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { processEvent } from "./process";
import { sealWebhook, signFor } from "./secret";

let h: Harness;
let adminId: string;
let admin: AuthedClient;
let rules: Rules;
const SECRET = "p".repeat(43);
const HEAD = ["name", "contact.phone", "email", "enquired_on"];
const mapping: Mapping = {
  columns: [
    { column: 0, to: "field", field: "name" },
    { column: 1, to: "field", field: "phone" },
    { column: 2, to: "field", field: "email" },
    { column: 3, to: "field", field: "lead_created_at" },
  ],
  createMissingTags: false,
};

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  const user = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  adminId = user.id;
  admin = await h.signIn(user);
  await h.ownerPool.query(
    `UPDATE settings SET integrations = integrations || '{"webhooks":{"enabled":true}}'::jsonb WHERE id = 1`,
  );
  const pipelineId = (await h.queryAll<{ id: string }>("SELECT id FROM pipelines WHERE is_default"))[0]!.id;
  const stageId = (
    await h.queryAll<{ id: string }>(
      "SELECT id FROM stages WHERE pipeline_id = $1 AND kind = 'open' ORDER BY position LIMIT 1",
      [pipelineId],
    )
  )[0]!.id;
  rules = DEFAULT_RULES({ pipelineId, stageId, country: "AE" });
});
afterAll(() => h.close());

/** A live webhook source, as setup (Task 5) leaves it. */
async function source(o: { runAs?: string; name?: string } = {}) {
  const id = newId();
  await h.pool.query(
    `INSERT INTO lead_sources (id, type, name, status, config_enc, mapping, rules, headers, column_settings, run_as)
     VALUES ($1, 'webhook', $2, 'active', $3, $4, $5, $6, $7, $8)`,
    [
      id,
      o.name ?? "Site form",
      sealWebhook(h.keyring, id, { mode: "signed", secret: SECRET, preset: "website" }),
      mapping,
      rules,
      JSON.stringify(HEAD),
      { dateOrders: { 3: "YMD" }, decimalMarks: {} },
      o.runAs ?? adminId,
    ],
  );
  return id;
}
/** Post through the real receiving route, then run what it queued. */
async function send(id: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(h.clock.now.getTime() / 1000));
  const r = await h.app.inject({
    method: "POST",
    url: `/webhooks/in/${id}`,
    headers: {
      "content-type": "application/json",
      "x-lume-timestamp": ts,
      "x-lume-signature": signFor(SECRET, ts, Buffer.from(raw)),
    },
    payload: raw,
  });
  expect(r.statusCode).toBe(202);
  await h.runWebhooks();
  return lastEvent(id);
}
const lastEvent = async (id: string) =>
  (
    await h.pool.query(
      "SELECT id, status, result, lead_id, problems FROM webhook_events WHERE source_id = $1 ORDER BY id DESC LIMIT 1",
      [id],
    )
  ).rows[0];
const src = async (id: string) =>
  (await h.pool.query("SELECT * FROM lead_sources WHERE id = $1", [id])).rows[0];

describe("processing a post (2C spec §5)", () => {
  it("a queued post becomes a lead, and its history names the webhook and the event", async () => {
    const id = await source({ name: "Landing page" });
    const e = await send(id, {
      name: "Aisha Khan",
      contact: { phone: "+971501230001" },
      email: "aisha@example.test",
    });
    expect(e).toMatchObject({ status: "done", result: "created" });
    expect(e.lead_id).toBeTruthy();
    const [act] = await h.queryAll<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM activities WHERE lead_id = $1 AND type = 'imported'",
      [e.lead_id],
    );
    expect(act!.payload).toMatchObject({ sourceId: id, webhook: "Landing page", event: Number(e.id) });
    expect((await src(id)).last_event_at).not.toBeNull();
  });

  it("the same person posting again merges into their lead", async () => {
    const id = await source();
    const first = await send(id, { name: "Omar Ali", contact: { phone: "+971501230002" } });
    const again = await send(id, {
      name: "Omar Ali",
      contact: { phone: "+971501230002" },
      email: "omar@example.test",
    });
    expect(again).toMatchObject({ status: "done", result: "merged", lead_id: first.lead_id });
    const acts = await h.queryAll<{ type: string }>("SELECT type FROM activities WHERE lead_id = $1", [
      first.lead_id,
    ]);
    expect(acts.map((a) => a.type)).toContain("imported_again");
  });

  it("a post that can't be read is a problem, and goes through once the setup is fixed", async () => {
    const id = await source();
    const e = await send(id, {
      name: "Date Trouble",
      contact: { phone: "+971501230003" },
      enquired_on: "31/31/2026",
    });
    expect(e.status).toBe("error");
    expect(e.problems.length).toBeGreaterThan(0);
    await h.pool.query(
      "UPDATE lead_sources SET mapping = $2, config_version = config_version + 1 WHERE id = $1",
      [id, { ...mapping, columns: [...mapping.columns.slice(0, 3), { column: 3, to: "ignore" }] }],
    );
    await processEvent({ app: h.app, pool: h.pool, keyring: h.keyring }, Number(e.id));
    expect(await lastEvent(id)).toMatchObject({ status: "done", result: "created" });
  });

  it("Review Focus 4: a huge value is a problem, not a crash", async () => {
    const id = await source();
    const e = await send(id, { name: "x".repeat(12_000), contact: { phone: "+971501230004" } });
    expect(e.status).toBe("error");
    expect(e.problems[0]).toMatchObject({ code: "CELL_TOO_LONG" });
  });

  it("Review Focus 5: posts wait while the person it runs as can't add leads, then go through", async () => {
    const rep = (
      await h.seedUser({
        grants: (["leads.import", "leads.view", "leads.create", "leads.assign"] as const).map((key) => ({
          key,
          scope: "all" as const,
        })),
        totp: true,
      })
    ).id;
    const id = await source({ runAs: rep });
    await h.revokeGrant(rep, "leads.import");
    const e = await send(id, { name: "Waiting Lead", contact: { phone: "+971501230005" } });
    expect(e.status).toBe("queued");
    expect(await src(id)).toMatchObject({ status: "needs_attention", attention_code: "RUN_AS_ACCESS" });
    expect((await src(id)).last_error).toMatch(/can no longer add leads/);
    await h.grant(rep, [{ key: "leads.import", scope: "all" }]);
    await processEvent({ app: h.app, pool: h.pool, keyring: h.keyring }, Number(e.id));
    expect(await lastEvent(id)).toMatchObject({ status: "done", result: "created" });
  });

  it("a path the mapping doesn't know is offered as a new field", async () => {
    const id = await source();
    await send(id, { name: "New Path", contact: { phone: "+971501230006" }, utm: { campaign: "autumn" } });
    expect((await src(id)).new_columns).toEqual(["utm.campaign"]);
  });

  it("a webhook lead counts as an arrival for the person it runs as", async () => {
    await admin.inject({ method: "POST", url: "/api/v1/leads/arrivals/seen" });
    const id = await source();
    await send(id, { name: "Arrival Hook", contact: { phone: "+971501230007" } });
    expect((await admin.inject({ method: "GET", url: "/api/v1/leads/arrivals" })).json().count).toBe(1);
  });
});
