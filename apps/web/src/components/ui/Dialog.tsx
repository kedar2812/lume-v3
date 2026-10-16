"use client";
import { useRef, type ReactNode } from "react";
import s from "./Dialog.module.css";
import { Scrim } from "./Scrim";
import { useModalFocus } from "./useModalFocus";

/**
 * A small modal question over the full-window scrim (7C): focus moves in and stays in, Escape or the scrim cancels, and
 * focus goes back to where it was when it closes.
 */
export function Dialog({
  label,
  onClose,
  children,
  wide = false,
  width,
  className,
  layerClassName,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** Room for a small form (a stage's automations), not just a question. */
  wide?: boolean;
  /** A sheet with steps and figures (6C Offboard): wider still, in px, never past the screen. */
  width?: number;
  /** A sheet with its own insides (Send feedback): its panel and layer classes, added to the usual ones. */
  className?: string;
  layerClassName?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);

  const focus = useModalFocus(panel, onClose);

  return (
    <Scrim onClose={onClose} className={layerClassName ? `${s.layer} ${layerClassName}` : s.layer}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={[s.panel, (wide || width) && s.wide, className].filter(Boolean).join(" ")}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
        onKeyDown={focus.onKeyDown}
      >
        {children}
      </div>
    </Scrim>
  );
}
