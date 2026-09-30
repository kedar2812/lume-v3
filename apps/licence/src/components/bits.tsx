"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { countryName } from "@/lib/places";
import { ARROWS, type Trend } from "@/lib/trend";

/** The trend rule's chip: a jagged arrow for the direction, green or red for good or bad, and the signed number. */
export function Delta({ t, size = 13 }: { t: Trend; size?: number }) {
  return (
    <span className={`delta ${t.tone}`} data-dir={t.dir}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d={ARROWS[t.dir]} />
      </svg>
      {t.text}
    </span>
  );
}

/** A country's flag (country-flag-icons, MIT, as LUME ships them). */
export function Flag({
  country,
  decorative = false,
  style,
}: {
  country: string;
  decorative?: boolean;
  style?: React.CSSProperties;
}) {
  const name = countryName(country);
  return (
    <img
      className="flag"
      src={`/flags/${country}.svg`}
      alt={decorative ? "" : name}
      title={decorative ? undefined : name}
      style={style}
      width={22}
      height={16}
    />
  );
}

/** One line at the foot of the screen, gone after a few seconds. */
export function useToast(): [string, (msg: string) => void] {
  const [msg, setMsg] = useState("");
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(t.current);
    t.current = setTimeout(() => setMsg(""), 2800);
  }, []);
  useEffect(() => () => clearTimeout(t.current), []);
  return [msg, say];
}
export function Toast({ msg }: { msg: string }) {
  if (!msg) return null;
  return (
    <div className="toast" role="status">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="#2fd08a"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3.5 8.5l3 3 6-7" />
      </svg>
      {msg}
    </div>
  );
}

export const STATE_WORDS = {
  active: "Active",
  grace: "Grace",
  read_only: "Read-only",
  suspended: "Suspended",
} as const;
export function StatePill({ state, morph }: { state: keyof typeof STATE_WORDS; morph?: number }) {
  return (
    <span key={morph} className={`pill ${state}${morph ? " morph" : ""}`}>
      <i />
      {STATE_WORDS[state]}
    </span>
  );
}
