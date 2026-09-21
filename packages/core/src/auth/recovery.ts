import { randomInt } from "node:crypto";
import { sha256Hex } from "../crypto/tokens";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const group = () => Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");

/** ~50 bits each: random enough that SHA-256 (not a slow hash) is the right storage. */
export function generateRecoveryCodes(n = 10): string[] {
  const codes = new Set<string>();
  while (codes.size < n) codes.add(`${group()}-${group()}`);
  return [...codes];
}

export function normalizeRecoveryCode(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 10 ? `${s.slice(0, 5)}-${s.slice(5)}` : s;
}

export const hashRecoveryCode = (code: string): string => sha256Hex(`lume-recovery:${code}`);
