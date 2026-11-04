"use client";
import { useEffect, useState } from "react";
import s from "./whats-new.module.css";

/** The opening's beats (the approved mock): the words rise, the number rolls, the opening lifts away, the stage. */
export const OVERTURE = { show: 500, roll: 1000, leave: 2700, done: 3300 } as const;

/** The version, big: each part that changed rolls from the last release's to this one's ("1.1.0" to "1.2.0"). */
export function VersionRoll({ from, to, className }: { from: string; to: string; className?: string }) {
  const a = from.split(".");
  const b = to.split(".");
  return (
    <span className={className} aria-hidden>
      {b.map((part, i) => (
        <span key={i} className={s.vpart}>
          {i > 0 && <span className={s.dot}>.</span>}
          {a[i] === part ? (
            part
          ) : (
            <span className={s.roll}>
              <span>{a[i] ?? part}</span>
              <span>{part}</span>
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

export function Overture({ from, to }: { from: string; to: string }) {
  const [beat, setBeat] = useState<"" | "show" | "rolled" | "leave">("");
  useEffect(() => {
    const t = [
      setTimeout(() => setBeat("show"), OVERTURE.show),
      setTimeout(() => setBeat("rolled"), OVERTURE.roll),
      setTimeout(() => setBeat("leave"), OVERTURE.leave),
    ];
    return () => t.forEach(clearTimeout);
  }, []);
  return (
    <div className={s.overture} data-beat={beat} aria-hidden>
      <div className={s.stack}>
        <div className={s.brandline}>
          <img src="/lume-mark.png" alt="" />
          LUME
        </div>
        <VersionRoll from={from} to={to} className={s.version} />
        <div className={s.wordin}>What&apos;s new in LUME</div>
      </div>
    </div>
  );
}
