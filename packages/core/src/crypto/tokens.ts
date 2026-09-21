import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits by default, base64url (cookie- and URL-safe, no padding). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const sha256Hex = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");

/** Constant-time string comparison; unequal lengths still take a comparison's time. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) {
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}
