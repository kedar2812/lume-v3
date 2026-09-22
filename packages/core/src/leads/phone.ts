import { parsePhoneNumberFromString, type CountryCode, type PhoneNumber } from "libphonenumber-js/max";

export type PhoneStatus = "valid" | "needs_country" | "invalid" | "missing";
export type NormalizedPhone = {
  raw: string | null;
  e164: string | null;
  countryIso: string | null;
  status: PhoneStatus;
};

const valid = (raw: string, p: PhoneNumber): NormalizedPhone => ({
  raw,
  e164: p.number,
  countryIso: p.country ?? null,
  status: "valid",
});

/**
 * Report §8.4. Keep the raw value; accept a number only when libphonenumber says it is valid.
 * A number without an international prefix is parsed with the default country if there is one, and
 * otherwise (or when that fails) is marked `needs_country`. Nothing is ever guessed silently.
 */
export function normalizePhone(
  input: string | null | undefined,
  defaultCountry?: string | null,
): NormalizedPhone {
  const raw = input?.trim() ?? "";
  if (!raw) return { raw: null, e164: null, countryIso: null, status: "missing" };
  let s = raw.replace(/[\s\-.() ]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (!/^\+?\d+$/.test(s)) return { raw, e164: null, countryIso: null, status: "invalid" };
  if (s.startsWith("+")) {
    const p = parsePhoneNumberFromString(s);
    return p?.isValid() ? valid(raw, p) : { raw, e164: null, countryIso: null, status: "invalid" };
  }
  if (s.length < 6) return { raw, e164: null, countryIso: null, status: "invalid" };
  if (defaultCountry) {
    const p = parsePhoneNumberFromString(s, defaultCountry as CountryCode);
    if (p?.isValid()) return valid(raw, p);
  }
  return { raw, e164: null, countryIso: null, status: "needs_country" };
}

export function formatPhone(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}
