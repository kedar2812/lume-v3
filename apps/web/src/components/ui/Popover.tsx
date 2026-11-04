"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BodyPortal } from "./BodyPortal";
import { FOCUSABLE } from "./useModalFocus";
import s from "./Popover.module.css";

type Props = {
  /** The panel's accessible name (and the trigger's, unless `trigger` says otherwise). */
  label: string;
  /** What the trigger button shows. */
  trigger: ReactNode;
  triggerClassName?: string;
  /** The trigger's accessible name, when what it shows isn't words (an icon, "···"). */
  triggerLabel?: string;
  /** "form": a taller panel for a small form (the default suits a menu or a chooser). */
  size?: "menu" | "form";
  /** "dialog" for a small form or chooser, "menu" for a list of actions. */
  role?: "dialog" | "menu";
  align?: "start" | "end";
  /**
   * "above" grows up from the trigger; "auto" picks whichever side has room (a trigger low in the window,
   * like the bulk bar, opens upward). Either way the panel is never taller than the room it has.
   */
  side?: "below" | "above" | "auto";
  /**
   * The panel on <body>, fixed beside its trigger: for a trigger inside something that clips (the bulk island is
   * overflow: hidden for its shape), where an inline panel would be cut away.
   */
  portal?: boolean;
  /** Marks the trigger as holding a value (a filter that is set). */
  active?: boolean;
  disabled?: boolean;
  children: ReactNode | ((close: () => void) => ReactNode);
};

/** The left and right edges of what would clip a panel inside `el`: its nearest scrolling ancestor, or the window. */
function clipOf(el: HTMLElement): { left: number; right: number } {
  for (let a = el.parentElement; a; a = a.parentElement) {
    const o = getComputedStyle(a).overflowX;
    if (o !== "visible" && o !== "clip") {
      const r = a.getBoundingClientRect();
      return { left: Math.max(0, r.left), right: Math.min(window.innerWidth, r.right) };
    }
  }
  return { left: 0, right: window.innerWidth };
}

/**
 * Whether something around the trigger hides what runs past it: a box that clips (a card with rounded corners, the bulk
 * island) or one that scrolls on its own (a chat's thread, its reply bar stuck to the foot). An inline panel there is
 * cut off (owner, 2026-11-04: the template sheet in a chat), so it goes on <body> instead. Only the page's own scroller
 * ([data-scroll]) is left alone: it scrolls the panel into view.
 */
function insideClip(el: HTMLElement): boolean {
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    // The page's own scroller: it scrolls the panel into view, and the shell around it is the window's own frame.
    if (a.hasAttribute("data-scroll")) return false;
    const cs = getComputedStyle(a);
    if ([cs.overflow, cs.overflowX, cs.overflowY].some((o) => o !== "visible" && o !== "")) return true;
  }
  return false;
}

/**
 * Whether a press landed inside any of `boxes`, counting the panels opened from inside them: a panel that left its
 * trigger's box (on <body>, or in the dialog) still belongs to the box its trigger is in, and to that box's owner in
 * turn (a menu opened from a panel opened from the notification centre). Every "a press outside closes it" uses this.
 */
export function pressedWithin(target: EventTarget | null, ...boxes: (Element | null | undefined)[]): boolean {
  let at = target instanceof Element ? target : null;
  for (let hops = 0; at && hops < 10; hops++) {
    if (boxes.some((b) => b?.contains(at))) return true;
    const panel = at.closest<HTMLElement>("[data-popover]");
    if (!panel?.id) return false;
    at = document.querySelector(`[aria-controls="${panel.id.replace(/["\\]/g, "\\$&")}"]`);
  }
  return false;
}

/** Whether `el` makes itself the box its fixed children are placed in (and clipped by): a transform, a filter, … */
function holdsFixed(el: HTMLElement): boolean {
  const cs = getComputedStyle(el) as CSSStyleDeclaration & Record<string, string>;
  const set = (v: string | undefined) => !!v && v !== "none" && v !== "normal" && v !== "auto";
  return (
    set(cs.transform) ||
    set(cs.translate) ||
    set(cs.scale) ||
    set(cs.rotate) ||
    set(cs.filter) ||
    set(cs.backdropFilter) ||
    set(cs.perspective) ||
    /paint|layout|strict|content/.test(cs.contain ?? "") ||
    /transform|filter|perspective/.test(cs.willChange ?? "")
  );
}

/**
 * Where a panel that leaves its trigger's box goes: into the dialog the trigger is in (a chat window, a lead's drawer),
 * so a screen reader inside that dialog still reaches it; <body> otherwise, or when that dialog (or anything around it)
 * would hold a fixed panel inside itself and clip it.
 */
function hostFor(el: HTMLElement): HTMLElement | null {
  const dialog = el.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) return null;
  for (let a: HTMLElement | null = dialog; a && a !== document.body; a = a.parentElement)
    if (holdsFixed(a)) return null;
  return dialog;
}

/** A panel on <body>, fixed beside its trigger's box on the chosen side and edge (6px off, as inline). */
function fixedAt(
  at: { top: number; bottom: number; left: number; right: number },
  side: "below" | "above",
  align: "start" | "end",
) {
  return {
    position: "fixed" as const,
    top: side === "below" ? `${Math.round(at.bottom + 6)}px` : "auto",
    bottom: side === "above" ? `${Math.round(window.innerHeight - at.top + 6)}px` : "auto",
    left: align === "start" ? `${Math.round(at.left)}px` : "auto",
    right: align === "end" ? `${Math.round(window.innerWidth - at.right)}px` : "auto",
  };
}

/** The panel's exit, in ms (its CSS is 140 ms); a little over, as the backstop. */
const EXIT_MS = 180;

/**
 * A small panel anchored to its trigger. It scales in from the trigger (spatial consistency), closes on
 * Escape or a click outside, and hands focus back to the trigger, so keyboard people never get lost.
 */
export function Popover({
  label,
  trigger,
  triggerClassName,
  triggerLabel,
  size = "menu",
  role = "dialog",
  align = "start",
  side = "below",
  active,
  disabled,
  portal = false,
  children,
}: Props) {
  const [open, setOpenNow] = useState(false);
  // On <body>: asked for, or because the trigger sits inside something that clips (decided as it opens).
  const [clipped, setClipped] = useState(false);
  // The dialog it goes into instead of <body> (decided with `clipped`).
  const [host, setHost] = useState<HTMLElement | null>(null);
  const onBody = portal || clipped;
  // Closing plays a short exit (Popover.module.css), then the panel goes.
  const [closing, setClosing] = useState(false);
  const shown = useRef({ open: false, closing: false });
  const gone = useCallback(() => {
    shown.current = { open: false, closing: false };
    setClosing(false);
    setOpenNow(false);
  }, []);
  const setOpen = useCallback((next: boolean | ((v: boolean) => boolean)) => {
    const now = shown.current.open && !shown.current.closing;
    const want = typeof next === "function" ? next(now) : next;
    if (want) {
      shown.current = { open: true, closing: false };
      setClosing(false);
      setOpenNow(true);
    } else if (now) {
      shown.current.closing = true;
      setClosing(true);
    }
  }, []);
  useEffect(() => {
    if (!closing) return;
    // animationend ends it; this is the backstop (a browser that runs no animation, a test).
    const t = setTimeout(gone, EXIT_MS);
    return () => clearTimeout(t);
  }, [closing, gone]);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{
    side: "below" | "above";
    room: number;
    align: "start" | "end";
    /** Sideways, in px: a panel wider than the room on either side of its trigger, moved back onto the window. */
    nudge: number;
    /** On <body>: where the trigger is, for the fixed panel. */
    at?: { top: number; bottom: number; left: number; right: number };
  } | null>(null);
  // Measured as it opens, before it paints: which side, how tall it may be there, and which edge it lines up
  // with — a panel that would run past the edge of what clips it (a drawer, the window) lines up with the
  // other edge of its trigger instead, so nothing scrolls sideways to show it.
  const measure = useCallback(() => {
    const r = root.current?.getBoundingClientRect();
    if (!r) return;
    // Inline, the panel is seen only inside the box that scrolls it (the page's scroller): its room ends there.
    const frame = onBody
      ? null
      : root.current?.closest<HTMLElement>("[data-scroll]")?.getBoundingClientRect();
    const floor = Math.min(window.innerHeight, frame?.bottom ?? Infinity);
    const ceiling = Math.max(0, frame?.top ?? 0);
    const below = floor - r.bottom - 12;
    const above = r.top - ceiling - 12;
    // A side that's asked for is kept while the panel fits there; one that doesn't fit turns over to the side with
    // more room (owner, 2026-11-04: a menu ran off the foot of a phone). Its whole height, not the part shown.
    const need = Math.max(panel.current?.offsetHeight ?? 0, panel.current?.scrollHeight ?? 0);
    const chosen =
      side === "auto"
        ? below < 420 && above > below
          ? "above"
          : "below"
        : side === "below" && need > below && above > below
          ? "above"
          : side === "above" && need > above && below > above
            ? "below"
            : side;
    const width = panel.current?.offsetWidth ?? 0;
    const clip = onBody ? { left: 0, right: window.innerWidth } : clipOf(root.current!);
    const fits = (a: "start" | "end") =>
      a === "start" ? r.left + width <= clip.right - 8 : r.right - width >= clip.left + 8;
    const other = align === "start" ? "end" : "start";
    const edge = fits(align) || !fits(other) ? align : other;
    if (panel.current) panel.current.dataset.align = edge;
    // Wider than the room on either side (a phone): moved sideways until it's on the window, 8px in.
    const left = edge === "start" ? r.left : r.right - width;
    let nudge = left + width > window.innerWidth - 8 ? window.innerWidth - 8 - (left + width) : 0;
    if (left + nudge < 8) nudge = 8 - left;
    setPlace({
      side: chosen,
      room: Math.max(160, Math.floor(chosen === "above" ? above : below)),
      align: edge,
      nudge: width ? Math.round(nudge) : 0,
      ...(onBody ? { at: { top: r.top, bottom: r.bottom, left: r.left, right: r.right } } : {}),
    });
  }, [side, align, onBody]);

  useLayoutEffect(() => {
    if (!open) return setPlace(null);
    measure();
  }, [open, measure]);

  // On <body> the panel is fixed, so it's placed again whenever its trigger moves (a scroll, the page settling as data
  // loads, the window resizing) or the panel itself grows (its list arrives): never left behind, never off the window.
  useEffect(() => {
    if (!open || !onBody) return;
    const key = () => {
      const r = root.current?.getBoundingClientRect();
      const p = panel.current;
      return r
        ? `${r.top}|${r.bottom}|${r.left}|${r.right}|${p?.scrollHeight ?? 0}|${p?.offsetWidth ?? 0}`
        : "";
    };
    // As placed when it opened; any change from here on places it again.
    let last = key();
    let frame = 0;
    const look = () => {
      const now = key();
      if (now !== last) {
        last = now;
        measure();
      }
      frame = requestAnimationFrame(look);
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [open, onBody, measure]);

  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!pressedWithin(e.target, root.current, panel.current)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    panel.current
      ?.querySelector<HTMLElement>('input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])')
      ?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open, close, setOpen]);

  const panelEl = (
    <div
      ref={panel}
      id={id}
      role={role}
      aria-label={label}
      className={s.panel}
      data-popover
      data-closing={closing || undefined}
      onKeyDown={(e) => {
        // Moved out of its trigger's box, the panel isn't next to it in the page's order: Tab past either end goes
        // back to the trigger (and closes it) rather than off to the end of the document.
        if (e.key !== "Tab" || !onBody || !panel.current) return;
        const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
          (el) => !el.closest("[inert]"),
        );
        const edge = e.shiftKey ? items[0] : items.at(-1);
        if (!items.length || document.activeElement === edge) {
          e.preventDefault();
          close();
        }
      }}
      onAnimationEnd={(e) => {
        if (closing && e.target === e.currentTarget) gone();
      }}
      data-align={place?.align ?? align}
      data-side={place?.side ?? (side === "above" ? "above" : "below")}
      data-portal={onBody || undefined}
      style={
        place
          ? {
              maxHeight: `min(${size === "form" ? "640px, calc(100vh - 96px)" : "420px, 60vh"}, ${place.room}px)`,
              ...(place.at ? fixedAt(place.at, place.side, place.align) : {}),
              ...(place.nudge ? { "--nudge": `${place.nudge}px` } : {}),
            }
          : undefined
      }
      data-size={size}
    >
      {typeof children === "function" ? children(close) : children}
    </div>
  );

  return (
    <div className={s.root} ref={root}>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-haspopup={role}
        aria-expanded={open && !closing}
        aria-controls={open ? id : undefined}
        data-active={active || undefined}
        disabled={disabled}
        onClick={() => {
          if (!shown.current.open && root.current) {
            setClipped(insideClip(root.current));
            setHost(hostFor(root.current));
          }
          setOpen((v) => !v);
        }}
      >
        {trigger}
      </button>
      {open && (onBody ? host ? createPortal(panelEl, host) : <BodyPortal>{panelEl}</BodyPortal> : panelEl)}
    </div>
  );
}
