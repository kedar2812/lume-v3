"use client";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import s from "./Popover.module.css";

type Props = {
  /** The panel's accessible name (and the trigger's, unless `trigger` says otherwise). */
  label: string;
  /** What the trigger button shows. */
  trigger: ReactNode;
  triggerClassName?: string;
  /** "dialog" for a small form or chooser, "menu" for a list of actions. */
  role?: "dialog" | "menu";
  align?: "start" | "end";
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
  role = "dialog",
  align = "start",
  active,
  disabled,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

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
        <div ref={panel} id={id} role={role} aria-label={label} className={s.panel} data-align={align}>
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
