"use client";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Odometer } from "@/components/ui/Odometer";
import { RefreshMorph, Tick } from "@/components/ui/RefreshMorph";
import { usePhasedRefresh } from "@/components/ui/usePhasedRefresh";
import s from "@/components/ui/refresh.module.css";
import { leadsClient } from "@/lib/leads/client";
import { VIEWS_CHANGED } from "@/lib/views/client";

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
const plural = (n: number) => `${n.toLocaleString("en")} new ${n === 1 ? "lead" : "leads"}`;

/**
 * Refresh on Leads and the board when no Google Sheet is connected (owner, 2026-10-05): the same v5 motion as the
 * Sheets Refresh, its card showing leads settling into the list while LUME checks what arrived since you looked,
 * then "✓ 3 new" or "Up to date". It reloads the list, the stage counts and the sidebar's views. R presses it.
 */
export function ReloadRefresh({
  pipelineId,
  onReload,
  shortcut = true,
}: {
  pipelineId: string | undefined;
  onReload(): void;
  shortcut?: boolean;
}) {
  const reduce = !!useReducedMotion();
  const since = useRef(new Date().toISOString());
  const run = useCallback(async () => {
    const from = since.current;
    since.current = new Date().toISOString();
    const r = pipelineId
      ? await leadsClient.counts({ stageIds: [], sort: "newest", arrivedAfter: from, pipelineId })
      : null;
    onReload();
    // The sidebar's view counts look again too.
    window.dispatchEvent(new Event(VIEWS_CHANGED));
    if (r && !r.ok) throw new Error(r.message);
    return r?.ok ? r.data.total : 0;
  }, [pipelineId, onReload]);
  const announce = useCallback((n: number) => (n ? `${plural(n)} since you looked.` : "Up to date."), []);
  const r = usePhasedRefresh({ reduce, run, announce });

  const btn = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState({ w: 96, h: 32 });
  useLayoutEffect(() => {
    if (btn.current) setBox({ w: btn.current.offsetWidth, h: btn.current.offsetHeight });
  }, [r.phase]);
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

  const n = r.result ?? 0;
  const warn = !!r.failure;
  const landed = warn ? "Try later" : n ? `${n.toLocaleString("en")} new` : "Up to date";
  return (
    <span className={s.anchor}>
      <Button
        ref={btn}
        aria-disabled={r.phase !== "idle" || undefined}
        aria-keyshortcuts="R"
        title="Refresh (R)"
        className={s.button}
        data-phase={r.phase}
        onClick={() => void r.press()}
      >
        {r.phase === "landed" ? (
          <span className={s.landed} data-warn={warn || undefined}>
            {!warn && <Tick size={13} />}
            {landed}
          </span>
        ) : (
          <>
            <Arrow spin={r.phase !== "idle"} />
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
            Checking for new leads…
          </>
        }
        card={
          <>
            <div className={s.rows} data-flowing={!reduce || undefined} aria-hidden>
              {[0, 1, 2].map((i) => (
                <span key={i} className={s.row} style={{ ["--i" as string]: i }}>
                  <i />
                  <b />
                  <em />
                </span>
              ))}
            </div>
            <p className={s.title}>Checking for new leads</p>
            <p className={s.sub}>Everything that’s arrived since you looked</p>
          </>
        }
        result={
          warn ? (
            <>
              <p className={s.resultTitle}>Couldn’t refresh</p>
              <p className={s.sub}>{r.failure}</p>
            </>
          ) : n ? (
            <>
              <p className={s.count}>
                <Odometer value={n} />
              </p>
              <p className={s.sub}>{n === 1 ? "new lead since you looked" : "new leads since you looked"}</p>
            </>
          ) : (
            <>
              <p className={s.resultTitle}>Up to date</p>
              <p className={s.sub}>No new leads since you looked.</p>
            </>
          )
        }
        face={
          <>
            <Tick size={13} />
            {landed}
          </>
        }
      />
      {r.said && (
        <p role="status" aria-live="polite" className={s.srOnly}>
          {r.said}
        </p>
      )}
    </span>
  );
}
