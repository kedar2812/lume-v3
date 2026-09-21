import { createHmac, randomBytes } from "node:crypto";
import { base32Decode, base32Encode } from "./base32";

const PERIOD_S = 30;

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

function hotp(key: Buffer, counter: number, digits: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpCode = (secretB32: string, atMs: number, digits = 6): string =>
  hotp(base32Decode(secretB32), Math.floor(atMs / 1000 / PERIOD_S), digits);

/**
 * Returns the time step the code matched (store it as `totp_last_step`), or null. Steps at or before
 * `lastUsedStep` are refused, so a captured code can never be replayed.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  opts: { nowMs: number; window?: number; lastUsedStep?: number | null },
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const now = Math.floor(opts.nowMs / 1000 / PERIOD_S);
  const window = opts.window ?? 1;
  let matched: number | null = null;
  for (let step = now - window; step <= now + window; step++) {
    // compare every candidate (no early return) so timing doesn't reveal which step matched
    if (hotp(key, step, 6) === code && (opts.lastUsedStep == null || step > opts.lastUsedStep))
      matched ??= step;
  }
  return matched;
}

export function otpauthUri({
  secret,
  account,
  issuer,
}: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${PERIOD_S}`;
}
