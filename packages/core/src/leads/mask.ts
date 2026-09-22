import { parsePhoneNumberFromString } from "libphonenumber-js/max";

const DOTS = "•••";

/** "+971 50 ••• ••67": dial code, first two national digits, last two (spec §3 Leads). */
export function maskPhone(p: { e164: string | null; raw: string | null }): string {
  const parsed = p.e164 ? parsePhoneNumberFromString(p.e164) : undefined;
  if (parsed) {
    const nat = String(parsed.nationalNumber);
    return `+${parsed.countryCallingCode} ${nat.slice(0, 2)} ${DOTS} ••${nat.slice(-2)}`;
  }
  const digits = (p.raw ?? "").replace(/\D/g, "");
  return `${DOTS} ••${digits.slice(-2)}`;
}

export function maskEmail(e: string): string {
  const at = e.lastIndexOf("@");
  if (at < 1) return DOTS;
  return `${e[0]}${DOTS}${e.slice(at)}`;
}

export function maskInstagram(h: string): string {
  const s = h.replace(/^@/, "");
  return s.length > 1 ? `@${s[0]}${DOTS}${s[s.length - 1]}` : `@${s}${DOTS}`;
}
