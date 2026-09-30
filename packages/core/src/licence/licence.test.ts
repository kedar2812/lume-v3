import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkBody,
  licenceState,
  rawPublicKey,
  signLicence,
  verifyLicence,
  type LicencePayload,
} from "./index";

const pair = () => generateKeyPairSync("ed25519");
const k1 = pair();
const k2 = pair();
const KEYS = { k1: rawPublicKey(k1.publicKey) };
const at = (s: string) => new Date(s);
const H = 3_600_000;
const D = 24 * H;

const payload = (over: Partial<LicencePayload> = {}): LicencePayload => ({
  v: 1,
  kid: "k1",
  instanceId: "LUME-H4RB-8C2L",
  state: "active",
  licenseType: "subscription",
  issuedAt: "2026-09-30T10:00:00.000Z",
  validUntil: "2026-10-08T10:00:00.000Z",
  paidUntil: "2026-10-26",
  trialEndsAt: null,
  reason: "paid",
  notice: null,
  ...over,
});

describe("the licence token", () => {
  it("round-trips: signed on the server, verified in the instance", () => {
    const t = signLicence(payload(), k1.privateKey);
    expect(verifyLicence(t, KEYS, "LUME-H4RB-8C2L")).toEqual(payload());
  });

  it("refuses a payload changed after signing", () => {
    const t = signLicence(payload(), k1.privateKey);
    const [, sig] = t.split(".");
    const forged = Buffer.from(
      JSON.stringify(payload({ state: "active", paidUntil: "2099-01-01" })),
    ).toString("base64url");
    expect(verifyLicence(`${forged}.${sig}`, KEYS, "LUME-H4RB-8C2L")).toBeNull();
  });

  it("refuses the same payload re-encoded (padding, other JSON spacing)", () => {
    const t = signLicence(payload(), k1.privateKey);
    const [body, sig] = t.split(".");
    const spaced = Buffer.from(JSON.stringify(payload(), null, 1)).toString("base64url");
    expect(verifyLicence(`${spaced}.${sig}`, KEYS, "LUME-H4RB-8C2L")).toBeNull();
    expect(verifyLicence(`${body}=.${sig}`, KEYS, "LUME-H4RB-8C2L")).toBeNull();
    expect(verifyLicence(`${body}.${sig}=`, KEYS, "LUME-H4RB-8C2L")).toBeNull();
  });

  it("refuses a key it doesn't know, a key that isn't LUME's, and another instance's token", () => {
    expect(
      verifyLicence(signLicence(payload({ kid: "k9" }), k1.privateKey), KEYS, "LUME-H4RB-8C2L"),
    ).toBeNull();
    expect(verifyLicence(signLicence(payload(), k2.privateKey), KEYS, "LUME-H4RB-8C2L")).toBeNull();
    expect(verifyLicence(signLicence(payload(), k1.privateKey), KEYS, "LUME-0THR-1NST")).toBeNull();
  });

  it("a payment reminder may say how to reach the provider", () => {
    const notice = {
      id: "n2",
      kind: "payment_due" as const,
      dueDate: null,
      note: "",
      contact: "mailto:billing@lumecrm.in",
    };
    const t = signLicence(payload({ notice }), k1.privateKey);
    expect(verifyLicence(t, KEYS, "LUME-H4RB-8C2L")?.notice).toEqual(notice);
  });

  it("refuses nonsense, and a signed payload that isn't a licence", () => {
    for (const t of ["", "abc", "a.b.c", "..", `${"x".repeat(5000)}.y`])
      expect(verifyLicence(t, KEYS, "x")).toBeNull();
    const bad = { ...payload(), state: "unlimited" } as unknown as LicencePayload;
    expect(verifyLicence(signLicence(bad, k1.privateKey), KEYS, "LUME-H4RB-8C2L")).toBeNull();
    const v2 = { ...payload(), v: 2 } as unknown as LicencePayload;
    expect(verifyLicence(signLicence(v2, k1.privateKey), KEYS, "LUME-H4RB-8C2L")).toBeNull();
  });
});

describe("the licence state (what the instance does with it)", () => {
  const issued = at("2026-09-30T10:00:00Z");
  const state = (o: {
    p?: LicencePayload | null;
    now: Date;
    last?: Date | null;
    first?: Date;
    dev?: boolean;
  }) =>
    licenceState({
      payload: o.p === undefined ? payload() : o.p,
      lastSuccessAt: o.last === undefined ? issued : o.last,
      firstBootAt: o.first ?? at("2026-09-01T00:00:00Z"),
      now: o.now,
      dev: o.dev ?? false,
    });

  it("follows the server while it's reachable", () => {
    expect(state({ now: new Date(issued.getTime() + H) })).toMatchObject({ state: "active", reason: "paid" });
    expect(state({ p: payload({ state: "grace", reason: "overdue" }), now: issued })).toMatchObject({
      state: "grace",
      reason: "overdue",
    });
  });

  it("unreachable: no change under 24 hours, grace from 24 hours to 7 days, read-only after", () => {
    const after = (ms: number) => new Date(issued.getTime() + ms);
    expect(state({ now: after(24 * H - 60_000) }).state).toBe("active");
    expect(state({ now: after(24 * H) })).toMatchObject({ state: "grace", reason: "unreachable" });
    expect(state({ now: after(7 * D - 60_000) }).state).toBe("grace");
    expect(state({ now: after(7 * D) })).toMatchObject({ state: "read_only", reason: "unreachable" });
    // Grace says when it ends.
    expect(state({ now: after(2 * D) }).graceEndsAt).toBe(after(7 * D).toISOString());
  });

  it("an expired token is read-only even while the server still answers (refusing the key)", () => {
    expect(state({ now: at("2026-10-08T10:00:01Z"), last: at("2026-10-08T09:00:00Z") })).toMatchObject({
      state: "read_only",
      reason: "expired",
    });
  });

  it("a clock set back before the token was issued is read-only", () => {
    expect(state({ now: new Date(issued.getTime() - 5 * 60_000 - 1) })).toMatchObject({
      state: "read_only",
      reason: "clock",
    });
    expect(state({ now: new Date(issued.getTime() - 4 * 60_000) }).state).toBe("active");
  });

  it("the worst wins: suspended stays suspended, whatever else", () => {
    const p = payload({ state: "suspended", reason: "suspended" });
    expect(state({ p, now: new Date(issued.getTime() + 8 * D) })).toMatchObject({ state: "suspended" });
    expect(state({ p, now: new Date(issued.getTime() - D) })).toMatchObject({ state: "suspended" });
  });

  it("a new install that hasn't checked yet: grace for 7 days from first boot, then read-only", () => {
    const first = at("2026-09-30T00:00:00Z");
    expect(state({ p: null, last: null, first, now: at("2026-09-30T01:00:00Z") })).toMatchObject({
      state: "grace",
      reason: "not_checked",
      graceEndsAt: "2026-10-07T00:00:00.000Z",
    });
    expect(state({ p: null, last: null, first, now: at("2026-10-07T00:00:00Z") })).toMatchObject({
      state: "read_only",
      reason: "not_checked",
    });
  });

  it("carries what people see: type, paid until, the notice, when it last checked", () => {
    const notice = { id: "n1", kind: "payment_due" as const, dueDate: "2026-09-26", note: "UPI is fine" };
    expect(state({ p: payload({ notice }), now: issued })).toMatchObject({
      licenseType: "subscription",
      paidUntil: "2026-10-26",
      notice,
      checkedAt: issued.toISOString(),
      dev: false,
    });
  });

  it("dev mode is always active and says so", () => {
    expect(state({ p: null, last: null, now: at("2030-01-01T00:00:00Z"), dev: true })).toMatchObject({
      state: "active",
      reason: "dev",
      dev: true,
    });
  });
});

describe("what the check sends (spec §2.4: only this)", () => {
  it("exactly six fields, and nothing about any lead", () => {
    const body = checkBody({
      instanceId: "LUME-H4RB-8C2L",
      licenseKey: "LUME-HC-K7PX-2MWD-9RTA",
      appVersion: "1.4.2",
      activeUserCount: 6,
      leadCount: 1284,
      now: at("2026-09-30T10:00:00Z"),
    });
    expect(Object.keys(body).sort()).toEqual(
      ["activeUserCount", "appVersion", "instanceId", "leadCount", "licenseKey", "serverTime"].sort(),
    );
    expect(body.serverTime).toBe("2026-09-30T10:00:00.000Z");
  });
});

describe("the keys LUME trusts", () => {
  it("has the licence server's production key, and every key is a raw 32-byte Ed25519 public key", async () => {
    const { LICENCE_KEYS } = await import("./keys");
    expect(Object.keys(LICENCE_KEYS)).toContain("lume-1");
    for (const [kid, raw] of Object.entries(LICENCE_KEYS)) {
      expect(kid).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(Buffer.from(raw, "base64url")).toHaveLength(32);
    }
  });
});
