"use client";
import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./media.module.css";

export const AddIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M12 18v-6M9 15l3-3 3 3" />
  </svg>
);
export const OpenIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const LinkIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </svg>
);
export const WhatsAppMark = () => <img src="/brand/whatsapp-app.png" alt="" width={20} height={20} />;

export type Step = { tone: "accent" | "wa" | "warn"; icon: ReactNode; title: string; body: string };

/** What Media is for, in three steps, each with its icon (owner: icons, never numbers). */
export function mediaSteps(canManage: boolean): Step[] {
  return [
    canManage
      ? {
          tone: "accent",
          icon: <AddIcon />,
          title: "Add a file",
          body: "Drag it anywhere on this page, or use Add media. Photos up to 5 MB, videos 16 MB, PDFs 25 MB.",
        }
      : {
          tone: "accent",
          icon: <OpenIcon />,
          title: "Open a file",
          body: "Tap any file to see it in full, right here in LUME: pages, photos and videos.",
        },
    {
      tone: "wa",
      icon: <WhatsAppMark />,
      title: "Send it from a lead",
      body: "In a lead's WhatsApp tab: Attach, then From Media. It goes as the real file.",
    },
    {
      tone: "warn",
      icon: <LinkIcon />,
      title: "Or share a link",
      body: "Not on WhatsApp? Open a file and switch on Share by link. Switch it off and the link stops working.",
    },
  ];
}

/** The first visit's guide (canvas Main): three steps drawn in one after another; Got it puts it away for good. */
export function MediaGuide({ canManage, onDone }: { canManage: boolean; onDone(): void }) {
  const reduce = !!useReducedMotion();
  return (
    <motion.section
      className={s.guide}
      aria-label="How Media works"
      initial={false}
      exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0, marginBottom: -22, scale: 0.98 }}
      transition={toMotion(SPRINGS.default)}
    >
      <ul className={s.steps}>
        {mediaSteps(canManage).map((step, i) => (
          <motion.li
            key={step.title}
            className={s.step}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...toMotion(SPRINGS.soft), delay: reduce ? 0 : 0.08 + i * 0.07 }}
          >
            <span className={s.stepIcon} data-tone={step.tone}>
              {step.icon}
            </span>
            <span className={s.stepText}>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </span>
          </motion.li>
        ))}
      </ul>
      <button type="button" className={s.gotIt} onClick={onDone}>
        Got it
      </button>
    </motion.section>
  );
}
