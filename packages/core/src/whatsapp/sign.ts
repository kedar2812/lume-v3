import { createHmac, timingSafeEqual } from "node:crypto";

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // Equal-length buffers even on a length mismatch, so the time taken says nothing.
  return timingSafeEqual(x.length === y.length ? x : y, y) && x.length === y.length;
};

/** Meta's `X-Hub-Signature-256`: `sha256=<hex>` of the raw body with the app secret (checked at the relay only). */
export function metaSignatureOk(appSecret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  return same(`sha256=${createHmac("sha256", appSecret).update(raw).digest("hex")}`, header);
}

/** The relay's forward to an instance: `sha256=<hex>` of "<timestamp>.<raw body>" with that instance's token. */
export const relaySign = (token: string, ts: string, raw: Buffer): string =>
  `sha256=${createHmac("sha256", token).update(`${ts}.`).update(raw).digest("hex")}`;

/** As `/webhooks/in` checks a signed post: right, and within 5 minutes ("stale" when signed right but too old). */
export function relayCheck(
  token: string,
  ts: string | undefined,
  sig: string | undefined,
  raw: Buffer,
  nowMs: number,
): "ok" | "bad" | "stale" {
  if (!ts || !sig || !/^\d{9,11}$/.test(ts)) return "bad";
  if (!same(relaySign(token, ts, raw), sig)) return "bad";
  return Math.abs(nowMs / 1000 - Number(ts)) > 300 ? "stale" : "ok";
}
