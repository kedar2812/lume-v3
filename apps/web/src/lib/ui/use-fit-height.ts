"use client";
import { useLayoutEffect, type RefObject } from "react";

/**
 * Sizes an element to reach from where it starts to `gap` above the window's foot, and keeps it so as the window or
 * anything above it changes (a banner, an announcement): the page itself never scrolls, only what's inside the element
 * does (owner, 2026-11-01: scrolling the LUME AI page meant fighting the page and the conversation at once). Never
 * below `min`; a window too short for that scrolls the page as any other.
 */
export function useFitHeight(
  ref: RefObject<HTMLElement | null>,
  o: { gap?: number; min?: number; on?: boolean } = {},
) {
  const { gap = 24, min = 420, on = true } = o;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    let frame = 0;
    const fit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Measured from the page's top, not the window's: a page scrolled a little still sizes the same.
        const scroller = el.closest<HTMLElement>("[data-scroll]");
        const top = el.getBoundingClientRect().top + (scroller?.scrollTop ?? 0);
        el.style.height = `${Math.max(min, Math.floor(window.innerHeight - top - gap))}px`;
      });
    };
    fit();
    window.addEventListener("resize", fit);
    // Anything above it growing or shrinking moves where it starts. A browser without ResizeObserver (an old one, a
    // test's) follows the window alone.
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    const above = el.closest<HTMLElement>("main") ?? document.body;
    for (const child of Array.from(above.children)) if (!child.contains(el)) watch?.observe(child);
    if (el.previousElementSibling) watch?.observe(el.previousElementSibling);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", fit);
      watch?.disconnect();
      el.style.height = "";
    };
  }, [ref, gap, min, on]);
}
