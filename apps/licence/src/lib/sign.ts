import type { KeyObject } from "node:crypto";
import { signLicence, type LicencePayload } from "@lume/core";

/** The private key (from the secrets file) and the `kid` its public half ships under in LUME's releases. */
export type Signer = { kid: string; privateKey: KeyObject };

/** A token is good for 8 days (spec §2): an instance that can't reach the server keeps working that long. */
const VALID_MS = 8 * 86_400_000;

export function issueToken(
  signer: Signer,
  now: Date,
  p: Omit<LicencePayload, "v" | "kid" | "issuedAt" | "validUntil">,
): string {
  return signLicence(
    {
      v: 1,
      kid: signer.kid,
      instanceId: p.instanceId,
      state: p.state,
      licenseType: p.licenseType,
      issuedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + VALID_MS).toISOString(),
      paidUntil: p.paidUntil,
      trialEndsAt: p.trialEndsAt,
      reason: p.reason,
      notice: p.notice,
    },
    signer.privateKey,
  );
}
