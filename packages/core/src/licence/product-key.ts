/**
 * A LUME product key (spec 2026-10-15 §1.1): LUME and five groups of four in Crockford's base32. Typed any way —
 * any case, spaces, dashes of any kind, with or without LUME, O for 0, I or L for 1 — it has one spelling, so the
 * licence server's hash and the setup field's grouping always agree.
 */
export const KEY_GROUPS = 5;
export const KEY_CHARS = KEY_GROUPS * 4;

/** Crockford's base32: the digits and A–Z without I, L, O and U. */
const ALPHABET = /^[0-9A-HJKMNP-TV-Z]$/;
/** What people type for the letters the alphabet leaves out. */
const READ_AS: Record<string, string> = { O: "0", I: "1", L: "1" };

/** Up to 20 key characters from whatever was typed or pasted. */
export function keyChars(input: string): string {
  let s = String(input)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (s.startsWith("LUME")) s = s.slice(4);
  let out = "";
  for (const ch of s) {
    const c = READ_AS[ch] ?? ch;
    if (ALPHABET.test(c)) out += c;
    if (out.length === KEY_CHARS) break;
  }
  return out;
}

const grouped = (chars: string): string => (chars ? `LUME-${chars.match(/.{1,4}/g)!.join("-")}` : "");

/** The issued spelling, once all five groups are there; otherwise null. */
export function canonicalKey(input: string): string | null {
  const chars = keyChars(input);
  return chars.length === KEY_CHARS ? grouped(chars) : null;
}

/** What the setup field shows while someone types: grouped as far as it goes. */
export const displayKey = (input: string): string => grouped(keyChars(input));
