import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { startMetaFake, type MetaFake } from "../../../test/meta-fake";
import { deliver, RELAY_TOKEN, seedNumber } from "../../../test/whatsapp";
import { sweepNumberHealth } from "./health";

/**
 * The number's quality and Meta's tier (Autopilot A2, Task 4; spec 2026-10-19 §6): kept current from Meta, a drop to
 * yellow or red told to admins once (and, from Task 6, every LUME AI run on it paused).
 */
let h: Harness;
let meta: MetaFake;
type U = { id: string; email: string; password: string };
let admin: U;
let number: { id: string; phone_number_id: string; waba_id: string; display_phone: string };

const healthOf = async () =>
  (
    await h.ownerPool.query<{
      quality: string | null;
      messaging_tier: string | null;
      health_at: Date | null;
    }>("SELECT quality, messaging_tier, health_at FROM whatsapp_numbers WHERE id = $1", [number.id])
  ).rows[0]!;
// As the admin sees them (row-level secured to their person: not deletable here), from this test only.
let since = new Date();
const told = async () =>
  (
    (await (await h.signIn(admin)).inject({ method: "GET", url: "/api/v1/notifications" })).json().items as {
      title: string;
      body: string;
      createdAt: string;
    }[]
  )
    .filter((n) => n.title.startsWith("WhatsApp rated") && new Date(n.createdAt) >= since)
    .map((n) => ({ title: n.title, body: n.body }));
const sweep = () =>
  sweepNumberHealth(h.ownerPool, {
    meta: { graphUrl: meta.url, version: meta.version },
    keyring: h.keyring,
    clock: () => h.clock.now,
  });

beforeAll(async () => {
  meta = await startMetaFake();
  h = await createHarness({
    oauth: { relayToken: RELAY_TOKEN },
    meta: { graphUrl: meta.url, version: meta.version },
  });
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
  await meta.close();
});
beforeEach(async () => {
  await h.ownerPool.query("DELETE FROM whatsapp_numbers");
  since = new Date();
  const id = await seedNumber(h, { runAs: admin.id });
  number = (
    await h.ownerPool.query(
      "SELECT id, phone_number_id, waba_id, display_phone FROM whatsapp_numbers WHERE id = $1",
      [id],
    )
  ).rows[0];
  meta.health.clear();
});

describe("the number's quality and Meta's tier", () => {
  it("read from Meta, and kept current: a number not read for a day is read again", async () => {
    meta.health.set(number.phone_number_id, { quality: "GREEN", tier: "TIER_1K" });
    await sweep();
    expect(await healthOf()).toMatchObject({ quality: "green", messaging_tier: "TIER_1K" });
    meta.health.set(number.phone_number_id, { quality: "GREEN", tier: "TIER_10K" });
    await sweep(); // read an hour ago: left alone
    expect((await healthOf()).messaging_tier).toBe("TIER_1K");
    h.clock.advance(25 * 3_600_000);
    await sweep();
    expect((await healthOf()).messaging_tier).toBe("TIER_10K");
  });

  it("a drop to yellow tells admins once, in words", async () => {
    meta.health.set(number.phone_number_id, { quality: "GREEN", tier: "TIER_1K" });
    await sweep();
    meta.health.set(number.phone_number_id, { quality: "YELLOW", tier: "TIER_1K" });
    h.clock.advance(25 * 3_600_000);
    await sweep();
    h.clock.advance(25 * 3_600_000);
    await sweep();
    expect(await told()).toEqual([
      {
        title: `WhatsApp rated ${number.display_phone} yellow`,
        body: "LUME paused LUME AI's runs on it to protect the number. Its quality recovers as people reply and fewer block it.",
      },
    ]);
  });

  it("Meta's webhook: the tier changes at once, and a flag counts as a drop", async () => {
    const res = await deliver(h, {
      object: "whatsapp_business_account",
      entry: [
        {
          id: number.waba_id,
          time: 1,
          changes: [
            {
              field: "phone_number_quality_update",
              value: {
                display_phone_number: number.display_phone,
                event: "FLAGGED",
                current_limit: "TIER_250",
              },
            },
          ],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(await healthOf()).toMatchObject({ quality: "yellow", messaging_tier: "TIER_250" });
    expect(await told()).toHaveLength(1);
  });
});
