"use client";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Odometer } from "@/components/ui/Odometer";
import { RefreshMorph, Tick } from "@/components/ui/RefreshMorph";
import type { RefreshProgress } from "@/lib/sheets/types";
import { failureTitle, resultLine, useRefresh, waitWords } from "./useRefresh";
import s from "@/components/ui/refresh.module.css";

const MORPH = { type: "spring", bounce: 0, duration: 0.6 } as const;
const FADE = { duration: 0.2 } as const;

const Arrow = ({ spin }: { spin?: boolean }) => (
  <svg className={spin ? s.spin : undefined} viewBox="0 0 16 16" width="14" height="14" aria-hidden>
    <path
      d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2.5v3h-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
/**
 * Spec §8 and the approved v5 motion. The button lifts into a glass pill, the pill opens into the card
 * (Google Sheets → rows drifting → LUME, a blue bar filling with real progress), the real count arrives,
 * and the card settles back into the button, which says "✓ 3 new" before becoming Refresh again. Focus
 * stays on the button throughout; Reduce Motion gets a still card that fades. No sound.
 */
export function RefreshButton({
  personal,
  onArrived,
  shortcut = true,
}: {
  personal: boolean;
  onArrived(p: RefreshProgress): void;
  shortcut?: boolean;
}) {
  const reduce = !!useReducedMotion();
  const r = useRefresh({ reduce, personal, onArrived });
  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState({ w: 96, h: 32 });
  useLayoutEffect(() => {
    if (btn.current) setBox({ w: btn.current.offsetWidth, h: btn.current.offsetHeight });
  }, [r.phase]);

  // R, from anywhere on the page that isn't a field or an open panel (the same guard as N).
  const press = r.press;
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "r" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable], [role=dialog]"))
        return;
      e.preventDefault();
      btn.current?.focus();
      void press();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut, press]);

  const busy = r.phase !== "idle";
  const p = r.progress;
  const created = p?.created ?? 0;
  const landedLabel =
    r.failure || p?.unreachable
      ? "Try later"
      : created
        ? `${created.toLocaleString("en")} new`
        : "Up to date";
  const nothing = !r.failure && !!p && !p.unreachable && p.status === "done" && !p.created && !p.merged;
  const warn = !!r.failure || !!p?.unreachable;

  return (
    <span className={s.anchor}>
      <Button
        ref={btn}
        aria-disabled={busy || undefined}
        aria-keyshortcuts="R"
        title="Refresh (R)"
        className={s.button}
        data-phase={r.phase}
        onClick={() => void r.press()}
      >
        {r.phase === "landed" ? (
          <span className={s.landed} data-warn={warn || undefined}>
            {!warn && <Tick size={13} />}
            {landedLabel}
          </span>
        ) : (
          <>
            <Arrow spin={busy} />
            Refresh
          </>
        )}
      </Button>
      <RefreshMorph
        phase={r.phase}
        box={box}
        reduce={reduce}
        warn={warn}
        pill={
          <>
            <img src="/lume-mark.png" alt="" width={20} height={20} />
            Syncing new enquiries…
          </>
        }
        card={
          <>
            <div className={s.route} data-flowing={!reduce || undefined}>
              <span className={`${s.end} ${s.sheet}`}>
                <img src="/brand/google-sheets.png" alt="" width={28} height={28} />
              </span>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <span key={i} className={s.glyph} style={{ ["--i" as string]: i }} />
              ))}
              <span className={`${s.end} ${s.lume}`}>
                <img src="/lume-mark.png" alt="" width={28} height={28} />
              </span>
            </div>
            <p className={s.title}>Syncing new enquiries</p>
            <p className={s.sub}>
              {p && p.rowsTotal > 0
                ? `Reading rows… ${p.rowsRead.toLocaleString("en")} of ${p.rowsTotal.toLocaleString("en")}`
                : "Checking for new enquiries…"}
            </p>
            <div className={s.bar} data-indeterminate={!p?.rowsTotal || undefined}>
              <motion.i
                animate={{
                  width: p?.rowsTotal ? `${Math.max(6, (100 * p.rowsRead) / p.rowsTotal)}%` : "18%",
                }}
                transition={reduce ? FADE : MORPH}
              />
            </div>
          </>
        }
        result={
          <>
            {warn ? (
              <>
                <p className={s.resultTitle}>{failureTitle(r.failCode, !!p?.unreachable)}</p>
                <p className={s.sub}>
                  {r.failure ?? `LUME will try again in ${waitWords(p?.retryInS ?? null)}.`}
                </p>
              </>
            ) : nothing ? (
              <>
                <p className={s.resultTitle}>Up to date</p>
                <p className={s.sub}>No new enquiries since the last check.</p>
              </>
            ) : (
              <>
                <p className={s.count}>
                  <Odometer value={created} />
                </p>
                <p className={s.sub}>{resultLine(p, null, personal).replace(/^[\d,]+ /, "")}</p>
              </>
            )}
            {(p?.attention ?? []).map((a) => (
              <Link key={a.id} href={`/settings/integrations/${a.id}`} className={s.attention} tabIndex={-1}>
                “{a.name}” needs attention
              </Link>
            ))}
          </>
        }
        face={
          <>
            <Tick size={13} />
            {landedLabel}
          </>
        }
      />
      {/* The card goes in a moment; what needs attention stays reachable here until the next Refresh. */}
      {(r.phase === "landed" || r.phase === "idle") && r.attention.length > 0 && (
        <span className={s.after}>
          {r.attention.map((a) => (
            <Link key={a.id} href={`/settings/integrations/${a.id}`} className={s.attention}>
              “{a.name}” needs attention
            </Link>
          ))}
        </span>
      )}
      <p role="status" aria-live="polite" className={s.srOnly}>
        {r.announce}
      </p>
    </span>
  );
}
