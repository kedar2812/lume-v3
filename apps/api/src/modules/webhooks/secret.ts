import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Keyring } from "@lume/core";
import type { Preset } from "./presets";

/** How a webhook source proves a post is its own (2C spec §2); sealed in config_enc, bound to the source. */
export type WebhookConfig = { mode: "signed" | "token"; secret: string; preset: Preset };
const ctx = (id: string) => `webhook-source:${id}`;
export const sealWebhook = (k: Keyring, id: string, c: WebhookConfig): Buffer =>
  k.encrypt(JSON.stringify(c), ctx(id));
export const openWebhook = (k: Keyring, id: string, blob: Buffer): WebhookConfig =>
  JSON.parse(k.decrypt(blob, ctx(id))) as WebhookConfig;
/** 32 random bytes, shown once at creation or rotation. */
export const newSecret = (): string => randomBytes(32).toString("base64url");

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Compare equal-length buffers even on a length mismatch, so the time taken says nothing.
  return timingSafeEqual(x.length === y.length ? x : y, y) && x.length === y.length;
};

/** `sha256=<hex>` of "<timestamp>.<raw body>": what a sender puts in X-Lume-Signature. */
export const signFor = (secret: string, ts: string, raw: Buffer): string =>
  `sha256=${createHmac("sha256", secret).update(`${ts}.`).update(raw).digest("hex")}`;

/** 2C spec §2 Signed: HMAC-SHA256 of "<timestamp>.<raw body>", with the timestamp within 5 minutes. */
export function checkSignature(
  secret: string,
  ts: string | undefined,
  sig: string | undefined,
  raw: Buffer,
  now: number,
): boolean {
  if (!ts || !sig || !/^\d{9,11}$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  return same(signFor(secret, ts, raw), sig);
}
export const checkToken = (secret: string, token: string | undefined): boolean =>
  !!token && same(secret, token);
