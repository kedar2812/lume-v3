"use client";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  if (!host) return null;
  return createPortal(
    <div className={className ? `${s.layer} ${className}` : s.layer} data-scrim>
      <div className={s.scrim} onClick={onClose} aria-hidden />
      {children}
    </div>,
    host,
  );
}
