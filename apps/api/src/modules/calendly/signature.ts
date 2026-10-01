import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Calendly's `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex>` (spec §3): v1 is HMAC-SHA256 of
 * "<t>.<raw body>" with the subscription's signing key, accepted within 5 minutes. "stale": signed right,
 * but too old or too far ahead.
 */
export function calendlySignatureCheck(
  key: string,
  header: string | undefined,
  raw: Buffer,
  now: number,
): "ok" | "stale" | "bad" {
  if (!header) return "bad";
  const parts = new Map(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = parts.get("t") ?? "";
  const v1 = parts.get("v1") ?? "";
  if (!/^\d{9,11}$/.test(t) || !/^[0-9a-f]{64}$/i.test(v1)) return "bad";
  const want = createHmac("sha256", key).update(`${t}.`).update(raw).digest();
  if (!timingSafeEqual(want, Buffer.from(v1, "hex"))) return "bad";
  return Math.abs(now / 1000 - Number(t)) > 300 ? "stale" : "ok";
}
