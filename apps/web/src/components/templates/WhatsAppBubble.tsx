"use client";
import { motion, useReducedMotion } from "motion/react";
import { Fragment, type ReactNode } from "react";
import { waFormat } from "@lume/core/shared";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./templates.module.css";

/** A variable that had nothing to say stays as written; the preview marks it amber. */
function withGaps(text: string): ReactNode[] {
  return text.split(/(\{\{[^{}]+\}\})/g).map((part, i) =>
    /^\{\{[^{}]+\}\}$/.test(part) ? (
      <mark key={i} className={s.gap} data-missing>
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/**
 * The message as WhatsApp will show it: an outgoing bubble with its tail, *bold* and _italic_ as they'll
 * appear, and any gaps in amber. It re-flows with a spring as the words change (instantly with Reduce Motion).
 */
export function WhatsAppBubble({ text, label = "Preview" }: { text: string; label?: string }) {
  const reduce = useReducedMotion();
  const runs = waFormat(text);
  return (
    <figure className={s.chat} aria-label={label}>
      <motion.div
        className={s.bubble}
        layout={!reduce}
        transition={toMotion(SPRINGS.default)}
        data-empty={text.trim() ? undefined : true}
      >
        {text.trim()
          ? runs.map((r, i) =>
              r.b ? (
                <strong key={i}>{withGaps(r.t)}</strong>
              ) : r.i ? (
                <em key={i}>{withGaps(r.t)}</em>
              ) : (
                <Fragment key={i}>{withGaps(r.t)}</Fragment>
              ),
            )
          : "Your message appears here as WhatsApp will show it."}
      </motion.div>
    </figure>
  );
}
