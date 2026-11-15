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

/**
 * Whether the last input was the keyboard (not a pointer): only a keyboard in a panel holds it open against the
 * pointer. A mouse click that puts focus in a panel (the pile's first row, a link Chrome focuses on mousedown)
 * doesn't.
 */
let keyboardLast = false;
if (typeof document !== "undefined") {
  document.addEventListener("keydown", () => (keyboardLast = true), true);
  document.addEventListener("pointerdown", () => (keyboardLast = false), true);
}

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
 * - The panel follows its item when the page or the timeline scrolls (`Floating`).
 */
export function useItemFocus() {
  const [focused, setFocused] = useState<Focused | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const press = useRef<{ touch: boolean; peeked: boolean }>({ touch: false, peeked: false });
  const current = useRef<Focused | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const focusPanel = useRef(false);
  /** Focus handed back to an item from its panel: it doesn't reopen the panel just closed. */
  const handedBack = useRef<HTMLElement | null>(null);
  /** The window the item sits in (the full screen), if any: where focus goes when the item itself is gone. */
  const home = useRef<HTMLElement | null>(null);
  current.current = focused;

  /** The keyboard is in the panel: nothing the pointer does closes it under it. */
  /** The keyboard went into the panel and hasn't left (kept even when the panel is unmounted under it). */
  const keyboardWent = useRef(false);
  /**
   * The keyboard is in the panel: nothing the pointer does closes it under it. Also true when the panel was just
   * unmounted with focus inside (a live update): browsers drop focus to <body> then, without a blur.
   */
  const focusIn = () =>
    !!panel.current?.contains(document.activeElement) ||
    (keyboardWent.current && (!document.activeElement || document.activeElement === document.body));
  /** Focus in the panel, put there by the keyboard: the pointer passing by doesn't close or switch it. */
  const keyboardIn = () => keyboardLast && focusIn();
  const handBack = (el: HTMLElement) => {
    handedBack.current = el;
    el.focus({ preventScroll: true });
  };

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const close = useCallback(() => {
    cancel();
    // Closing with the keyboard inside the panel would drop focus to the page: it goes back to the item.
    const f = current.current;
    if (f && focusIn()) {
      // Its item gone (a live update): the window it lives in (the full screen) keeps the keyboard instead.
      if (f.el.isConnected) handBack(f.el);
      else home.current?.focus({ preventScroll: true });
    }
    // Whatever had focus is gone (a chip that vanished with it, say): inside the full screen, the window keeps it.
    const a = document.activeElement;
    if (home.current?.isConnected && (!a || a === document.body)) home.current.focus({ preventScroll: true });
    keyboardWent.current = false;
    setFocused(null);
  }, [cancel]);
  const later = useCallback(() => {
    cancel();
    timer.current = setTimeout(() => {
      if (!keyboardIn()) setFocused(null);
    }, GRACE_MS);
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
      home.current = el.closest<HTMLElement>('[role="dialog"]');
      setFocused((f) => (f?.key === key && f.el === el ? f : { key, el }));
    },
    [cancel],
  );

  // Opened on purpose (click, Enter or Down arrow): the keyboard goes into the panel.
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
      close();
    };
    // A press anywhere but the item and its panel closes it (touch has no "pointer left").
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (focused.el.contains(t) || panel.current?.contains(t))) return;
      close();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [focused, close]);
  useEffect(() => cancel, [cancel]);

  const bind = (key: string) => ({
    onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => {
      // With the keyboard in a panel, the pointer passing over another item doesn't take the panel away from it.
      if (e.pointerType !== "touch" && !keyboardIn()) open(key, e.currentTarget);
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
      if (e.key !== "ArrowDown") return;
      e.preventDefault();
      const first =
        current.current?.key === key ? panel.current?.querySelector<HTMLElement>(FOCUSABLE) : null;
      if (first) first.focus();
      else open(key, e.currentTarget, { focusPanel: true });
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
    // A finger lifting or scrolling inside the panel isn't leaving it.
    onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType !== "touch") later();
    },
    onFocus: () => {
      cancel();
      keyboardWent.current = true;
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      // (Not while the panel is being taken away: that blur says nothing about where the keyboard went.)
      if (panel.current && !panel.current.contains(e.relatedTarget as Node | null))
        keyboardWent.current = false;
      later();
    },
    // Tab moves through the panel's own controls (it lives on <body>, outside any window around it); past either
    // end it goes back to the item, and past the last it closes, so the next Tab moves on from the item.
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.key !== "Tab") return;
      const f = current.current;
      const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (!f || !items.length) return;
      e.preventDefault();
      e.stopPropagation();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = at + (e.shiftKey ? -1 : 1);
      if (next >= 0 && next < items.length) return items[next]!.focus();
      handBack(f.el);
      // Back to the item: Shift+Tab keeps the panel (the focus leaving it would otherwise close it); Tab moves on.
      cancel();
      if (!e.shiftKey) setFocused(null);
    },
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
 * Where the panel sits on screen (it's fixed, on the page or inside the full screen: see Floating). It never
 * covers the item it's about, and stays 8 px inside the window.
 * - `below` (the card): centred under the item; above it when there's more room there. When neither has room for all
 *   of it (a short window), it takes the larger side and scrolls inside.
 * - `beside` (the timeline, where the next line of chips sits right underneath): to the right of the item, else to
 *   its left, top-aligned with it; on a window too narrow for either (a phone), below or above as for `below`.
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
    const top = Math.max(8, Math.min(vh - height - 8, r.top - 4));
    // A window shorter than the panel: it scrolls inside rather than run off the bottom.
    const fit: CSSProperties = height > vh - 16 ? { maxHeight: vh - 16, overflowY: "auto" } : {};
    if (r.right + gap + width + 8 <= vw) return { position: "fixed", left: r.right + gap, top, ...fit };
    if (r.left - gap - width >= 8) return { position: "fixed", left: r.left - gap - width, top, ...fit };
  }
  const left = clampX(r.left + r.width / 2 - width / 2);
  const below = vh - 8 - (r.bottom + gap);
  const above = r.top - gap - 8;
  if (height <= below) return { position: "fixed", left, top: r.bottom + gap };
  if (height <= above) return { position: "fixed", left, bottom: vh - r.top + gap };
  // Not room for all of it either way: the larger side, scrolling inside.
  return below >= above
    ? { position: "fixed", left, top: r.bottom + gap, maxHeight: Math.max(0, below), overflowY: "auto" }
    : { position: "fixed", left, bottom: vh - r.top + gap, maxHeight: Math.max(0, above), overflowY: "auto" };
}
