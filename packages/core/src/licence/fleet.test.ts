import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { capHealth, HEALTH_PROBLEMS, type FleetHealth } from "./fleet";
import { licenceState, type LicencePayload } from "./state";
import { checkBody, rawPublicKey, signLicence, verifyLicence } from "./token";

const now = new Date("2026-10-16T10:00:00Z");
const base = {
  instanceId: "LUME-K7RD-2MXQ",
  licenseKey: "LUME-AAAA-BBBB-CCCC-DDDD-EEEE",
  installId: "0190e0c0-0000-7000-8000-00000000fb01",
  appVersion: "1.5.0",
  activeUserCount: 14,
  leadCount: 11870,
  now,
};
const health: FleetHealth = {
  uptimeS: 1_036_800,
  dbBytes: 2_040_109_465,
  diskFreePct: 4,
  errors24h: 2,
  queue: { waiting: 4, retrying: 0, failed24h: 3 },
  remindersLate: 0,
  restoreTest: { at: "2026-10-14T03:15:00.000Z", ok: true },
  problems: ["jobs_failed"],
  sourcesNeedingAttention: 0,
};

describe("checkBody", () => {
  it("is exactly today's body when nothing new is given, so an older licence server takes it", () => {
    expect(Object.keys(checkBody(base)).sort()).toEqual(
      [
        "activeUserCount",
        "appVersion",
        "installId",
        "instanceId",
        "leadCount",
        "licenseKey",
        "serverTime",
      ].sort(),
    );
  });
  it("carries what this LUME can show, its health and the seen counts, when given", () => {
    const b = checkBody({ ...base, accepts: ["announcements"], health, seen: [{ id: "a1", people: 9 }] });
    expect(b).toMatchObject({ accepts: ["announcements"], health, seen: [{ id: "a1", people: 9 }] });
    expect(checkBody({ ...base, health: null })).not.toHaveProperty("health");
  });
});

describe("capHealth", () => {
  it("keeps known problem keys once each, whole numbers, and a percentage between 0 and 100", () => {
    const h = capHealth({
      ...health,
      uptimeS: 12.7,
      diskFreePct: 140,
      errors24h: -3,
      queue: { waiting: 1e12, retrying: 1, failed24h: 2.2 },
      problems: ["jobs_failed", "jobs_failed", "Sheet: Instagram leads" as never, "source"],
    });
    expect(h.uptimeS).toBe(12);
    expect(h.diskFreePct).toBe(100);
    expect(h.errors24h).toBe(0);
    expect(h.queue).toEqual({ waiting: 1_000_000_000, retrying: 1, failed24h: 2 });
    expect(h.problems).toEqual(["jobs_failed", "source"]);
    expect(HEALTH_PROBLEMS).toHaveLength(7);
  });
});

describe("announcements in the signed answer", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keys = { "lume-1": rawPublicKey(publicKey) };
  const payload = (over: Partial<LicencePayload> = {}): LicencePayload => ({
    v: 1,
    kid: "lume-1",
    instanceId: base.instanceId,
    state: "active",
    licenseType: "subscription",
    issuedAt: now.toISOString(),
    validUntil: "2026-10-24T10:00:00.000Z",
    paidUntil: "2026-11-05",
    trialEndsAt: null,
    reason: "paid",
    notice: null,
    ...over,
  });
  const claim = {
    id: "0190e0c0-0000-7000-8000-0000000000a1",
    title: "LUME will be updated on Saturday night",
    body: "LUME will be away for about 30 minutes while it’s updated.",
    kind: "maintenance" as const,
    audience: "admins" as const,
    windowStart: "2026-10-18T16:30:00.000Z",
    windowEnd: "2026-10-18T17:00:00.000Z",
    endsAt: "2026-10-19T00:00:00.000Z",
  };

  it("verifies with up to three, and three long ones still fit", () => {
    const long = { ...claim, title: "ä".repeat(80), body: "अ".repeat(600) };
    const t = signLicence(
      payload({
        announcements: [
          long,
          { ...long, id: claim.id.replace("a1", "a2") },
          { ...long, id: claim.id.replace("a1", "a3") },
        ],
      }),
      privateKey,
    );
    expect(verifyLicence(t, keys, base.instanceId)?.announcements).toHaveLength(3);
  });
  it("refuses a claim with a key it doesn't know", () => {
    const t = signLicence(payload({ announcements: [{ ...claim, link: "https://x" } as never] }), privateKey);
    expect(verifyLicence(t, keys, base.instanceId)).toBeNull();
  });
  it("keeps the ones that haven't ended in the view, and none when the answer has none", () => {
    const view = licenceState({
      payload: payload({
        announcements: [
          claim,
          { ...claim, id: claim.id.replace("a1", "a2"), endsAt: "2026-10-15T00:00:00.000Z" },
        ],
      }),
      lastSuccessAt: now,
      firstBootAt: now,
      now,
      dev: false,
    });
    expect(view.announcements.map((a) => a.id)).toEqual([claim.id]);
    expect(
      licenceState({ payload: payload(), lastSuccessAt: now, firstBootAt: now, now, dev: false })
        .announcements,
    ).toEqual([]);
  });
});
