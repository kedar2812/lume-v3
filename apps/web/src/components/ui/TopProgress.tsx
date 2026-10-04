"use client";
import { useEffect, useRef, useState } from "react";
import { creep, useLoadingCount } from "@/lib/loading";
import s from "./TopProgress.module.css";

const GRACE = 150; // an answer quicker than this never shows a bar
const FADE = 500;

/**
 * The bar under the top bar (7C, canvas Loading): it leaps when a load has lasted a moment, creeps while it goes on,
 * and runs to the end and fades when the last one finishes. Decorative: each screen marks itself aria-busy.
 */
export function TopProgress() {
  const count = useLoadingCount();
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [p, setP] = useState(0);
  const started = useRef(0);

  useEffect(() => {
    if (count > 0) {
      if (state === "running") return;
      const t = setTimeout(() => {
        started.current = Date.now();
        setP(creep(0));
        setState("running");
      }, GRACE);
      return () => clearTimeout(t);
    }
    if (state !== "running") return;
    setP(1);
    setState("done");
  }, [count, state]);

  useEffect(() => {
    if (state === "running") {
      const t = setInterval(() => setP(creep(Date.now() - started.current)), 200);
      return () => clearInterval(t);
    }
    if (state === "done") {
      const t = setTimeout(() => {
        setState("idle");
        setP(0);
      }, FADE);
      return () => clearTimeout(t);
    }
  }, [state]);

  return (
    <span className={s.track} data-testid="top-progress" data-state={state} aria-hidden>
      <i className={s.bar} style={{ transform: `scaleX(${p})` }} />
    </span>
  );
}
