import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@lume/core";
import { createHarness, type Harness } from "../../../test/harness";
import { sealWebhook, signFor, type WebhookConfig } from "./secret";

let h: Harness;
const SECRET = "s".repeat(43);

beforeAll(async () => {
  h = await createHarness({ preset: "general" });
  await h.ownerPool.query(
    `UPDATE settings SET integrations = integrations || '{"webhooks":{"enabled":true}}'::jsonb WHERE id = 1`,
  );
});
afterAll(() => h.close());

async function source(o: { mode?: WebhookConfig["mode"]; status?: string } = {}) {
  const id = newId();
  await h.ownerPool.query(
    `INSERT INTO lead_sources (id, type, name, status, config_enc) VALUES ($1, 'webhook', 'Site form', $2, $3)`,
    [
      id,
      o.status ?? "active",
      sealWebhook(h.keyring, id, { mode: o.mode ?? "signed", secret: SECRET, preset: "website" }),
    ],
  );
  return id;
}
const now = () => String(Math.floor(h.clock.now.getTime() / 1000));
const signed = (raw: string, ts = now(), secret = SECRET) => ({
  "x-lume-timestamp": ts,
  "x-lume-signature": signFor(secret, ts, Buffer.from(raw)),
});
const post = (id: string, raw: string, headers: Record<string, string> = {}, type = "application/json") =>
  h.app.inject({
    method: "POST",
    url: `/webhooks/in/${id}`,
    headers: { "content-type": type, ...headers },
    payload: raw,
  });
const events = (id: string) =>
  h.ownerPool
    .query<{ id: string; status: string }>("SELECT id, status FROM webhook_events WHERE source_id = $1", [id])
    .then((r) => r.rows);
const counts = (id: string) =>
  h.ownerPool
    .query<{ rejected: number; last_rejected_reason: string | null; last_event_at: Date | null }>(
      "SELECT rejected, last_rejected_reason, last_event_at FROM lead_sources WHERE id = $1",
      [id],
    )
    .then((r) => r.rows[0]!);

describe("a signed source (2C spec §4)", () => {
  it("accepts a good signature, keeps the post once and queues it", async () => {
    const id = await source();
    const raw = JSON.stringify({ name: "Aisha Khan", phone: "+971501234567" });
    const r = await post(id, raw, signed(raw));
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ accepted: true });
    const [e] = await events(id);
    expect(e).toMatchObject({ status: "queued" });
    expect(h.webhookQueue).toContain(Number(e!.id));
    expect((await counts(id)).last_event_at).not.toBeNull();
  });

  it("refuses a bad signature, a stale one, and none at all — and counts each", async () => {
    const id = await source();
    const raw = JSON.stringify({ name: "A" });
    expect((await post(id, raw, signed(raw, now(), "x".repeat(43)))).statusCode).toBe(401);
    const old = String(Number(now()) - 301);
    expect((await post(id, raw, signed(raw, old))).statusCode).toBe(401);
    expect((await post(id, raw)).statusCode).toBe(401);
    expect(await events(id)).toHaveLength(0);
    // The last one (none at all) is a bad signature; the stale one is counted as itself.
    await vi.waitFor(async () =>
      expect(await counts(id)).toMatchObject({ rejected: 3, last_rejected_reason: "bad_signature" }),
    );
  });

  it("Review Focus 2: the signature covers the raw body, so whitespace matters", async () => {
    const id = await source();
    const r = await post(id, '{ "a": 1 }', signed('{"a":1}'));
    expect(r.statusCode).toBe(401);
  });
});

describe("a token source", () => {
  it("accepts the right X-Lume-Token and refuses a wrong one", async () => {
    const id = await source({ mode: "token" });
    expect((await post(id, '{"name":"A"}', { "x-lume-token": SECRET })).statusCode).toBe(202);
    expect((await post(id, '{"name":"B"}', { "x-lume-token": "t".repeat(43) })).statusCode).toBe(401);
    await vi.waitFor(async () =>
      expect(await counts(id)).toMatchObject({ rejected: 1, last_rejected_reason: "bad_token" }),
    );
  });
});

describe("what a stranger learns", () => {
  it("Review Focus 1: an unknown source answers exactly like a bad secret", async () => {
    const id = await source();
    const raw = '{"a":1}';
    const bad = await post(id, raw, signed(raw, now(), "x".repeat(43)));
    const unknown = await post(newId(), raw, signed(raw));
    expect(unknown.statusCode).toBe(401);
    expect(unknown.body).toBe(bad.body);
    expect(unknown.json()).toEqual({ error: "unauthorized" });
  });

  it("a paused source asks the sender to come back later; with the module off, nothing is known", async () => {
    const paused = await source({ status: "paused" });
    const raw = '{"a":1}';
    const r = await post(paused, raw, signed(raw));
    expect(r.statusCode).toBe(503);
    expect(r.headers["retry-after"]).toBe("3600");
    expect(await events(paused)).toHaveLength(0);

    const id = await source();
    await h.ownerPool.query(
      `UPDATE settings SET integrations = integrations || '{"webhooks":{"enabled":false}}'::jsonb WHERE id = 1`,
    );
    const off = await post(id, raw, signed(raw));
    await h.ownerPool.query(
      `UPDATE settings SET integrations = integrations || '{"webhooks":{"enabled":true}}'::jsonb WHERE id = 1`,
    );
    expect(off.statusCode).toBe(401);
    expect(await events(id)).toHaveLength(0);
  });
});

describe("replays", () => {
  it("the same event id twice is one event; the second is a duplicate", async () => {
    const id = await source();
    const a = '{"name":"A"}';
    const b = '{"name":"A","again":true}';
    expect((await post(id, a, { ...signed(a), "x-lume-event-id": "evt-1" })).json()).toEqual({
      accepted: true,
    });
    expect((await post(id, b, { ...signed(b), "x-lume-event-id": "evt-1" })).json()).toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(await events(id)).toHaveLength(1);
  });

  it("a captured signed post sent again under a fresh event id is a duplicate (the signature works once)", async () => {
    const id = await source();
    const raw = '{"name":"Replayed"}';
    const headers = signed(raw);
    expect((await post(id, raw, { ...headers, "x-lume-event-id": "evt-a" })).json()).toEqual({
      accepted: true,
    });
    expect((await post(id, raw, { ...headers, "x-lume-event-id": "evt-b" })).json()).toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(await events(id)).toHaveLength(1);
  });

  it("a stale timestamp is counted as itself, not as a bad signature", async () => {
    const id = await source();
    const raw = '{"name":"Late"}';
    expect((await post(id, raw, signed(raw, String(Number(now()) - 301)))).statusCode).toBe(401);
    await vi.waitFor(async () =>
      expect(await counts(id)).toMatchObject({ rejected: 1, last_rejected_reason: "stale_timestamp" }),
    );
  });

  it("with no event id, identical bodies are one event", async () => {
    const id = await source();
    const raw = '{"name":"Same"}';
    await post(id, raw, signed(raw));
    await post(id, raw, signed(raw));
    expect(await events(id)).toHaveLength(1);
  });

  it("Review Focus 3: five identical posts at once make one event", async () => {
    const id = await source();
    const raw = '{"name":"Burst"}';
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(id, raw, signed(raw))));
    expect(rs.map((r) => r.statusCode)).toEqual([202, 202, 202, 202, 202]);
    expect(await events(id)).toHaveLength(1);
  });
});

describe("limits and shapes", () => {
  it("the 61st post in a minute waits (429 with Retry-After), and is counted", async () => {
    const id = await source();
    for (let i = 0; i < 60; i++) {
      const raw = JSON.stringify({ n: i });
      expect((await post(id, raw, signed(raw))).statusCode).toBe(202);
    }
    const raw = '{"n":60}';
    const r = await post(id, raw, signed(raw));
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    await vi.waitFor(async () =>
      expect(await counts(id)).toMatchObject({ rejected: 1, last_rejected_reason: "rate_limited" }),
    );
  });

  it("too big is 413, a text body 415, bad JSON 400 — each counted, none stored", async () => {
    const id = await source();
    const big = JSON.stringify({ note: "x".repeat(65 * 1024) });
    expect((await post(id, big, signed(big))).statusCode).toBe(413);
    expect((await post(id, "name=A", signed("name=A"), "text/plain")).statusCode).toBe(415);
    expect((await post(id, "{nope", signed("{nope"))).statusCode).toBe(400);
    expect(await events(id)).toHaveLength(0);
    await vi.waitFor(async () =>
      expect(await counts(id)).toMatchObject({ rejected: 3, last_rejected_reason: "bad_json" }),
    );
  });

  it("a plain HTML form's body is accepted", async () => {
    const id = await source();
    const raw = "name=Aisha+Khan&phone=0501234567";
    expect((await post(id, raw, signed(raw), "application/x-www-form-urlencoded")).statusCode).toBe(202);
    expect(await events(id)).toHaveLength(1);
  });
});

describe("while setting up", () => {
  it("a draft source keeps an authenticated post as its test post, and doesn't queue it", async () => {
    const id = await source({ status: "draft" });
    const raw = '{"name":"Test post"}';
    expect((await post(id, raw, signed(raw))).statusCode).toBe(202);
    const [e] = await events(id);
    expect(e).toMatchObject({ status: "test" });
    expect(h.webhookQueue).not.toContain(Number(e!.id));
  });
});

describe("final review", () => {
  it("Important 3: posts to addresses that don't exist never spend a real sender's share", async () => {
    const id = await source();
    for (let i = 0; i < 610; i++) await post(newId(), "{}", signed("{}"));
    const raw = '{"name":"Real sender"}';
    expect((await post(id, raw, signed(raw))).statusCode).toBe(202);
  });

  it("Important 5: an unknown address and a wrong secret do the same work before answering", async () => {
    const id = await source();
    const raw = '{"a":1}';
    const spy = vi.spyOn(h.keyring, "decrypt");
    await post(newId(), raw, signed(raw));
    const forUnknown = spy.mock.calls.length;
    spy.mockClear();
    await post(id, raw, signed(raw, now(), "x".repeat(43)));
    expect(spy.mock.calls.length).toBe(forUnknown);
    spy.mockRestore();
  });

  it("Important 5: counting a refusal never holds up the answer", async () => {
    const id = await source();
    const holder = await h.ownerPool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM lead_sources WHERE id = $1 FOR UPDATE", [id]); // the counter's row, held
    const raw = '{"a":1}';
    const started = Date.now();
    const r = await post(id, raw, signed(raw, now(), "x".repeat(43)));
    const took = Date.now() - started;
    await holder.query("ROLLBACK");
    holder.release();
    expect(r.statusCode).toBe(401);
    expect(took).toBeLessThan(1000);
    await vi.waitFor(async () => expect((await counts(id)).rejected).toBe(1));
  });
});
