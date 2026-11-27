"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import Link from "next/link";
import b from "@/components/ui/Button.module.css";
import { timeOf } from "@/lib/dates";
import { listGroups, openOf, panelOf, type DayItem, type DayKind } from "@/lib/today/day-items";
import s from "./day.module.css";

export type Show = "all" | DayKind;
export type DayMode = "today" | "past" | "future";

const TONE: Record<DayItem["state"], string> = {
  over: "danger",
  soon: "warn",
  later: "accent",
  planned: "quiet",
  done: "ok",
};

/** A day with nothing on it (in the chosen Show), and how to add something where that makes sense. */
export function DayEmpty({ mode, show = "all" }: { mode: DayMode; show?: Show }) {
  // With Show on one kind, say which kind there is none of: "nothing planned" would be wrong on a busy day.
  const head =
    show === "call"
      ? "No calls on this day"
      : show === "follow_up"
        ? "No follow-ups on this day"
        : "Nothing planned for this day";
  return (
    <div className={s.empty}>
      <p className={s.emptyHead}>{head}</p>
      {mode !== "past" && show !== "call" && <p className={s.emptySub}>Add a follow-up from any lead</p>}
    </div>
  );
}

/**
 * The day as a list (spec: Your day full screen, List): grouped by where things stand, in time order. Each row opens
 * its lead (a call without one opens in Calendar); an upcoming call with a link also has Join.
 */
export function DayList({
  items,
  mode,
  show,
  now,
  tz,
}: {
  items: DayItem[];
  mode: DayMode;
  show: Show;
  now: Date;
  tz: string;
}) {
  const shown = show === "all" ? items : items.filter((i) => i.kind === show);
  const groups = listGroups(shown, mode);
  if (!groups.length) return <DayEmpty mode={mode} show={show} />;
  return (
    <div className={s.list}>
      {groups.map((g) => (
        <section key={g.name} role="group" aria-label={g.name} className={s.listGroup}>
          <h3 className={s.listHead}>
            {g.name} <span>{g.items.length}</span>
          </h3>
          <ul>
            {g.items.map((i) => {
              const p = panelOf(i, now, tz);
              const href =
                i.kind === "call"
                  ? i.lead
                    ? `/leads?lead=${i.lead.id}`
                    : `/calendar?m=${i.id}`
                  : openOf(i, now).href;
              const name = [p.heading, p.who, p.time, p.state?.label].filter(Boolean).join(", ");
              return (
                <li key={`${i.kind}:${i.id}`} data-id={i.id} className={s.listRow}>
                  <Link href={href} className={s.listLink} aria-label={name}>
                    <time dateTime={i.at} className={s.listTime}>
                      {i.kind === "call" ? timeOf(new Date(i.at), tz) : p.time}
                    </time>
                    <span className={s.listIcon} aria-hidden>
                      {i.kind === "call" ? (
                        <UI_ICONS.video size={ICON_SIZE.md} aria-hidden />
                      ) : (
                        <i className={s.dot} data-tone={TONE[i.state]} />
                      )}
                    </span>
                    <span className={s.listText}>
                      <b>{p.heading}</b>
                      {p.who && <span>{p.who}</span>}
                    </span>
                    <span className={s.state} data-tone={p.state?.tone ?? "quiet"}>
                      {p.state?.label ?? (i.state === "done" ? "Call · ended" : "Call")}
                    </span>
                  </Link>
                  {p.actions.includes("join") && i.link && (
                    <a
                      className={`${b.btn} ${b.sm} ${b.primary} ${s.listJoin}`}
                      data-variant="primary"
                      href={i.link}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <span className={b.label}>Join</span>
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
