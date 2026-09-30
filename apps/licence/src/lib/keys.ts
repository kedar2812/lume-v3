import { createHash, randomInt, timingSafeEqual } from "node:crypto";

/** Crockford's base32: no I, L, O or U, so a key read aloud or retyped isn't misread. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const group = (n: number) => Array.from({ length: n }, () => ALPHABET[randomInt(32)]).join("");

/** An installation's id: LUME-XXXX-XXXX. */
export const newInstanceId = (): string => `LUME-${group(4)}-${group(4)}`;
/** A licence key: LUME and five groups of four (100 random bits). Shown once; only its hash is kept. */
export const newLicenceKey = (): string => `LUME-${[1, 2, 3, 4, 5].map(() => group(4)).join("-")}`;
export const lastFour = (key: string): string => key.slice(-4);
export const maskedKey = (last4: string): string => `LUME-••••-••••-••••-••••-${last4}`;

/** The key as it was issued: what's typed around it and its case don't matter. */
const normal = (key: string) => key.trim().toUpperCase();
export const hashKey = (key: string): Buffer => createHash("sha256").update(normal(key)).digest();
const NOTHING = Buffer.alloc(32);

/** Constant-time: a key with no licence behind it costs the same as a wrong one. */
export function keyMatches(key: string, hash: Buffer | null): boolean {
  const h = hashKey(key);
  const ok = timingSafeEqual(h, hash && hash.length === 32 ? hash : NOTHING);
  return ok && hash !== null;
}
