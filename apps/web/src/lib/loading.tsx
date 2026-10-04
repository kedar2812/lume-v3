"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Loading, said the same way everywhere (7C, canvas Loading): whatever is fetching registers, and one bar under
 * the top bar shows that LUME is working. Screens add their own skeletons; the bar is the one shared signal.
 */
type Loading = { add: () => () => void; count: number };
const Ctx = createContext<Loading | null>(null);

export function LoadingProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const add = useCallback(() => {
    setCount((c) => c + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      setCount((c) => c - 1);
    };
  }, []);
  return <Ctx.Provider value={{ add, count }}>{children}</Ctx.Provider>;
}

/** While `active`, this load counts toward the bar. Outside a provider it does nothing. */
export function useLoadingSignal(active: boolean) {
  const add = useContext(Ctx)?.add;
  useEffect(() => {
    if (!active || !add) return;
    return add();
  }, [active, add]);
}

export function useLoadingCount(): number {
  return useContext(Ctx)?.count ?? 0;
}

/** Where the bar stands `ms` into a load: a leap to a third, then a creep that slows and never quite arrives. */
export function creep(ms: number): number {
  return 0.92 - 0.62 * Math.exp(-ms / 1800);
}

/** True once `active` has lasted `ms`; false the moment it stops. */
export function useAfter(active: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(false);
    if (!active) return;
    const t = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return active && on;
}

/**
 * While `active`, counts down from `seconds` and calls `onZero` at the end, then starts over (a retry that fails
 * keeps it active). Returns the seconds left, or null when inactive.
 */
export function useCountdown(active: boolean, seconds: number, onZero: () => void): number | null {
  const [left, setLeft] = useState<number | null>(active ? seconds : null);
  const zero = useRef(onZero);
  zero.current = onZero;
  useEffect(() => {
    if (!active) return setLeft(null);
    let n = seconds;
    setLeft(n);
    const t = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        n = seconds;
        zero.current();
      }
      setLeft(n);
    }, 1000);
    return () => clearInterval(t);
  }, [active, seconds]);
  return active ? (left ?? seconds) : null;
}
