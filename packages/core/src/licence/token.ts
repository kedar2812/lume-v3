import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import type { FeedbackReport } from "../feedback/rules";
import type { FleetHealth } from "./fleet";
import { licencePayloadSchema, type LicencePayload } from "./state";

/** Ed25519's DER prefix for a raw 32-byte public key (SubjectPublicKeyInfo). */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const B64URL = /^[A-Za-z0-9_-]+$/;
/** Room for three announcements in any script (spec 2026-10-16 fleet §2.3); an older answer is well under it. */
const MAX_TOKEN = 16_384;

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

/**
 * What an instance sends when it checks (the source spec §2.4) — only this, never anything about a lead. The
 * install's id is a random code it made for itself, so its key works on this server only (spec 2026-10-15 §2.2).
 */
export function checkBody(o: {
  instanceId: string;
  licenseKey: string;
  installId: string;
  appVersion: string;
  activeUserCount: number;
  leadCount: number;
  now: Date;
  /** What this LUME can show (spec 2026-10-16 fleet §1.1): the licence server signs those claims only then. */
  accepts?: readonly string[];
  /** Its health, counts only (fleet §1.1); absent when it couldn't be read. */
  health?: FleetHealth | null;
  /** How many people pressed Got it on each announcement it shows (fleet §1.2). */
  seen?: { id: string; people: number }[];
}) {
  return {
    instanceId: o.instanceId,
    licenseKey: o.licenseKey,
    installId: o.installId,
    appVersion: o.appVersion,
    activeUserCount: o.activeUserCount,
    leadCount: o.leadCount,
    serverTime: o.now.toISOString(),
    // Each only when given: called as before, this is exactly the body an older licence server takes.
    ...(o.accepts ? { accepts: [...o.accepts] } : {}),
    ...(o.health ? { health: o.health } : {}),
    ...(o.seen ? { seen: o.seen } : {}),
  };
}

/** What an instance sends to activate a key (spec 2026-10-15 §2.1) — only this. */
export function activateBody(o: { licenseKey: string; installId: string; appVersion: string; now: Date }) {
  return {
    licenseKey: o.licenseKey,
    installId: o.installId,
    appVersion: o.appVersion,
    serverTime: o.now.toISOString(),
  };
}

/** What an install sends with a report (spec 2026-10-16 §2.1): its credentials, who sent it, and the report — only this. */
export function feedbackBody(o: {
  instanceId: string;
  licenseKey: string;
  installId: string;
  appVersion: string;
  browser: string;
  reporter: { name: string; email: string; role: string };
  report: FeedbackReport;
}) {
  return {
    instanceId: o.instanceId,
    licenseKey: o.licenseKey,
    installId: o.installId,
    appVersion: o.appVersion,
    browser: o.browser,
    reporter: { name: o.reporter.name, email: o.reporter.email, role: o.reporter.role },
    kind: o.report.kind,
    text: o.report.text,
    page: o.report.page,
    theme: o.report.theme,
    screen: o.report.screen,
    images: o.report.images.map((i) => ({ type: i.type, data: i.data })),
  };
}
