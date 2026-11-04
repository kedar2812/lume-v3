"use client";
import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { VersionRoll } from "./Overture";
import s from "./whats-new.module.css";

/** How often the small version rolls again, a quiet reminder there's something to see (the approved mock). */
export const ROLL_EVERY_MS = 4500;

/**
 * The version, small, rolling from the last release to this one now and then (Today's pill, Settings → About). Still
 * under reduced motion: this version, resting.
 */
export function SmallRoll({ from, to }: { from: string; to: string }) {
  const still = useReducedMotion() ?? false;
  const [rolled, setRolled] = useState(true);
  useEffect(() => {
    if (still) return;
    let back: ReturnType<typeof setTimeout> | undefined;
    const t = setInterval(() => {
      setRolled(false);
      back = setTimeout(() => setRolled(true), 350);
    }, ROLL_EVERY_MS);
    return () => {
      clearInterval(t);
      clearTimeout(back);
    };
  }, [still]);
  return (
    <span className={s.vroll} data-rolled={rolled || undefined} data-still={still || undefined}>
      <VersionRoll from={from} to={to} />
    </span>
  );
}
