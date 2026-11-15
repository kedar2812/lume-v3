"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** How long a panel waits after the pointer leaves, so moving from the item onto the panel doesn't close it. */
export const GRACE_MS = 120;

export type Focused = { key: string; el: HTMLElement };

/**
 * One item at a time comes forward (spec: Your day, Part 1): hover or keyboard focus opens its panel, Esc closes it,
 * and leaving closes it after a short grace. On touch the first tap only peeks (the panel is the way to open), and a
 * second tap on the same item goes through.
 */
export function useItemFocus() {
  const [focused, setFocused] = useState<Focused | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef<string>("mouse");
  const current = useRef<Focused | null>(null);
  current.current = focused;

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const close = useCallback(() => {
    cancel();
    setFocused(null);
  }, [cancel]);
  const later = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => setFocused(null), GRACE_MS);
  }, [cancel]);
  const open = useCallback(
    (key: string, el: HTMLElement) => {
      cancel();
      setFocused((f) => (f?.key === key && f.el === el ? f : { key, el }));
    },
    [cancel],
  );

  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focused, close]);
  useEffect(() => cancel, [cancel]);

  const bind = (key: string) => ({
    onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType !== "touch") open(key, e.currentTarget);
    },
    onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType !== "touch") later();
    },
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      pointer.current = e.pointerType || "mouse";
    },
    onFocus: (e: FocusEvent<HTMLElement>) => open(key, e.currentTarget),
    onBlur: () => later(),
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      const touch = pointer.current === "touch";
      pointer.current = "mouse";
      if (touch && current.current?.key !== key) {
        e.preventDefault();
        open(key, e.currentTarget);
      }
    },
  });

  const panelBind = {
    onPointerEnter: cancel,
    onPointerLeave: later,
    onFocus: cancel,
    onBlur: later,
  };
  return { focused, bind, panelBind, open, close };
}

/** The panel's width, in px. */
export const PANEL_W = 264;

/**
 * Where the panel sits on screen (it's fixed, on <body>, so a card that clips its insides can't cut it off): centred
 * under the item and kept 8 px inside the window; above the item when there isn't room for it below.
 */
export function fixedPlace(el: HTMLElement, width = PANEL_W, room = 170, gap = 8): CSSProperties {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(8, Math.min(vw - width - 8, r.left + r.width / 2 - width / 2));
  return r.bottom + gap + room > vh && r.top - gap - room > 0
    ? { position: "fixed", left, bottom: vh - r.top + gap }
    : { position: "fixed", left, top: r.bottom + gap };
}
