"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { FOCUSABLE } from "@/components/ui/useModalFocus";

/** How long a panel waits after the pointer leaves, so moving from the item onto the panel doesn't close it. */
export const GRACE_MS = 120;

export type Focused = { key: string; el: HTMLElement };

/**
 * One item at a time comes forward (spec: Your day, Part 1): hover or keyboard focus opens its panel, Esc closes it,
 * and leaving closes it after a short grace.
 *
 * - Touch: the first tap only peeks (the panel is the way to open), a second tap on the same item goes through, and a
 *   tap anywhere else closes it. Whether it had already peeked is decided as the finger goes down, before the browser
 *   moves focus to the item (Chrome focuses a tapped link before its click).
 * - Keyboard: Down arrow on an item moves into its panel; Esc in the panel goes back to the item. A group opened with
 *   a click or Enter puts focus on its first row.
 * - The panel follows its item when the page or the timeline scrolls.
 */
export function useItemFocus() {
  const [focused, setFocused] = useState<Focused | null>(null);
  const [, setMoved] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const press = useRef<{ touch: boolean; peeked: boolean }>({ touch: false, peeked: false });
  const current = useRef<Focused | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const focusPanel = useRef(false);
  /** Focus handed back to an item by Esc: it doesn't reopen the panel just closed. */
  const handedBack = useRef<HTMLElement | null>(null);
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
    (key: string, el: HTMLElement, o: { focusPanel?: boolean } = {}) => {
      cancel();
      // Already open for this item (a browser focuses a button on mousedown, which opened it): go straight in.
      if (o.focusPanel && current.current?.key === key && current.current.el === el) {
        panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
        return;
      }
      focusPanel.current = !!o.focusPanel;
      setFocused((f) => (f?.key === key && f.el === el ? f : { key, el }));
    },
    [cancel],
  );

  // A group opened on purpose (click or Enter) takes the keyboard into its rows.
  useEffect(() => {
    if (!focused || !focusPanel.current) return;
    focusPanel.current = false;
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [focused]);

  useEffect(() => {
    if (!focused) return;
    // Capture phase: a panel inside the full screen closes before the full screen hears Escape (its modal focus
    // stops the key at the React root, so a bubbling listener here would never see it).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      const inPanel = !!panel.current?.contains(document.activeElement);
      close();
      if (inPanel) {
        handedBack.current = focused.el;
        focused.el.focus({ preventScroll: true });
      }
    };
    // A press anywhere but the item and its panel closes it (touch has no "pointer left").
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (focused.el.contains(t) || panel.current?.contains(t))) return;
      close();
    };
    // Scrolling moves the item: the panel follows.
    const onScroll = () => setMoved((n) => n + 1);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
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
      const touch = e.pointerType === "touch";
      press.current = { touch, peeked: touch && current.current?.key === key };
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (handedBack.current === e.currentTarget) {
        handedBack.current = null;
        return;
      }
      open(key, e.currentTarget);
    },
    onBlur: () => later(),
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key !== "ArrowDown" || current.current?.key !== key) return;
      const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
      if (!first) return;
      e.preventDefault();
      first.focus();
    },
    onClick: (e: ReactMouseEvent<HTMLElement>) => {
      const { touch, peeked } = press.current;
      press.current = { touch: false, peeked: false };
      if (touch && !peeked) {
        e.preventDefault();
        open(key, e.currentTarget);
      }
    },
  });

  const panelBind = {
    ref: panel,
    onPointerEnter: cancel,
    onPointerLeave: later,
    onFocus: cancel,
    onBlur: later,
  };
  return { focused, bind, panelBind, open, close };
}

/** The panel's width, in px. */
export const PANEL_W = 264;
/** A panel is never taller than this (its list scrolls inside). */
export const PANEL_MAX_H = 360;

/** About how tall a panel is: one item's, or a group's header and rows (capped). */
export const panelHeight = (rows = 0) => Math.min(PANEL_MAX_H, rows ? 40 + rows * 33 : 130);

/**
 * Where the panel sits on screen (it's fixed, on <body>, so nothing that clips its insides can cut it off).
 * - `below` (the card): centred under the item; above it when there isn't room below.
 * - `beside` (the timeline, where the next line of chips sits right underneath): to the right of the item, or to its
 *   left near the window's right edge, top-aligned with it and kept inside the window.
 * Always 8 px inside the window.
 */
export function fixedPlace(
  el: HTMLElement,
  o: { width?: number; height?: number; side?: "below" | "beside"; gap?: number } = {},
): CSSProperties {
  const { width = PANEL_W, height = panelHeight(), side = "below", gap = 8 } = o;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.max(8, Math.min(vw - width - 8, x));
  if (side === "beside") {
    const right = r.right + gap;
    const left = right + width + 8 <= vw ? right : clampX(r.left - gap - width);
    return { position: "fixed", left, top: Math.max(8, Math.min(vh - height - 8, r.top - 4)) };
  }
  const left = clampX(r.left + r.width / 2 - width / 2);
  return r.bottom + gap + height > vh - 8 && r.top - gap - height > 8
    ? { position: "fixed", left, bottom: vh - r.top + gap }
    : { position: "fixed", left, top: Math.min(r.bottom + gap, Math.max(8, vh - height - 8)) };
}
