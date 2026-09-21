"use client";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { SPRINGS, settleTime, toLinearEasing } from "@/lib/motion";
import { NAV_ITEMS, navDirection } from "./nav";

type Api = { go(href: string): void };
const NavCtx = createContext<Api>({ go: () => undefined });
const RefCtx = createContext<RefObject<HTMLDivElement | null> | null>(null);
export const usePageNav = () => useContext(NavCtx);

const reduced = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Page switching (spec §5.3): the old page recedes for 140 ms against the travel direction, then the new
 * page's [data-stagger] sections arrive in reading order along it. A newer navigation interrupts instantly.
 * Only <PageContent> animates; the sidebar and top bar stay put.
 */
export function PageTransitionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const container = useRef<HTMLDivElement>(null);
  const prev = useRef(pathname);
  const pending = useRef<Animation | null>(null);

  const go = useCallback(
    (href: string) => {
      if (href === pathname) return;
      pending.current?.cancel();
      const el = container.current;
      if (!el || reduced() || typeof el.animate !== "function") return router.push(href);
      const dir = navDirection(NAV_ITEMS, pathname, href) || 1;
      const a = el.animate(
        [
          { opacity: 1, transform: "none", filter: "blur(0)" },
          { opacity: 0, transform: `translateY(${-8 * dir}px) scale(0.992)`, filter: "blur(2px)" },
        ],
        { duration: 140, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" },
      );
      pending.current = a;
      a.finished.then(() => pending.current === a && router.push(href)).catch(() => undefined);
    },
    [pathname, router],
  );

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    el.getAnimations().forEach((a) => a.cancel());
    pending.current = null;
    const dir = navDirection(NAV_ITEMS, prev.current, pathname) || 1;
    prev.current = pathname;
    if (reduced() || typeof el.animate !== "function") return;
    const ease = toLinearEasing(SPRINGS.soft);
    el.querySelectorAll<HTMLElement>("[data-stagger]").forEach((node, i) =>
      node.animate(
        [
          { opacity: 0, transform: `translateY(${16 * dir}px)` },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: settleTime(SPRINGS.soft) * 1000,
          easing: ease,
          delay: i * 38,
          fill: "backwards",
        },
      ),
    );
  }, [pathname]);

  useEffect(() => {
    container.current?.closest("[data-scroll]")?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <NavCtx.Provider value={{ go }}>
      <RefCtx.Provider value={container}>{children}</RefCtx.Provider>
    </NavCtx.Provider>
  );
}

/** Wraps the routed page; this is the element that recedes and whose sections stagger in. */
export function PageContent({ children }: { children: ReactNode }) {
  const ref = useContext(RefCtx);
  return <div ref={ref ?? undefined}>{children}</div>;
}
