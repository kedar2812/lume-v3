"use client";
import { timeOf } from "@/lib/dates";
import s from "./security.module.css";

/** "9:30", the axis's short clock (am/pm is said once, in the chart's name). */
const clock = (iso: string, tz: string) => timeOf(new Date(iso), tz).replace(/ (am|pm)$/, "");

/**
 * The burst, minute by minute (canvas [Main]): blue bars, amber once the count in the window passed the limit,
 * and a dashed marker at the minute it did. The bars draw in, one after another, unless motion is reduced.
 */
export function BurstChart({
  burst,
  threshold,
  timezone,
  label,
}: {
  burst: { at: string; n: number }[];
  threshold: number;
  timezone: string;
  label: string;
}) {
  let running = 0;
  const bars = burst.map((b) => {
    running += b.n;
    return { ...b, over: running > threshold };
  });
  const crossing = bars.findIndex((b) => b.over);
  const max = Math.max(1, ...bars.map((b) => b.n));
  const total = running;
  const ticks =
    bars.length > 1
      ? [0, Math.round((bars.length - 1) / 3), Math.round((2 * (bars.length - 1)) / 3), bars.length - 1]
      : [0];
  const name =
    `${label}: ${total} in ${bars.length} ${bars.length === 1 ? "minute" : "minutes"}` +
    (crossing >= 0 ? `, past the limit at ${timeOf(new Date(bars[crossing]!.at), timezone)}` : "");
  return (
    <figure className={s.chart}>
      <figcaption className={s.chartHead}>
        <b>{label}</b>
        {bars.length > 0 && (
          <span>
            {timeOf(new Date(bars[0]!.at), timezone)} – {timeOf(new Date(bars.at(-1)!.at), timezone)}
          </span>
        )}
      </figcaption>
      <div
        className={s.bars}
        role="img"
        aria-label={name}
        style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}
      >
        {crossing >= 0 && (
          <span
            className={s.limit}
            style={{ left: `${(crossing / bars.length) * 100}%` }}
            data-side={crossing / bars.length > 0.6 ? "left" : "right"}
            aria-hidden
          >
            <span>Limit reached</span>
          </span>
        )}
        {bars.map((b, j) => (
          <i
            key={b.at}
            data-testid="burst-bar"
            data-over={b.over || undefined}
            data-crossing={j === crossing || undefined}
            data-empty={b.n === 0 || undefined}
            className={b.over ? s.barOver : s.bar}
            style={{
              height: b.n === 0 ? undefined : `${Math.max(4, (b.n / max) * 100)}%`,
              ["--j" as string]: j,
            }}
          />
        ))}
      </div>
      <div className={s.axis} aria-hidden>
        {ticks.map((t) => (
          <span key={t}>{clock(bars[t]!.at, timezone)}</span>
        ))}
      </div>
    </figure>
  );
}
