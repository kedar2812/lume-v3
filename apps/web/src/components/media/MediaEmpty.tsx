"use client";
import { motion, useReducedMotion } from "motion/react";
import { SPRINGS, toMotion } from "@/lib/motion";
import { mediaSteps } from "./MediaGuide";
import s from "./media.module.css";

/**
 * Nothing in Media yet (canvas Empty): what goes here, why, and how, so nobody needs it explained. A small stack of
 * a photo, a page and a video settles in; the three steps follow.
 */
export function MediaEmpty({ canManage, onAdd }: { canManage: boolean; onAdd(): void }) {
  const reduce = !!useReducedMotion();
  const card = (i: number) =>
    reduce
      ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
      : {
          initial: { opacity: 0, y: 18, rotate: 0 },
          animate: { opacity: 1, y: 0, rotate: [-8, 0, 8][i] },
          transition: { ...toMotion(SPRINGS.bounce), delay: 0.05 + i * 0.06 },
        };
  return (
    <div className={s.empty}>
      <div className={s.stack} aria-hidden>
        <motion.span className={s.stackPhoto} {...card(0)} />
        <motion.span className={s.stackVideo} {...card(2)}>
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.5v13l11-6.5z" />
          </svg>
        </motion.span>
        <motion.span className={s.stackPage} {...card(1)}>
          <b>PDF</b>
          <i />
          <i />
          <i />
        </motion.span>
      </div>
      <div className={s.emptyWords}>
        <h2>Your brochures, photos and videos, in one place</h2>
        <p>
          {canManage
            ? "Add each file once. From then on, anyone on your team sends it from a lead's WhatsApp in two taps, as the real file."
            : "Your admins add the business's files here. Then anyone on the team sends them from a lead's WhatsApp, as the real file."}
        </p>
      </div>
      {canManage && (
        <div className={s.emptyAct}>
          <button type="button" className={s.primary} onClick={onAdd}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add your first file
          </button>
          <span className={s.orDrag}>or drag files anywhere on this page</span>
        </div>
      )}
      <ul className={s.emptySteps} aria-label="How it works">
        {mediaSteps(canManage).map((step) => (
          <li key={step.title} className={s.step}>
            <span className={s.stepIcon} data-tone={step.tone}>
              {step.icon}
            </span>
            <span className={s.stepText}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
