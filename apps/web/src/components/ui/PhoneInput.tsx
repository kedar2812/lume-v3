"use client";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { dialCountries, joinPhone, splitPhone } from "@lume/core/shared";
import s from "./PhoneInput.module.css";

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
const fold = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

let cached: Country[] | null = null;
function countries(): Country[] {
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

/** Search by name ("ind", "émirats" works without accents), ISO code, or calling code ("+44", "971"). */
function search(all: Country[], query: string, preferred: string | null): Country[] {
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

function Flag({ iso }: { iso: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <span className={s.noFlag} aria-hidden />;
  return (
    <img
      src={`/flags/${iso}.svg`}
      alt=""
      width={20}
      height={14}
      loading="lazy"
      decoding="async"
      className={s.flag}
      onError={() => setMissing(true)}
    />
  );
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
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const emitted = useRef(value);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const number = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const listId = useId();
  const current = all.find((c) => c.iso === country);
  const results = useMemo(() => search(all, query, country), [all, query, country]);

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

  const close = (focus: "button" | "number" | null) => {
    setOpen(false);
    setQuery("");
    if (focus === "button") button.current?.focus();
    if (focus === "number") number.current?.focus();
  };
  const pick = (c: Country) => {
    setCountry(c.iso);
    emit(c.iso, national);
    close("number");
  };

  // The list floats over the page (a portal, fixed): inside a scrolling table, drawer or sheet it
  // would be clipped. It sits under the field, or above it when there's no room below, and follows it.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = root.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 328));
      setPlace(
        below < 360 && r.top > below
          ? { left, bottom: window.innerHeight - r.top + 6 }
          : { left, top: r.bottom + 6 },
      );
    };
    measure();
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !panel.current?.contains(t)) close(null);
    };
    document.addEventListener("pointerdown", away);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, listId]);

  const searchKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.max(0, Math.min(results.length - 1, i + step)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = results[active];
      if (c) pick(c);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // closes the list, not the sheet or drawer around it
      close("button");
    } else if (e.key === "Tab") close(null);
  };

  return (
    <div className={s.phone} ref={root} data-size={size}>
      <button
        ref={button}
        type="button"
        className={s.country}
        aria-label={
          current ? `Country code: ${current.name} +${current.code}` : "Country code: choose a country"
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(null) : setOpen(true))}
      >
        {current ? <Flag iso={current.iso} /> : <span className={s.noFlag} aria-hidden />}
        <span className={s.code} aria-hidden>
          {current ? `+${current.code}` : "+"}
        </span>
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden className={s.chevron}>
          <path
            d="M3 4.5 6 7.5l3-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <input
        ref={number}
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        maxLength={32}
        className={s.number}
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
      {open &&
        createPortal(
          <div
            ref={panel}
            className={s.panel}
            data-phone-panel=""
            data-up={place?.bottom !== undefined || undefined}
            style={{ position: "fixed", left: place?.left ?? 0, top: place?.top, bottom: place?.bottom }}
          >
            <input
              role="combobox"
              aria-label="Search countries"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
              aria-autocomplete="list"
              className={s.search}
              placeholder="Country or code"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={searchKeys}
            />
            <ul id={listId} role="listbox" aria-label="Countries" className={s.list}>
              {results.map((c, i) => (
                <li
                  key={c.iso}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-label={`${c.name} +${c.code}`}
                  aria-selected={c.iso === country}
                  data-active={i === active || undefined}
                  className={s.option}
                  onPointerMove={() => setActive(i)}
                  onClick={() => pick(c)}
                >
                  <Flag iso={c.iso} />
                  <span className={s.name}>{c.name}</span>
                  <span className={s.optionCode}>+{c.code}</span>
                  {c.iso === country && (
                    <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden className={s.tick}>
                      <path
                        d="M3 7.5 6 10.3 11.5 4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </li>
              ))}
            </ul>
            {results.length === 0 && <p className={s.none}>No country matches “{query.trim()}”</p>}
          </div>,
          document.body,
        )}
    </div>
  );
}
