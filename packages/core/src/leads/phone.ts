import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
  type PhoneNumber,
} from "libphonenumber-js/max";

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
  let s = raw.replace(/[\s\-.()\xA0]/g, "");
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

export type DialCountry = { iso: string; code: string };
let dial: DialCountry[] | null = null;

/** Every country a phone number can belong to, with its calling code (without the "+"). */
export function dialCountries(): DialCountry[] {
  dial ??= getCountries().map((iso) => ({ iso, code: String(getCountryCallingCode(iso)) }));
  return dial;
}

/**
 * A stored number as the phone field shows it: the country (read from an international number, or the
 * business default) and the rest. An international number that isn't valid yet still gives its country,
 * by the longest calling code it starts with.
 */
export function splitPhone(
  value: string | null | undefined,
  defaultCountry: string | null,
): { country: string | null; national: string } {
  const raw = value?.trim() ?? "";
  if (!raw.startsWith("+")) return { country: defaultCountry, national: raw };
  const p = parsePhoneNumberFromString(raw);
  if (p?.country) return { country: p.country, national: String(p.nationalNumber) };
  const digits = raw.replace(/\D/g, "");
  const match = dialCountries()
    .filter((c) => digits.startsWith(c.code))
    .sort(
      (a, b) =>
        b.code.length - a.code.length || Number(b.iso === defaultCountry) - Number(a.iso === defaultCountry),
    )[0];
  return match
    ? { country: match.iso, national: digits.slice(match.code.length) }
    : { country: defaultCountry, national: raw };
}

/**
 * The number to save: the chosen country's code in front of what was typed. A valid number is saved in
 * E.164 (so a typed trunk "0" is dropped); anything else is kept as typed, behind the code, for the server
 * to judge. A pasted international number wins over the picker.
 */
export function joinPhone(country: string | null, national: string): string {
  const typed = national.trim();
  if (!typed || typed.startsWith("+") || !country) return typed;
  const p = parsePhoneNumberFromString(typed, country as CountryCode);
  if (p?.isValid()) return p.number;
  return `+${getCountryCallingCode(country as CountryCode)} ${typed}`;
}
