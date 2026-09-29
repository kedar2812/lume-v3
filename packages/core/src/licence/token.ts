import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { licencePayloadSchema, type LicencePayload } from "./state";

/** Ed25519's DER prefix for a raw 32-byte public key (SubjectPublicKeyInfo). */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN = 4096;

/** A public key as LUME ships it: its raw 32 bytes, base64url. */
export function rawPublicKey(key: KeyObject): string {
  return (key.export({ format: "der", type: "spki" }) as Buffer)
    .subarray(SPKI_PREFIX.length)
    .toString("base64url");
}
const toKey = (raw: string) =>
  createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw, "base64url")]),
    format: "der",
    type: "spki",
  });

/** The licence server's signature: base64url(payload JSON) "." base64url(Ed25519 over the first part). */
export function signLicence(payload: LicencePayload, privateKey: KeyObject): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString("base64url")}`;
}

/**
 * A token this instance may act on, or null (spec §2): signed by the key its `kid` names (one of LUME's),
 * exactly as signed (no re-encoding), a licence in form, and this instance's own.
 */
export function verifyLicence(
  token: string,
  keys: Record<string, string>,
  instanceId: string,
): LicencePayload | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  if (!B64URL.test(body) || !B64URL.test(sig)) return null;
  const sigBytes = Buffer.from(sig, "base64url");
  // base64url decoding forgives stray bits: only the one exact spelling of the signature counts.
  if (sigBytes.toString("base64url") !== sig) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = licencePayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  const key = Object.hasOwn(keys, parsed.data.kid) ? keys[parsed.data.kid] : undefined;
  if (!key) return null;
  try {
    if (!verify(null, Buffer.from(body), toKey(key), sigBytes)) return null;
  } catch {
    return null;
  }
  return parsed.data.instanceId === instanceId ? parsed.data : null;
}

/** What an instance sends when it checks (the source spec §2.4) — only this, never anything about a lead. */
export function checkBody(o: {
  instanceId: string;
  licenseKey: string;
  appVersion: string;
  activeUserCount: number;
  leadCount: number;
  now: Date;
}) {
  return {
    instanceId: o.instanceId,
    licenseKey: o.licenseKey,
    appVersion: o.appVersion,
    activeUserCount: o.activeUserCount,
    leadCount: o.leadCount,
    serverTime: o.now.toISOString(),
  };
}
