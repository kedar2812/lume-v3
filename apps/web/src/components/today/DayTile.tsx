"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { timeOf } from "@/lib/dates";
import type { TodayView } from "@/lib/tasks/types";
import { callsLeft } from "@/lib/today/brief";
import { clusterDots, dayline, type DayDot } from "@/lib/today/dayline";
import s from "./today.module.css";

const MIN = 60_000;
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const STATE = { done: "done", over: "overdue", soon: "due soon", later: "later today" } as const;
/** In a group, the one that needs you most is the one its marker opens. */
const URGENCY: DayDot["state"][] = ["over", "soon", "later", "done"];

/** The day line's width in px, kept up to date: dots group by real distance, not by percent. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

/**
 * Your day (spec: Your day): one line from morning to night with now on it — calls above, follow-ups on it by where
 * they stand, the ones from before today counted at its start — and the next call beneath, with Join.
 */
export function DayTile({ v, now, tz }: { v: TodayView; now: Date; tz: string }) {
  const d = dayline(v, now, tz);
  const track = useWidth();
  const next = callsLeft(v.meetings, now)[0];
  const calls = (v.meetings ?? []).filter((m) => m.status === "scheduled" || m.status === "completed").length;
  const fus = d.dots.length + d.older.length;
  const mins = next ? Math.round((Date.parse(next.startsAt) - now.getTime()) / MIN) : 0;
  const inWords =
    mins <= 0
      ? "Happening now"
      : mins < 60
        ? `In ${mins} min`
        : `In ${Math.floor(mins / 60)} h ${mins % 60 ? `${mins % 60} min` : ""}`.trim();
  return (
    <section
      className={`${s.tl} ${s.dayArea}`}
      style={{ "--i": 0 } as CSSProperties}
      aria-labelledby="your-day"
    >
      <div className={s.th}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
        <span id="your-day">Your day</span>
        <span className={s.r} data-live-count data-volatile-count>
          {calls || fus
            ? `${calls} ${calls === 1 ? "call" : "calls"} · ${fus} ${fus === 1 ? "follow-up" : "follow-ups"}`
            : "Nothing planned yet"}
        </span>
      </div>
      {/* Where now and each dot sit follows the hour: screenshots hide it (dots can sit past either end). */}
      <div ref={track.ref} className={s.day} data-live-count data-volatile-day>
        <div className={s.rail}>
          <i style={{ width: `${Math.max(0, Math.min(100, d.now))}%` }} />
        </div>
        {d.hours
          .filter((h) => h.h % 2 === 0 || h.h === d.to / 60)
          .filter((h) => Math.abs(h.left - d.now) > 6)
          .map((h) => (
            <span key={h.h} className={s.hour} style={{ left: `${h.left}%` }} aria-hidden>
              {h.label}
            </span>
          ))}
        {d.calls.map((c, i) => (
          <Link
            key={c.id}
            href={c.m.lead ? `/leads?lead=${c.m.lead.id}` : `/calendar?m=${c.id}`}
            className={s.call}
            data-done={c.done || undefined}
            style={{ left: `${c.left}%`, "--i": i } as CSSProperties}
            aria-label={`${c.m.title} with ${c.m.lead?.name ?? "someone"} at ${timeOf(new Date(c.m.startsAt), tz)}${c.done ? ", over" : ""}`}
            title={`${c.m.lead?.name ?? c.m.title} · ${timeOf(new Date(c.m.startsAt), tz)}`}
          >
            {c.done ? (
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11" />
                <rect x="2" y="6" width="14" height="12" rx="2" />
              </svg>
            )}
            {first(c.m.lead?.name ?? c.m.title)} {timeOf(new Date(c.m.startsAt), tz)}
          </Link>
        ))}
        {clusterDots(d.dots, track.w).map((g) => {
          const say = (t: DayDot) =>
            `${t.title}, ${t.leadName}, ${timeOf(new Date(t.dueAt), tz)}, ${STATE[t.state]}`;
          if (g.length === 1) {
            const t = g[0]!;
            return (
              <Link
                key={t.id}
                href={`/leads?lead=${t.leadId}`}
                className={s.dot}
                data-state={t.state}
                style={{ left: `${t.left}%` }}
                aria-label={say(t)}
                title={`${t.leadName} · ${t.title} · ${timeOf(new Date(t.dueAt), tz)}`}
              />
            );
          }
          // Several at about the same time: one marker with their count, opening the one that needs you most.
          const top = [...g].sort((a, b) => URGENCY.indexOf(a.state) - URGENCY.indexOf(b.state))[0]!;
          return (
            <Link
              key={g.map((t) => t.id).join(":")}
              href={`/leads?lead=${top.leadId}`}
              className={`${s.dot} ${s.dots}`}
              data-state={top.state}
              style={{ left: `${g[0]!.left}%` }}
              aria-label={`${g.length} follow-ups: ${g.map(say).join("; ")}`}
              title={g.map((t) => `${t.leadName} · ${t.title} · ${timeOf(new Date(t.dueAt), tz)}`).join("\n")}
            >
              {g.length}
            </Link>
          );
        })}
        {d.older.length > 0 && (
          <Link
            href={`/leads?lead=${d.older[0]!.leadId}`}
            className={s.older}
            title={d.older.map((t) => t.leadName).join(", ")}
          >
            {d.older.length} from before
          </Link>
        )}
        {d.now >= 0 && d.now <= 100 && (
          <div className={s.now} style={{ left: `${d.now}%` }} aria-hidden>
            <b>{timeOf(now, tz).replace(/ (am|pm)$/, "")}</b>
          </div>
        )}
      </div>
      <div className={s.nextrow}>
        <span className={s.vi} aria-hidden>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11" />
            <rect x="2" y="6" width="14" height="12" rx="2" />
          </svg>
        </span>
        {next ? (
          <>
            <div style={{ minWidth: 0 }}>
              <b>
                {next.lead?.name ?? next.title}
                {next.lead ? ` · ${next.title}` : ""}
              </b>
              <span className={s.sub} data-live-count>
                Next call · {inWords}
              </span>
            </div>
            <time dateTime={next.startsAt}>{timeOf(new Date(next.startsAt), tz)}</time>
            {next.link ? (
              <a className={s.go} href={next.link} target="_blank" rel="noopener noreferrer">
                Join
              </a>
            ) : next.lead ? (
              <Link className={s.go} href={`/leads?lead=${next.lead.id}`}>
                Open lead
              </Link>
            ) : (
              <span />
            )}
          </>
        ) : (
          <>
            <div style={{ minWidth: 0 }}>
              <b>No calls left today</b>
              <span className={s.sub}>Calls on your calendar show here</span>
            </div>
            <span />
            <span />
          </>
        )}
      </div>
    </section>
  );
}
