"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { NetState, NetWatch } from "@/lib/network/watch";
import s from "./Toast.module.css";

const WORDS: Record<Exclude<NetState, "fine">, { title: string; detail?: string }> = {
  offline: { title: "You’re offline", detail: "LUME reconnects by itself the moment it’s back." },
  slow: {
    title: "Your internet is slow",
    detail: "LUME is answering fast. Your connection is taking longer.",
  },
  back: { title: "Back online" },
};
const ICON = { offline: UI_ICONS.offline, slow: UI_ICONS.slowNetwork, back: UI_ICONS.done } as const;

/**
 * When this device's connection drops or slows, LUME says so (canvas v14, approved 2026-11-26): one message at the
 * bottom of the toast stack, in the toast's own look. It sits inside the toasts' live region, so a screen reader hears
 * it once.
 */
export function ConnectionNotice({ watch }: { watch: NetWatch }) {
  const [state, setState] = useState<NetState>(() => watch.state());
  const reduce = useReducedMotion();
  useEffect(() => {
    setState(watch.state());
    return watch.subscribe(setState);
  }, [watch]);
  const shown = state === "fine" ? null : state;
  return (
    <AnimatePresence initial={false}>
      {shown && (
        <motion.div
          key={shown}
          layout
          className={`${s.toast} ${s.net}`}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.94, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          exit={
            reduce
              ? { opacity: 0 }
              : { opacity: 0, y: 14, scale: 0.96, transition: { duration: 0.2, ease: "easeIn" } }
          }
          transition={toMotion(SPRINGS.bounce)}
        >
          <Glyph state={shown} />
          <span className={s.text}>
            <span className={s.title}>{WORDS[shown].title}</span>
            {WORDS[shown].detail && <span className={s.detail}>{WORDS[shown].detail}</span>}
          </span>
          {shown === "offline" && (
            <span className={s.dots} aria-hidden>
              <i />
              <i />
              <i />
            </span>
          )}
          {shown === "slow" && (
            <button type="button" className={s.action} onClick={() => watch.dismiss()}>
              Dismiss
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Glyph({ state }: { state: Exclude<NetState, "fine"> }) {
  const Icon = ICON[state];
  return (
    <span className={s.netIcon} data-tone={state}>
      <Icon size={ICON_SIZE.sm} aria-hidden />
    </span>
  );
}
