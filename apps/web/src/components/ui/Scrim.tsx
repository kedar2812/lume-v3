"use client";
import type { ReactNode } from "react";
import { BodyPortal } from "./BodyPortal";
import s from "./Scrim.module.css";

/**
 * The layer every popup sits on (7C): rendered on <body> and fixed to the whole window, so the sidebar and the top
 * bar step back with everything else. Clicking the dimmed part calls `onClose`; the popup itself is `children`.
 */
export function Scrim({
  onClose,
  children,
  className,
}: {
  onClose?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BodyPortal>
      <div className={className ? `${s.layer} ${className}` : s.layer} data-scrim>
        <div className={s.scrim} onClick={onClose} aria-hidden />
        {children}
      </div>
    </BodyPortal>
  );
}
