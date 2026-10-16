"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NavIcon } from "./icons";
import { NAV_ITEMS, activeNav, visibleNav, type NavItem } from "./nav";
import s from "./shell.module.css";

/** The tabs a phone keeps at hand (canvas Phase 5, Phone); everything else the person may open is under More. */
const PRIMARY = ["today", "leads", "calendar", "settings"] as const;

/**
 * Navigation on a phone (canvas Phone board): the sidebar has no room under 860 px, so the main places sit in a
 * tab bar at the bottom, within the thumb's reach, and the rest open from More. Hidden on wider screens.
 */
export function MobileTabs({
  can,
  onFeedback,
}: {
  can: (p: string) => boolean;
  /** Send feedback, last in More (spec 2026-10-16 §1.1). */
  onFeedback?: () => void;
}) {
  const pathname = usePathname();
  const items = visibleNav(NAV_ITEMS, can);
  const current = activeNav(items, pathname);
  const tabs = items.filter((i) => (PRIMARY as readonly string[]).includes(i.id));
  const more = items.filter((i) => !(PRIMARY as readonly string[]).includes(i.id));
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const tab = (i: NavItem) => (
    <Link key={i.id} href={i.href} className={s.tab} aria-current={i.id === current?.id ? "page" : undefined}>
      <NavIcon name={i.icon} />
      <span>{i.label}</span>
    </Link>
  );
  return (
    <nav className={s.tabs} aria-label="Tabs">
      {tabs.filter((i) => i.id !== "settings").map(tab)}
      {(more.length > 0 || onFeedback) && (
        <div className={s.moreWrap} ref={box}>
          <button
            type="button"
            className={s.tab}
            aria-haspopup="menu"
            aria-expanded={open}
            data-on={more.some((i) => i.id === current?.id) || undefined}
            onClick={() => setOpen((o) => !o)}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
            <span>More</span>
          </button>
          {open && (
            <div className={s.moreMenu} role="menu" aria-label="More">
              {more.map((i) => (
                <Link
                  key={i.id}
                  href={i.href}
                  role="menuitem"
                  aria-current={i.id === current?.id ? "page" : undefined}
                >
                  <NavIcon name={i.icon} />
                  {i.label}
                </Link>
              ))}
              {onFeedback && (
                <>
                  {more.length > 0 && <span role="separator" className={s.moreSep} />}
                  <button
                    type="button"
                    role="menuitem"
                    className={s.moreItem}
                    onClick={() => {
                      setOpen(false);
                      onFeedback();
                    }}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" strokeLinejoin="round" />
                    </svg>
                    Send feedback
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {tabs.filter((i) => i.id === "settings").map(tab)}
    </nav>
  );
}
