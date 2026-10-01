import { createHmac } from "node:crypto";
import { newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { CALENDLY_DEFAULTS, sealCalendly } from "./config";

let h: Harness;
const KEY = "signing-key-".repeat(4);

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
});
afterAll(() => h.close());

async function source(status = "active") {
  const id = newId();
  await h.ownerPool.query(
    "INSERT INTO lead_sources (id, type, name, status, config_enc) VALUES ($1, 'calendly', 'Calendly', $2, $3)",
    [
      id,
      status,
      sealCalendly(h.keyring, id, {
        token: "cal_token",
        signingKey: KEY,
        subscription: "https://api.calendly.com/webhook_subscriptions/x",
        scope: "organization",
        organization: "https://api.calendly.com/organizations/o",
        user: "https://api.calendly.com/users/u",
        account: { name: "Maya Kapoor", email: "maya@business.test" },
        settings: CALENDLY_DEFAULTS,
      }),
    ],
  );
  return id;
}

/** Signed as Calendly documents it: v1 = hex HMAC-SHA256 of "<t>.<raw body>" with the subscription's key. */
const signature = (raw: string, at = h.clock.now.getTime(), key = KEY) => {
  const t = Math.floor(at / 1000);
  return `t=${t},v1=${createHmac("sha256", key).update(`${t}.${raw}`).digest("hex")}`;
};
const booking = (invitee = "INV1", event = "invitee.created") =>
  JSON.stringify({
    event,
    created_at: "2026-09-21T09:00:00.000000Z",
    payload: {
      email: "dana@client.test",
      name: "Dana Lead",
      uri: `https://api.calendly.com/scheduled_events/EV1/invitees/${invitee}`,
      scheduled_event: {
        name: "Discovery call",
        start_time: "2026-09-22T10:00:00Z",
        end_time: "2026-09-22T10:30:00Z",
      },
    },
  });
const post = (id: string, raw: string, sig: string | null = signature(raw)) =>
  h.app.inject({
    method: "POST",
    url: `/webhooks/calendly/${id}`,
    headers: { "content-type": "application/json", ...(sig ? { "calendly-webhook-signature": sig } : {}) },
    payload: raw,
  });
const events = (id: string) =>
  h.ownerPool
    .query<{ id: string; status: string; event_key: string }>(
      "SELECT id, status, event_key FROM webhook_events WHERE source_id = $1 ORDER BY id",
      [id],
    )
    .then((r) => r.rows);
const counts = (id: string) =>
  h.ownerPool
    .query<{ rejected: number; last_rejected_reason: string | null }>(
      "SELECT rejected, last_rejected_reason FROM lead_sources WHERE id = $1",
      [id],
    )
    .then((r) => r.rows[0]!);

describe("receiving Calendly's posts (5B Task 5)", () => {
  it("a signed booking is accepted, kept sealed once, and queued", async () => {
    const id = await source();
    h.webhookQueue.length = 0;
    const raw = booking();
    const r = await post(id, raw);
    expect([r.statusCode, r.json()]).toEqual([202, { accepted: true }]);
    const [e] = await events(id);
    expect(e).toMatchObject({
      status: "queued",
      event_key: "invitee.created:https://api.calendly.com/scheduled_events/EV1/invitees/INV1",
    });
    expect(h.webhookQueue).toEqual([Number(e!.id)]);
    const row = JSON.stringify(
      (await h.ownerPool.query("SELECT * FROM webhook_events WHERE id = $1", [e!.id])).rows,
    );
    expect(row).not.toContain("dana@client.test");
  });

  it("the same delivery again (newly signed) is one event; a replayed signature is a duplicate", async () => {
    const id = await source();
    const raw = booking("INV2");
    expect((await post(id, raw)).statusCode).toBe(202);
    const again = await post(id, raw, signature(raw, h.clock.now.getTime() + 1000));
    expect([again.statusCode, again.json()]).toEqual([202, { accepted: true, duplicate: true }]);
    const replay = await post(id, raw, signature(raw, h.clock.now.getTime() + 1000));
    expect(replay.json()).toEqual({ accepted: true, duplicate: true });
    expect(await events(id)).toHaveLength(1);
  });

  it("a bad, missing or stale signature is refused alike, and counted", async () => {
    const id = await source();
    const raw = booking("INV3");
    const bad = await post(id, raw, signature(raw, undefined, "another-key".repeat(4)));
    expect([bad.statusCode, bad.json()]).toEqual([401, { error: "unauthorized" }]);
    expect((await post(id, raw, null)).statusCode).toBe(401);
    expect((await post(id, raw, "t=abc,v1=zz")).statusCode).toBe(401);
    const stale = await post(id, raw, signature(raw, h.clock.now.getTime() - 6 * 60_000));
    expect(stale.statusCode).toBe(401);
    await new Promise((r) => setTimeout(r, 200)); // counted after the answer
    expect(await counts(id)).toEqual({ rejected: 4, last_rejected_reason: "stale_timestamp" });
    expect(await events(id)).toEqual([]);
  });

  it("an unknown or disconnected Calendly is refused the same way", async () => {
    const raw = booking("INV4");
    expect((await post(newId(), raw)).statusCode).toBe(401);
    expect((await post("not-a-uuid", raw)).statusCode).toBe(401);
    const gone = await source("archived");
    expect((await post(gone, raw)).statusCode).toBe(401);
  });

  it("other Calendly events are acknowledged and not kept", async () => {
    const id = await source();
    const raw = booking("INV5", "routing_form_submission.created");
    const r = await post(id, raw);
    expect([r.statusCode, r.json()]).toEqual([202, { accepted: true, ignored: true }]);
    expect(await events(id)).toEqual([]);
  });

  it("a cancellation is kept as its own event", async () => {
    const id = await source();
    expect((await post(id, booking("INV6"))).statusCode).toBe(202);
    expect((await post(id, booking("INV6", "invitee.canceled"))).statusCode).toBe(202);
    expect((await events(id)).map((e) => e.event_key.split(":")[0])).toEqual([
      "invitee.created",
      "invitee.canceled",
    ]);
  });
});
