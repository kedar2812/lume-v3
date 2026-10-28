import { generateKeyPairSync } from "node:crypto";
import {
  rawPublicKey,
  signLicence,
  type LicencePayload,
  type LicenceStateName,
  type PlanClaim,
} from "@lume/core";
import type { AppDeps } from "../src/app";

const D = 86_400_000;

/**
 * A licence server for a test: a LUME in enforce mode whose check-ins answer with a token signed here, carrying the plan
 * the test sets. After `setPlan`, a check-in (POST /api/v1/licence/check as an admin) brings it in; after `setState`,
 * `h.app.licence.check()` does (a locked licence refuses the route's POST).
 */
export function testLicence(o: { instanceId: string; now: () => Date }) {
  const server = generateKeyPairSync("ed25519");
  let plan: PlanClaim | undefined;
  let state: LicenceStateName = "active";
  const token = () =>
    signLicence(
      {
        v: 1,
        kid: "t1",
        instanceId: o.instanceId,
        state,
        licenseType: "subscription",
        issuedAt: o.now().toISOString(),
        validUntil: new Date(o.now().getTime() + 8 * D).toISOString(),
        paidUntil: "2027-12-31",
        trialEndsAt: null,
        reason: "paid",
        notice: null,
        ...(plan ? { plan } : {}),
      } satisfies LicencePayload,
      server.privateKey,
    );
  const options: NonNullable<AppDeps["licence"]> = {
    mode: "enforce",
    instanceId: o.instanceId,
    licenseKey: `KEY-${o.instanceId}`,
    url: "https://licence.test",
    keys: { t1: rawPublicKey(server.publicKey) },
    version: "1.7.0",
    fetch: (async () => new Response(JSON.stringify({ token: token() }), { status: 200 })) as typeof fetch,
  };
  return {
    options,
    setPlan(p: PlanClaim | undefined) {
      plan = p;
    },
    setState(s: LicenceStateName) {
      state = s;
    },
  };
}

/** Every module in the plan (the shape a plan claim names them in). */
export const ALL_MODULES = {
  googleSheets: true,
  webhooks: true,
  googleCalendar: true,
  calendly: true,
  ai: true,
  whatsapp: true,
};
