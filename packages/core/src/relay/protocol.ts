import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** What the relay hands back to an instance, sealed with that instance's token (2B spec §6). */
export type Handoff = {
  nonce: string;
  refreshToken: string;
  /** What the grant is for: a sheet (with the picked file) or a calendar (Phase 5A; no file). Absent: a sheet. */
  kind?: "sheet" | "calendar";
  file?: { id: string; name: string };
  exp: number;
};

/** An instance's public name at the relay: a prefix of its token's hash, never the token. */
export const instanceIdOf = (token: string): string =>
  createHash("sha256").update(token).digest("hex").slice(0, 16);

export const sign = (token: string, data: string): string =>
  createHmac("sha256", token).update(data).digest("base64url");

export function verify(token: string, data: string, sig: string): boolean {
  const want = Buffer.from(sign(token, data));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

const keyOf = (token: string) => Buffer.from(hkdfSync("sha256", token, "lume-relay", "seal", 32));

/** AES-256-GCM: iv(12) ‖ tag(16) ‖ ciphertext, base64url. Only the same token opens it; tampering fails. */
export function seal(token: string, value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(token), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

export function unseal<T>(token: string, sealed: string): T | null {
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 29) return null;
    const d = createDecipheriv("aes-256-gcm", keyOf(token), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")) as T;
  } catch {
    return null;
  }
}
