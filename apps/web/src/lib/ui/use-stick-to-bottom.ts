"use client";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Within this of the bottom still counts as at the bottom (a message's last line half in view). */
const NEAR_PX = 48;

/**
 * Keep a scrolling conversation's newest message in view as it grows (a new message, words being typed), but
 * only while the person is at the bottom: someone who scrolled up to read is left where they are until they scroll
 * back down (Autopilot A3, the live conversation).
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, change: unknown): void {
  const atBottom = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // Words typed into the conversation (LUME AI writing) change it without a new message: follow those too.
    const typed = new MutationObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    typed.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      typed.disconnect();
    };
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [ref, change]);
}
