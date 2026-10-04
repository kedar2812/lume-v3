"use client";
import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

export const FOCUSABLE =
  'input:not([disabled]), select, textarea, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * What every LUME popup does with the keyboard (7C final review, Important 3): focus moves in when it opens and stays
 * in (Tab wraps), Escape closes it — unless `onClose` is absent (busy saving) — and focus goes back to where it was.
 * Spread the returned `onKeyDown` on the popup's panel.
 */
export function useModalFocus(panel: RefObject<HTMLElement | null>, onClose?: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    return () => before?.focus?.();
  }, [panel]);
  return {
    onKeyDown(e: KeyboardEvent<HTMLElement>) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
        (el) => !el.closest("[inert]"),
      );
      const first = items[0];
      const last = items.at(-1);
      if (!first) return e.preventDefault();
      if (
        e.shiftKey &&
        (document.activeElement === first || !panel.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        last?.focus();
      } else if (
        !e.shiftKey &&
        (document.activeElement === last || !panel.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        first.focus();
      }
    },
  };
}
