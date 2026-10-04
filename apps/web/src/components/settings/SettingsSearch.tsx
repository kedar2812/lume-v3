"use client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLoadingSignal } from "@/lib/loading";
import { fuzzyRank } from "@/lib/search/fuzzy";
import type { SettingsArea } from "@/lib/settings/areas";
import { settingsHits, type SettingsHit } from "@/lib/settings/index";
import { loadYours } from "@/lib/settings/yours";
import s from "./settings.module.css";

const MAX = 8;
/** A search that hasn't answered in this long shows the loading bar and a waiting row. */
const SLOW_MS = 150;
/** The setting a search opened, for the page to find and light up once it's there. */
export const FIND_KEY = "lume:settings:find";

/**
 * Search Settings (owner, 2026-10-05): type a few letters of any setting, or of something your business made (a
 * stage, a field, a tag, a person), and LUME suggests where it lives, forgiving typos. "/" jumps here. Opening one
 * goes to its page and lights the setting up.
 */
export function SettingsSearch({ areas, onPicked }: { areas: SettingsArea[]; onPicked?(): void }) {
  const router = useRouter();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [yours, setYours] = useState<SettingsHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [slow, setSlow] = useState(false);
  const asked = useRef(false);
  useLoadingSignal(loading && slow);

  const base = useMemo(() => settingsHits(areas), [areas]);
  /** What the business made is fetched once, the first time someone searches. */
  const warm = () => {
    if (asked.current) return;
    asked.current = true;
    setLoading(true);
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    void loadYours(areas)
      .then(setYours)
      .catch(() => setYours([]))
      .finally(() => {
        clearTimeout(t);
        setLoading(false);
        setSlow(false);
      });
  };

  const hits = useMemo(
    () =>
      fuzzyRank(q, [...base, ...(yours ?? [])], (h) => ({
        label: h.label,
        keywords: [h.where, ...h.keywords],
      })).slice(0, MAX),
    [q, base, yours],
  );
  const active = q.trim().length > 0;

  // "/" from anywhere on a Settings page that isn't a field.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable], [role=dialog]"))
        return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const open = (h: SettingsHit | undefined) => {
    if (!h) return;
    try {
      if (h.kind !== "area") sessionStorage.setItem(FIND_KEY, h.label);
    } catch {
      // no storage: the page opens without the glow
    }
    setQ("");
    setSel(0);
    input.current?.blur();
    onPicked?.();
    router.push(h.href);
    // Already on that page: look for it now.
    window.dispatchEvent(new Event(FIND_KEY));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!hits.length) return;
      e.preventDefault();
      const n = hits.length;
      setSel((v) => (v + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(hits[sel]);
    } else if (e.key === "Escape") {
      if (q) {
        e.preventDefault();
        setQ("");
      } else input.current?.blur();
    }
  };

  return (
    <div className={s.search} role="search">
      <div className={s.searchBox}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-label="Search settings"
          aria-expanded={active}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active && hits[sel] ? `${listId}-${sel}` : undefined}
          placeholder="Search settings"
          value={q}
          onFocus={warm}
          onChange={(e) => {
            warm();
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKey}
        />
        {!active && <kbd aria-hidden>/</kbd>}
      </div>
      {active && (
        <div className={s.results} role="listbox" id={listId} aria-label="Settings that match">
          {hits.map((h, i) => (
            <div
              key={h.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === sel}
              className={s.result}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => open(h)}
            >
              <span className={s.resultLabel}>{h.label}</span>
              <span className={s.resultWhere}>{h.where}</span>
            </div>
          ))}
          {loading && slow && (
            <div className={s.resultWait} aria-live="polite">
              <i aria-hidden />
              Looking through your stages, fields and people…
            </div>
          )}
          {!hits.length && !(loading && slow) && (
            <p className={s.noResult} role="status">
              Nothing in Settings matches “{q.trim()}”.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * On a Settings page, the setting a search opened: the first heading, label or button that names it scrolls into
 * view and glows once.
 */
export function useFoundSetting(root: React.RefObject<HTMLElement | null>) {
  const path = usePathname();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = (tries = 12) => {
      let label: string | null = null;
      try {
        label = sessionStorage.getItem(FIND_KEY);
      } catch {
        return;
      }
      if (!label || !root.current) return;
      const want = label.toLowerCase().replace(/[’']/g, "'");
      const el = [
        ...root.current.querySelectorAll<HTMLElement>(
          "h1, h2, h3, h4, legend, label, th, dt, summary, button, [aria-label]",
        ),
      ].find((n) => {
        const text = (n.getAttribute("aria-label") ?? n.textContent ?? "")
          .trim()
          .toLowerCase()
          .replace(/[’']/g, "'");
        return text.startsWith(want) || (want.length > 4 && text.includes(want));
      });
      // The page may still be loading its data: look again shortly, a few times.
      if (!el) {
        if (tries > 0) timer = setTimeout(() => look(tries - 1), 200);
        else sessionStorage.removeItem(FIND_KEY);
        return;
      }
      sessionStorage.removeItem(FIND_KEY);
      const target = (el.closest("section, fieldset, li, tr, [data-setting]") as HTMLElement | null) ?? el;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add(s.found!);
      setTimeout(() => target.classList.remove(s.found!), 1800);
    };
    look();
    const again = () => look();
    window.addEventListener(FIND_KEY, again);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(FIND_KEY, again);
    };
  }, [path, root]);
}

/** A Settings page's content, where a setting found by search lights up. */
export function SettingsContent({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useFoundSetting(root);
  return (
    <div ref={root} className={s.content}>
      {children}
    </div>
  );
}
