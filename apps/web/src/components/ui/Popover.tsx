"use client";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  /** Marks the trigger as holding a value (a filter that is set). */
  active?: boolean;
  disabled?: boolean;
  children: ReactNode | ((close: () => void) => ReactNode);
};

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
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ side: "below" | "above"; room: number } | null>(null);
  // Measured as it opens, before it paints: which side, and how tall it may be there.
  useLayoutEffect(() => {
    if (!open) return setPlace(null);
    const r = root.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const chosen = side === "auto" ? (below < 420 && above > below ? "above" : "below") : side;
    setPlace({ side: chosen, room: Math.max(160, Math.floor(chosen === "above" ? above : below)) });
  }, [open, side]);

  const close = useCallback(() => {
    setOpen(false);
    button.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
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
      ?.focus();
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open, close]);

  return (
    <div className={s.root} ref={root}>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={triggerLabel}
        aria-haspopup={role}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-active={active || undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          role={role}
          aria-label={label}
          className={s.panel}
          data-align={align}
          data-side={place?.side ?? (side === "above" ? "above" : "below")}
          style={
            place
              ? {
                  maxHeight: `min(${size === "form" ? "640px, calc(100vh - 96px)" : "420px, 60vh"}, ${place.room}px)`,
                }
              : undefined
          }
          data-size={size}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
