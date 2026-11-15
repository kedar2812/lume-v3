"use client";
import Link from "next/link";
import type { HTMLAttributes, Ref } from "react";
import b from "@/components/ui/Button.module.css";
import { timeOf } from "@/lib/dates";
import { openOf, panelOf, type DayItem } from "@/lib/today/day-items";
import s from "./day.module.css";

type Box = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> };

/**
 * The details of one thing on the day (spec: Your day, "One panel, everywhere"): its own words first, then who and
 * when, where it stands, and what can be done. The card and the full screen both show exactly this.
 */
export function ItemPanel({ item, now, tz, ...box }: { item: DayItem; now: Date; tz: string } & Box) {
  const p = panelOf(item, now, tz);
  return (
    <div {...box} className={[s.panel, box.className].filter(Boolean).join(" ")} data-day-panel>
      <p className={s.heading}>{p.heading}</p>
      <p className={s.meta}>
        {p.who && <span className={s.who}>{p.who}</span>}
        <time dateTime={item.at}>{p.time}</time>
        {p.state && (
          <span className={s.state} data-tone={p.state.tone}>
            {p.state.label}
          </span>
        )}
      </p>
      {p.actions.length > 0 && (
        <div className={s.actions}>
          {p.actions.includes("join") && item.link && (
            <a
              className={`${b.btn} ${b.sm} ${b.primary}`}
              data-variant="primary"
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className={b.label}>Join</span>
            </a>
          )}
          {p.actions.includes("open") && item.lead && (
            <Link
              className={`${b.btn} ${b.sm}`}
              data-variant="secondary"
              href={`/leads?lead=${item.lead.id}`}
            >
              <span className={b.label}>Open lead</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

const TONE: Record<DayItem["state"], string> = {
  over: "danger",
  soon: "warn",
  later: "accent",
  planned: "quiet",
  done: "ok",
};

/** Several things at about the same time: how many and when, then one row each that opens it. */
export function GroupPanel({ items, now, tz, ...box }: { items: DayItem[]; now: Date; tz: string } & Box) {
  const first = items[0];
  if (!first) return null;
  return (
    <div {...box} className={[s.panel, s.group, box.className].filter(Boolean).join(" ")} data-day-panel>
      <p className={s.groupHead}>
        {items.length} follow-ups around {timeOf(new Date(first.at), tz)}
      </p>
      {items.map((i) => {
        const go = openOf(i, now);
        return (
          <Link key={i.id} className={s.row} href={go.href}>
            <i className={s.dot} data-tone={TONE[i.state]} aria-hidden />
            <span className={s.rowText}>
              <b>{i.title}</b> · {i.lead?.name}
            </span>
            <time dateTime={i.at}>{timeOf(new Date(i.at), tz)}</time>
          </Link>
        );
      })}
    </div>
  );
}
