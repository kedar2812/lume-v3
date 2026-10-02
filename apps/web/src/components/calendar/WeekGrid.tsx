"use client";
import { useMemo } from "react";
import { dayStart, meetingState, WEEK_FROM_HOUR, WEEK_TO_HOUR, weekBlocks } from "@/lib/calendar/agenda";
import type { Meeting } from "@/lib/calendar/types";
import { timeOf } from "@/lib/dates";
import s from "./calendar.module.css";

const HOURS = WEEK_TO_HOUR - WEEK_FROM_HOUR;
/** Pixels per minute: an hour is 48 px tall. */
const PX = 0.8;
const fmtWeekday = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
const fmtLongWeekday = (tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" });
const fmtDay = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" });

/**
 * The week (canvas Main): 8 am to 8 pm on the business's clock, a column a day. Meetings are sky-soft blocks
 * with the 3px rule; the now line shows on today only. A meeting outside those hours is pinned to the
 * grid's edge with its real time on it, so nothing is hidden.
 */
export function WeekGrid({
  meetings,
  week,
  tz,
  now,
  today,
  openId,
  onOpen,
}: {
  meetings: Meeting[];
  week: string[];
  tz: string;
  now: Date;
  today: string;
  openId: string | null;
  onOpen: (id: string) => void;
}) {
  const blocks = useMemo(() => weekBlocks(meetings, week, tz), [meetings, week, tz]);
  const todayCol = week.indexOf(today);
  const nowTop =
    todayCol >= 0 ? (now.getTime() - dayStart(today, tz).getTime()) / 60_000 - WEEK_FROM_HOUR * 60 : null;
  return (
    <div className={s.week}>
      <div className={s.wh} aria-hidden>
        <span />
        {week.map((k) => {
          const d = dayStart(k, tz);
          return (
            <span key={k} data-today={k === today || undefined}>
              {fmtWeekday(tz).format(d)}
              <b>{fmtDay(tz).format(d)}</b>
            </span>
          );
        })}
      </div>
      <div className={s.wgrid} style={{ height: HOURS * 60 * PX }}>
        <div className={s.hours} aria-hidden>
          {Array.from({ length: HOURS }, (_, i) => (
            <span key={i} style={{ top: i * 60 * PX }}>
              {timeOf(new Date(Date.UTC(2026, 0, 1, WEEK_FROM_HOUR + i)), "UTC")}
            </span>
          ))}
        </div>
        {week.map((k, col) => (
          <div
            key={k}
            role="group"
            aria-label={fmtLongWeekday(tz).format(dayStart(k, tz))}
            className={s.wcol}
            data-weekend={[0, 6].includes(new Date(`${k}T12:00:00Z`).getUTCDay()) || undefined}
          >
            {blocks
              .filter((b) => b.day === col)
              .map((b) => {
                const m = b.meeting;
                const state = meetingState(m, now);
                const start = timeOf(new Date(m.startsAt), tz);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={s.blk}
                    data-state={state}
                    data-open={m.id === openId || undefined}
                    data-clipped={b.clipped ?? undefined}
                    style={{ top: b.top * PX, height: Math.max(b.height * PX - 2, 22) }}
                    aria-label={`${m.title}, ${start}, ${m.lead?.name ?? "not with a lead yet"}`}
                    onClick={() => onOpen(m.id)}
                  >
                    <b>{m.title}</b>
                    <span>
                      {b.clipped === "after" ? `${start} ↓` : b.clipped === "before" ? `${start} ↑` : start}
                      {m.lead ? ` · ${m.lead.name}` : ""}
                    </span>
                  </button>
                );
              })}
            {col === todayCol && nowTop !== null && nowTop >= 0 && nowTop <= HOURS * 60 && (
              <i className={s.wnow} style={{ top: nowTop * PX }} aria-hidden />
            )}
          </div>
        ))}
        {blocks.length === 0 && <p className={s.wempty}>No meetings with leads this week</p>}
      </div>
    </div>
  );
}
