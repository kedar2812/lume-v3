"use client";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { BodyPortal } from "@/components/ui/BodyPortal";
import { timeOf } from "@/lib/dates";
import { KINDS, daySpan, minuteOf, openOf, panelOf, type DayItem, type DayKind } from "@/lib/today/day-items";
import { clampPph, packRows, tickStep, zoomScroll } from "@/lib/today/timeline-math";
import type { Show } from "./DayList";
import { GroupPanel, ItemPanel } from "./ItemPanel";
import s from "./day.module.css";
import { usePanZoom } from "./usePanZoom";
import { fixedPlace, panelHeight, useItemFocus } from "./useItemFocus";

/** Room either side of the day, in px. */
export const PAD = 40;
/** One line of a row, in px (a chip and the gap under it). */
export const ROW = 38;
/** Room above a row's first line for its label, so the label never covers a chip. */
const TOP = 30;
const BOTTOM = 10;

const TONE: Record<DayItem["state"], string> = {
  over: "danger",
  soon: "warn",
  later: "accent",
  planned: "quiet",
  done: "ok",
};

/** A ruler label: "9 am" on the hour, "9:30" between. */
function tickLabel(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const h12 = ((h + 11) % 12) + 1;
  return m ? `${h12}:${String(m).padStart(2, "0")}` : `${h12} ${h >= 12 ? "pm" : "am"}`;
}
const short = (iso: string, tz: string) => timeOf(new Date(iso), tz).replace(/ (am|pm)$/, "");

/**
 * The day laid out in time (spec: Your day full screen, Timeline): one row per kind, things that would touch stacked
 * onto the next line, a ruler that stays at the top, now on today. Drag to move it, Ctrl + scroll or pinch to zoom;
 * hover brings one thing forward with the same panel as the card.
 */
export function DayTimeline({
  items,
  show,
  now,
  tz,
  isToday,
  pph,
  onPph,
  onFit,
}: {
  items: DayItem[];
  show: Show;
  now: Date;
  tz: string;
  isToday: boolean;
  /** Px per hour; 0 is Fit day. */
  pph: number;
  onPph: (pph: number) => void;
  /** Fit day's px per hour, whenever the window's width changes it. */
  onFit?: (fit: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const f = useItemFocus();

  const placed = useMemo(() => items.filter((i) => !i.before), [items]);
  const before = useMemo(() => (isToday ? items.filter((i) => i.before) : []), [items, isToday]);
  const { from, to } = daySpan(placed, tz);
  const hours = (to - from) / 60;
  const fit = Math.max(1, (Math.max(width, 2 * PAD + 1) - 2 * PAD) / hours);
  const eff = clampPph(pph || fit, fit);
  // Each thing's minute of the day, worked out once per set of things (not on every hover or zoom step).
  const minutes = useMemo(() => new Map(items.map((i) => [i.at, minuteOf(i.at, tz)])), [items, tz]);
  const xOf = useCallback(
    (iso: string) => PAD + (((minutes.get(iso) ?? minuteOf(iso, tz)) - from) / 60) * eff,
    [minutes, tz, from, eff],
  );

  const kinds = KINDS.filter((k) => show === "all" || show === k.kind);
  const lanes = kinds.map(({ kind, label }) => {
    const own = placed.filter((i) => i.kind === kind);
    const spans: { key: string; x: number; item: DayItem | null }[] = [
      ...(kind === "follow_up" && before.length ? [{ key: "pile", x: PAD, item: null }] : []),
      ...own.map((i) => ({ key: `i:${i.id}`, x: xOf(i.at), item: i })),
    ];
    const rows = packRows(spans.map((sp) => ({ x: sp.x, w: widths[sp.key] ?? 0 })));
    return {
      kind,
      label,
      spans: spans.map((sp, n) => ({ ...sp, row: rows[n]! })),
      lines: Math.max(1, ...rows.map((r) => r + 1)),
    };
  });
  const right = Math.max(0, ...lanes.flatMap((l) => l.spans.map((sp) => sp.x + (widths[sp.key] ?? 0))));
  const canvasW = Math.max(width, 2 * PAD + hours * eff, right + PAD);
  const maxLeft = () => Math.max(0, canvasW - (scroller.current?.clientWidth ?? width));

  // Fit day follows the window's width.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (width) onFit?.(fit);
  }, [width, fit, onFit]);

  // Each chip's own width, measured once per set of things (it doesn't change with the zoom).
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    canvas.current?.querySelectorAll<HTMLElement>("[data-chip]").forEach((el) => {
      next[el.dataset.key!] = el.offsetWidth;
    });
    setWidths((w) =>
      Object.keys(next).length === Object.keys(w).length && Object.keys(next).every((k) => w[k] === next[k])
        ? w
        : next,
    );
  }, [items, show]);

  // Zooming keeps the time under the pointer (or the middle) where it was.
  const anchor = useRef<number | null>(null);
  const shown = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const was = shown.current;
    shown.current = width ? eff : null;
    if (!el || was == null || was === eff) return;
    el.scrollLeft = zoomScroll({
      scrollLeft: el.scrollLeft,
      anchorX: anchor.current ?? el.clientWidth / 2,
      pad: PAD,
      pph: was,
      next: eff,
    });
    anchor.current = null;
  }, [eff, width]);

  // Where it opens: now a third of the way in on today; another day at its first thing (9 am when empty).
  const opened = useRef(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !width || opened.current) return;
    opened.current = true;
    const first = placed[0];
    el.scrollLeft = Math.max(
      0,
      isToday
        ? PAD + ((minuteOf(now, tz) - from) / 60) * eff - el.clientWidth / 3
        : (first ? xOf(first.at) : PAD + ((9 * 60 - from) / 60) * eff) - PAD,
    );
  });

  // Several zoom steps can land before React draws the last one: each builds on the one before.
  const latest = useRef(eff);
  latest.current = eff;
  const pz = usePanZoom(scroller, canvas, {
    maxLeft,
    zoom: (factor, anchorX) => {
      anchor.current = anchorX;
      latest.current = clampPph(latest.current * factor, fit);
      onPph(latest.current);
    },
    // A drag moves things out from under their panel: it closes.
    onDragStart: f.close,
  });

  const step = tickStep(eff);
  const ticks: number[] = [];
  for (let m = from; m <= to; m += step) ticks.push(m);
  const nowMin = minuteOf(now, tz);
  const showNow = isToday && nowMin >= from && nowMin <= to;
  const focusedKey = f.focused?.key;
  // A thing that vanishes in a live update takes its panel with it.
  const gone = !!focusedKey && focusedKey !== "pile" && !placed.some((i) => `i:${i.id}` === focusedKey);
  const pileGone = focusedKey === "pile" && !before.length;
  useEffect(() => {
    if (gone || pileGone) f.close();
  }, [gone, pileGone, f.close]);
  const focusedItem = focusedKey?.startsWith("i:")
    ? placed.find((i) => `i:${i.id}` === focusedKey)
    : undefined;

  return (
    <div
      ref={scroller}
      className={[s.scroller, f.focused && s.focusing].filter(Boolean).join(" ")}
      data-day-scroller
      data-dragging={pz.dragging || undefined}
      {...pz.handlers}
    >
      <div ref={canvas} className={s.canvas} style={{ width: canvasW }} data-day-canvas>
        <div className={s.ruler} data-day-back>
          {ticks.map((m) => (
            <span key={m} className={s.tick} style={{ left: PAD + ((m - from) / 60) * eff }} data-tick>
              {tickLabel(m)}
            </span>
          ))}
        </div>
        <div className={s.grid} aria-hidden data-day-back>
          {ticks.map((m) => (
            <i key={m} style={{ left: PAD + ((m - from) / 60) * eff }} data-half={m % 60 ? "" : undefined} />
          ))}
        </div>
        {lanes.map((lane) => (
          <section
            key={lane.kind}
            role="region"
            aria-label={lane.label}
            className={s.lane}
            style={{ height: TOP + lane.lines * ROW + BOTTOM }}
          >
            <span className={s.laneLabel} data-day-back>
              {lane.label}
            </span>
            {lane.spans.map((sp) => {
              const style: CSSProperties = { left: sp.x, top: TOP + sp.row * ROW };
              const on = focusedKey === sp.key || undefined;
              if (!sp.item)
                return (
                  <button
                    key={sp.key}
                    type="button"
                    className={`${s.chip} ${s.pile}`}
                    style={style}
                    data-chip
                    data-key={sp.key}
                    data-day-item
                    data-on={on}
                    aria-expanded={!!on}
                    draggable={false}
                    {...f.bind(sp.key)}
                    onClick={(e) => {
                      f.bind(sp.key).onClick(e);
                      f.open(sp.key, e.currentTarget, { focusPanel: true });
                    }}
                  >
                    {before.length} from before
                  </button>
                );
              return (
                <Chip
                  key={sp.key}
                  item={sp.item}
                  k={sp.key}
                  style={style}
                  on={on}
                  tz={tz}
                  now={now}
                  bind={f.bind(sp.key)}
                />
              );
            })}
          </section>
        ))}
        {showNow && (
          <div
            className={s.nowLine}
            style={{ left: PAD + ((nowMin - from) / 60) * eff }}
            aria-hidden
            data-now
            data-day-back
          >
            <b>{short(now.toISOString(), tz)}</b>
          </div>
        )}
      </div>
      {f.focused && (
        <BodyPortal>
          {focusedItem ? (
            <ItemPanel
              item={focusedItem}
              now={now}
              tz={tz}
              style={fixedPlace(f.focused.el, { side: "beside", height: panelHeight() })}
              {...f.panelBind}
            />
          ) : focusedKey === "pile" ? (
            <GroupPanel
              items={before}
              now={now}
              tz={tz}
              heading={`${before.length} from before`}
              style={fixedPlace(f.focused.el, { side: "beside", height: panelHeight(before.length) })}
              {...f.panelBind}
            />
          ) : null}
        </BodyPortal>
      )}
    </div>
  );
}

function Chip({
  item,
  k,
  style,
  on,
  tz,
  now,
  bind,
}: {
  item: DayItem;
  k: string;
  style: CSSProperties;
  on: true | undefined;
  tz: string;
  now: Date;
  bind: ReturnType<ReturnType<typeof useItemFocus>["bind"]>;
}) {
  const p = panelOf(item, now, tz);
  const go = openOf(item, now);
  const common = {
    className: s.chip,
    // The timeline is dragged, not its links: a link drag would cancel the pan.
    draggable: false,
    style,
    "data-chip": "",
    "data-key": k,
    "data-day-item": "",
    "data-kind": item.kind as DayKind,
    "data-state": item.state,
    "data-on": on,
    "aria-label": [p.heading, p.who, p.time, p.state?.label].filter(Boolean).join(", "),
    ...bind,
  };
  const inside =
    item.kind === "call" ? (
      <>
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {item.state === "done" ? (
            <path d="M5 12.5 10 17.5 19 7" />
          ) : (
            <>
              <path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11" />
              <rect x="2" y="6" width="14" height="12" rx="2" />
            </>
          )}
        </svg>
        <time dateTime={item.at}>{short(item.at, tz)}</time>
        <span>{item.lead ? `${item.lead.name} · ${item.title}` : item.title}</span>
      </>
    ) : (
      <>
        <i className={s.dot} data-tone={TONE[item.state]} aria-hidden />
        <time dateTime={item.at}>{short(item.at, tz)}</time>
        <span>{item.title}</span>
        {item.lead && <span className={s.chipWho}>· {item.lead.name}</span>}
      </>
    );
  return go.external ? (
    <a {...common} href={go.href} target="_blank" rel="noopener noreferrer">
      {inside}
    </a>
  ) : (
    <Link {...common} href={go.href}>
      {inside}
    </Link>
  );
}
