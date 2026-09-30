import { createPublicKey, type KeyObject } from "node:crypto";
import { rawPublicKey, signLicence, type LicencePayload } from "@lume/core";

/** The private key (from the secrets file) and the `kid` its public half ships under in LUME's releases. */
export type Signer = { kid: string; privateKey: KeyObject };

/**
 * Why this signer would sign answers no LUME release accepts, or null. Checked at start: a mismatch would
 * otherwise go unseen until every client's LUME turned read-only.
 */
export function signerProblem(signer: Signer, trusted: Record<string, string>): string | null {
  const want = Object.hasOwn(trusted, signer.kid) ? trusted[signer.kid] : undefined;
  if (!want)
    return `LICENCE_KID ${signer.kid} isn't one of the keys LUME's releases trust (packages/core/src/licence/keys.ts)`;
  if (rawPublicKey(createPublicKey(signer.privateKey)) !== want)
    return `the signing key doesn't match the public key LUME's releases trust for ${signer.kid}`;
  return null;
}

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
