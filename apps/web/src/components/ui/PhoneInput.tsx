"use client";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react";
import { dialCountries, joinPhone, splitPhone } from "@lume/core/shared";
import { Flag, SearchList, fold, type ListItem } from "./SearchList";
import s from "./Picker.module.css";

type Country = { iso: string; code: string; name: string; key: string };

/** For calling codes several countries share, the one people mean when they type the code. */
const MAIN: Record<string, string> = {
  "1": "US",
  "7": "RU",
  "44": "GB",
  "47": "NO",
  "61": "AU",
  "39": "IT",
  "358": "FI",
  "212": "MA",
  "262": "RE",
  "590": "GP",
  "599": "CW",
  "290": "SH",
};

let cached: Country[] | null = null;
/** Every country with its calling code and English name, by name. Shared with CountryPicker. */
export function countries(): Country[] {
  if (cached) return cached;
  const names =
    typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
  cached = dialCountries()
    .map(({ iso, code }) => {
      const name = names?.of(iso) ?? iso;
      return { iso, code, name, key: fold(`${name} ${iso}`) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return cached;
}

/** Search by name ("ind", "emirats" without accents), ISO code, or calling code ("+44", "971"). */
export function searchCountries(all: Country[], query: string, preferred: string | null): Country[] {
  const q = fold(query.trim());
  if (!q) {
    const first = all.find((c) => c.iso === preferred);
    return first ? [first, ...all.filter((c) => c !== first)] : all;
  }
  const digits = q.replace(/^\+|\s/g, "");
  if (/^\d+$/.test(digits)) {
    const rank = (c: Country) => (c.code === digits ? (MAIN[c.code] === c.iso ? 0 : 1) : 2);
    return all
      .filter((c) => c.code.startsWith(digits))
      .sort((a, b) => rank(a) - rank(b) || a.code.length - b.code.length);
  }
  const rank = (c: Country) =>
    c.key.startsWith(q) ? 0 : c.key.split(/[\s-]/).some((w) => w.startsWith(q)) ? 1 : 2;
  return all.filter((c) => c.key.includes(q) || c.iso.toLowerCase() === q).sort((a, b) => rank(a) - rank(b));
}

type Props = {
  /** The id of the number box, for a <label htmlFor>. */
  id?: string;
  /** The whole number, "+971501234567", or what was typed when it isn't valid yet. */
  value: string;
  onChange: (value: string) => void;
  /** The business country, used until another is picked or read from a pasted number. */
  defaultCountry: string | null;
  size?: "md" | "sm";
  autoFocus?: boolean;
  /** Keys pressed in the number box (Enter to save, Escape to cancel, in an inline editor). */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
} & Pick<InputHTMLAttributes<HTMLInputElement>, "aria-invalid" | "aria-describedby" | "aria-label">;

/**
 * A phone number as two parts: the country (a searchable list with flags, names and codes) and the
 * number. The code is added for the person, never typed; pasting a full international number picks
 * its country by itself.
 */
export function PhoneInput({
  id,
  value,
  onChange,
  defaultCountry,
  size = "md",
  autoFocus,
  onKeyDown,
  ...aria
}: Props) {
  const all = countries();
  const start = splitPhone(value, defaultCountry);
  const [country, setCountry] = useState<string | null>(start.country);
  const [national, setNational] = useState(start.national);
  const [open, setOpen] = useState(false);
  const emitted = useRef(value);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const number = useRef<HTMLInputElement>(null);
  const current = all.find((c) => c.iso === country);

  // A value set from outside (a reset, a reload after a conflict) is shown; our own echo is not re-split.
  useEffect(() => {
    if (value === emitted.current) return;
    const next = splitPhone(value, defaultCountry);
    emitted.current = value;
    setCountry(next.country);
    setNational(next.national);
  }, [value, defaultCountry]);

  const emit = (iso: string | null, typed: string) => {
    const next = joinPhone(iso, typed);
    emitted.current = next;
    onChange(next);
  };

  const type = (raw: string) => {
    const intl = raw.trim().replace(/^00/, "+");
    if (intl.startsWith("+")) {
      const found = splitPhone(intl, null);
      if (found.country && /\d/.test(found.national)) {
        setCountry(found.country);
        setNational(found.national);
        return emit(found.country, found.national);
      }
    }
    setNational(raw);
    emit(country, raw);
  };

  const search = (q: string): ListItem[] =>
    searchCountries(all, q, country).map((c) => ({
      id: c.iso,
      label: c.name,
      detail: `+${c.code}`,
      flag: c.iso,
    }));

  return (
    <div className={s.field} ref={root} data-size={size}>
      <button
        ref={button}
        type="button"
        className={s.prefix}
        aria-label={
          current ? `Country code: ${current.name} +${current.code}` : "Country code: choose a country"
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Flag iso={current?.iso} />
        <span aria-hidden>{current ? `+${current.code}` : "+"}</span>
        <Chevron />
      </button>
      <input
        ref={number}
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        maxLength={32}
        className={s.input}
        value={national}
        autoFocus={autoFocus}
        onChange={(e) => type(e.target.value)}
        onPaste={(e: ClipboardEvent<HTMLInputElement>) => {
          const text = e.clipboardData.getData("text");
          if (!/^\s*(\+|00)/.test(text)) return;
          e.preventDefault();
          type(text);
        }}
        onKeyDown={onKeyDown}
        {...aria}
      />
      {open && (
        <SearchList
          anchor={root}
          search={search}
          selected={country}
          searchLabel="Search countries"
          listLabel="Countries"
          placeholder="Country or code"
          emptyText={(q) => `No country matches “${q}”`}
          onPick={(item) => {
            setCountry(item.id);
            emit(item.id, national);
            setOpen(false);
            number.current?.focus();
          }}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) button.current?.focus();
          }}
        />
      )}
    </div>
  );
}

export const Chevron = () => (
  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden className={s.chevron}>
    <path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
