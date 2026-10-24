"use client";
import { motion, useDragControls, useReducedMotion } from "motion/react";
import { useRef, type ReactNode } from "react";
import { SPRINGS, sheetDismisses, toMotion } from "@/lib/motion";
import { usePhone } from "@/lib/usePhone";
import { BodyPortal } from "./BodyPortal";
import { IconButton } from "./IconButton";
import { useModalFocus } from "./useModalFocus";
import s from "./Sheet.module.css";

/** How far a press may move and still be a tap (Apple's hysteresis, about 10 px). */
const TAP_SLOP = 8;

/**
 * A sheet for a task with several choices (Autopilot's start, spec 2026-10-19 §1 and §2.3): on a computer it slides in
 * from the right over the full-window scrim; on a phone it rises from the bottom, its actions (`footer`) pinned within
 * thumb reach, and it follows the finger down from its handle, closing when let go past the point it would rest at.
 * Focus moves in and stays in; Escape, the scrim and Close all close it. Render it inside `AnimatePresence` so it
 * leaves the way it came.
 */
export function Sheet({
  label,
  onClose,
  children,
  footer,
  headerEnd,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  /** The sheet's actions, pinned to its bottom edge. */
  footer?: ReactNode;
  /** Beside the title row's close button (a step's own control). */
  headerEnd?: ReactNode;
}) {
  const phone = usePhone();
  const reduce = !!useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const focus = useModalFocus(panel, onClose);
  const drag = useDragControls();
  /** Where the handle was pressed: a press that moved is a drag, and its click isn't a tap to close. */
  const pressedAt = useRef<number | null>(null);
  const moved = useRef(false);
  // From where it comes and goes: the right edge on a computer, the bottom on a phone (spatial consistency).
  const away = reduce ? { opacity: 0 } : phone ? { y: "100%" } : { x: "calc(100% + 24px)" };
  const here = reduce ? { opacity: 1 } : phone ? { y: 0 } : { x: 0 };

  return (
    <BodyPortal>
      <>
        <motion.div
          className={s.scrim}
          data-sheet-scrim
          onClick={onClose}
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        />
        <motion.div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          data-phone={phone || undefined}
          className={s.sheet}
          onKeyDown={focus.onKeyDown}
          initial={away}
          animate={here}
          exit={away}
          transition={toMotion(SPRINGS.drawer)}
          {...(phone && !reduce
            ? {
                drag: "y" as const,
                dragControls: drag,
                dragListener: false,
                dragConstraints: { top: 0, bottom: 0 },
                dragElastic: { top: 0.06, bottom: 1 },
                dragSnapToOrigin: true,
                onDragEnd: (_: unknown, i: { offset: { y: number }; velocity: { y: number } }) => {
                  if (sheetDismisses(i.offset.y, i.velocity.y)) onClose();
                },
              }
            : {})}
        >
          {phone && (
            <button
              type="button"
              className={s.handle}
              aria-label="Close, or drag down"
              onClick={() => {
                if (!moved.current) onClose();
                moved.current = false;
              }}
              onPointerDown={(e) => {
                pressedAt.current = e.clientY;
                moved.current = false;
                drag.start(e);
              }}
              onPointerUp={(e) => {
                if (pressedAt.current !== null && Math.abs(e.clientY - pressedAt.current) > TAP_SLOP)
                  moved.current = true;
                pressedAt.current = null;
              }}
            >
              <span aria-hidden />
            </button>
          )}
          <div className={s.top}>
            <IconButton label="Close (Esc)" onClick={onClose}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </IconButton>
            {headerEnd && <div className={s.topEnd}>{headerEnd}</div>}
          </div>
          <div className={s.body}>{children}</div>
          {footer && <div className={s.footer}>{footer}</div>}
        </motion.div>
      </>
    </BodyPortal>
  );
}
