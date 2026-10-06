"use client";
import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { SendSheet } from "@/components/messages/SendSheet";
import { SNOOZE } from "@/components/tasks/NextFollowUp";
import { avatarColor, initials } from "@/components/ui/Avatar";
import { Popover } from "@/components/ui/Popover";
import { dayKey, timeOf } from "@/lib/dates";
import type { SnoozePreset, TaskView, TodayMeeting, TodayView } from "@/lib/tasks/types";
import s from "./today.module.css";
import { roving } from "@/lib/roving";

const MIN = 60_000;
const SHOWN = 7;
type Tab = "all" | "over" | "calls";
type Item =
  | { kind: "fu"; t: TaskView; at: number; state: "over" | "soon" | "later" }
  | { kind: "call"; m: TodayMeeting; at: number; owed: boolean };

/** A follow-up's time, short: "Since Sat", "Yesterday", "Was 11 am", "In 20 min", "2:30 pm". */
function whenShort(t: TaskView, now: Date, tz: string): string {
  const due = new Date(t.dueAt);
  const days = Math.round((Date.parse(dayKey(now, tz)) - Date.parse(dayKey(due, tz))) / 86_400_000);
  if (days === 1) return "Yesterday";
  if (days > 1)
    return `Since ${new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: days < 7 ? "short" : undefined, month: days < 7 ? undefined : "short", day: days < 7 ? undefined : "numeric" }).format(due)}`;
  const mins = Math.round((due.getTime() - now.getTime()) / MIN);
  if (mins < 0) return `Was ${timeOf(due, tz)}`;
  if (mins < 60) return `In ${Math.max(1, mins)} min`;
  return timeOf(due, tz);
}

/**
 * Up next (spec: Up next): what to do, in order — overdue oldest first and calls still owed an outcome, then the rest
 * of today by time, calls among them. Each follow-up is a tick away from done (with WhatsApp and snooze beside it);
 * each call has Join or Log outcome. All clear when the day is done.
 */
export function WorkTile({
  v,
  now,
  tz,
  canMessage,
  ticking,
  onDone,
  onSent,
  onSnooze,
  onLogOutcome,
  clear,
  empty,
}: {
  v: TodayView;
  now: Date;
  tz: string;
  canMessage: boolean;
  ticking: Set<string>;
  onDone: (t: TaskView) => void;
  onSent: (t: TaskView) => void;
  onSnooze: (t: TaskView, preset: SnoozePreset) => void;
  onLogOutcome: (m: TodayMeeting) => void;
  /** Everything due today is done: the celebration takes the list's place. */
  clear: boolean;
  /** Nothing at all is due today; with `firstDay`, the business has no leads yet. */
  empty: null | "quiet" | "firstDay";
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [all, setAll] = useState(false);
  const soonEnd = now.getTime() + 2 * 3_600_000;
  const items: Item[] = [
    ...[...v.overdue, ...v.soon, ...v.later].map((t) => {
      const at = Date.parse(t.dueAt);
      return {
        kind: "fu" as const,
        t,
        at,
        state: at < now.getTime() ? ("over" as const) : at < soonEnd ? ("soon" as const) : ("later" as const),
      };
    }),
    ...(v.meetings ?? [])
      .filter((m) => m.status === "scheduled")
      .map((m) => {
        const owed = Date.parse(m.endsAt) <= now.getTime();
        // A call owed its outcome sorts with what's overdue; one to come, at its time.
        return { kind: "call" as const, m, at: owed ? Date.parse(m.endsAt) : Date.parse(m.startsAt), owed };
      }),
  ].sort((a, b) => a.at - b.at);
  const overdue = items.filter((x) => (x.kind === "fu" ? x.state === "over" : x.owed));
  const calls = items.filter((x) => x.kind === "call");
  const list = tab === "all" ? items : tab === "over" ? overdue : calls;
  const shown = all ? list : list.slice(0, SHOWN);
  const C = 2 * Math.PI * 12;
  const part = v.total ? Math.min(1, v.done / v.total) : 0;

  return (
    <section
      className={`${s.tl} ${s.workArea}`}
      style={{ "--i": 1 } as CSSProperties}
      aria-labelledby="up-next"
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
          <path d="m3 7 2 2 4-4M3 17l2 2 4-4M13 6h8M13 12h8M13 18h8" />
        </svg>
        <h2 id="up-next" style={{ font: "inherit", margin: 0 }}>
          Up next
        </h2>
        {!clear && !empty && (
          <div className={s.tabs} role="tablist" aria-label="Show" onKeyDown={(e) => roving(e, "tab")}>
            {(
              [
                ["all", "All", items.length],
                ["over", "Overdue", overdue.length],
                ["calls", "Calls", calls.length],
              ] as const
            ).map(([id, label, n]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => setTab(id)}
              >
                {label}
                <em>{n}</em>
              </button>
            ))}
          </div>
        )}
        {v.total > 0 && (
          <>
            <span className={s.r} data-live-count>
              {v.done} of {v.total} done
            </span>
            <svg
              className={s.ring}
              viewBox="0 0 30 30"
              role="img"
              aria-label={`${v.done} of ${v.total} follow-ups due today done`}
            >
              <circle className={s.tr} cx="15" cy="15" r="12" />
              <circle
                className={s.fg}
                cx="15"
                cy="15"
                r="12"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - part)}
              />
            </svg>
          </>
        )}
      </div>

      {clear ? (
        <div className={s.clear}>
          <div className={s.bloom} aria-hidden>
            <img src="/lume-mark.png" alt="" />
            {Array.from({ length: 12 }, (_, i) => {
              const a = (i / 12) * Math.PI * 2;
              const d = 74 + (i % 3) * 16;
              return (
                <i
                  key={i}
                  className={s.petal}
                  style={
                    {
                      background: ["var(--accent)", "var(--sky)", "var(--ok)", "#5fe0a8"][i % 4],
                      "--dx": `${Math.round(Math.cos(a) * d)}px`,
                      "--dy": `${Math.round(Math.sin(a) * d)}px`,
                      "--d": `${0.9 + (i % 4) * 0.05}s`,
                    } as CSSProperties
                  }
                />
              );
            })}
          </div>
          <div>
            <h3 className={s.clearTitle}>All clear</h3>
            <p className={s.clearSub}>
              Every follow-up due today is done. LUME will bring the next ones back when they&apos;re due.
            </p>
          </div>
        </div>
      ) : empty === "firstDay" ? (
        <ul className={s.rows} aria-label="Get LUME ready">
          {[
            ["Bring in your leads", "A spreadsheet or another CRM's export", "/settings/imports", "Import"],
            [
              "Connect a source",
              "A Google Sheet or your website's form, as leads arrive",
              "/settings/integrations",
              "Connect",
            ],
            ["Invite your team", "LUME shares new leads out between them", "/settings/people", "Invite"],
            ["Set this month's goal", "The lit tile measures against it", "/settings/goals", "Set"],
          ].map(([b, sub, href, act]) => (
            <li key={b} className={s.row} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
              <span className={s.who}>
                <b>{b}</b>
                <span>{sub}</span>
              </span>
              <Link className={s.go} href={href!}>
                {act}
              </Link>
            </li>
          ))}
        </ul>
      ) : empty === "quiet" ? (
        <p className={s.quiet}>
          Nothing is due today. When a follow-up falls due, it&apos;s here, with its lead one click away.
        </p>
      ) : (
        <>
          <ul
            className={s.rows}
            aria-label={tab === "all" ? "Up next" : tab === "over" ? "Overdue" : "Calls"}
          >
            {shown.map((x, i) =>
              x.kind === "fu" ? (
                <li
                  key={x.t.id}
                  className={s.row}
                  style={{ "--i": i, opacity: ticking.has(x.t.id) ? 0.4 : 1 } as CSSProperties}
                >
                  <button
                    type="button"
                    className={s.tick}
                    aria-label={`Done: ${x.t.title} — ${x.t.leadName}`}
                    disabled={ticking.has(x.t.id)}
                    onClick={() => onDone(x.t)}
                  >
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
                  </button>
                  <span className={s.av} style={{ background: avatarColor(x.t.leadName) }} aria-hidden>
                    {initials(x.t.leadName)}
                  </span>
                  <Link href={`/leads?lead=${x.t.leadId}`} className={s.who}>
                    <b>{x.t.leadName}</b>
                    <span>{x.t.title}</span>
                  </Link>
                  <span className={s.acts}>
                    {canMessage && (
                      <SendSheet
                        compact
                        align="end"
                        lead={{ id: x.t.leadId, name: x.t.leadName }}
                        taskId={x.t.id}
                        suggest="follow_up"
                        onSettled={(yes) => yes && onSent(x.t)}
                      />
                    )}
                    <Popover
                      label={`Snooze ${x.t.title} — ${x.t.leadName}`}
                      trigger="Snooze"
                      triggerLabel={`Snooze ${x.t.title} — ${x.t.leadName}`}
                      triggerClassName={s.act}
                      role="menu"
                      align="end"
                    >
                      {(close) => (
                        <div className={s.menu}>
                          {SNOOZE.map((o) => (
                            <button
                              key={o.preset}
                              type="button"
                              role="menuitem"
                              className={s.menuItem}
                              onClick={() => {
                                close();
                                onSnooze(x.t, o.preset);
                              }}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </Popover>
                  </span>
                  <span className={s.wh} data-state={x.state} data-volatile>
                    {whenShort(x.t, now, tz)}
                  </span>
                </li>
              ) : (
                <li key={x.m.id} className={s.row} style={{ "--i": i } as CSSProperties}>
                  <span className={s.callIc} aria-hidden>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11" />
                      <rect x="2" y="6" width="14" height="12" rx="2" />
                    </svg>
                  </span>
                  <span
                    className={s.av}
                    style={{ background: avatarColor(x.m.lead?.name ?? x.m.title) }}
                    aria-hidden
                  >
                    {initials(x.m.lead?.name ?? x.m.title)}
                  </span>
                  <Link
                    href={x.m.lead ? `/leads?lead=${x.m.lead.id}` : `/calendar?m=${x.m.id}`}
                    className={s.who}
                  >
                    <b>{x.m.lead?.name ?? x.m.title}</b>
                    <span>{x.m.lead ? x.m.title : "Not with a lead yet"}</span>
                  </Link>
                  <span className={s.acts} data-keep={x.owed || undefined}>
                    {x.owed ? (
                      <button type="button" className={s.outcome} onClick={() => onLogOutcome(x.m)}>
                        Log outcome
                      </button>
                    ) : x.m.link ? (
                      <a className={s.go} href={x.m.link} target="_blank" rel="noopener noreferrer">
                        Join
                      </a>
                    ) : null}
                  </span>
                  <span className={s.wh} data-state={x.owed ? "over" : "call"} data-volatile>
                    {x.owed
                      ? `Ended ${timeOf(new Date(x.m.endsAt), tz)}`
                      : timeOf(new Date(x.m.startsAt), tz)}
                  </span>
                </li>
              ),
            )}
          </ul>
          {!list.length && (
            <p className={s.quiet}>{tab === "over" ? "Nothing is overdue." : "No calls left today."}</p>
          )}
          {list.length > SHOWN && (
            <button type="button" className={s.more} onClick={() => setAll((x) => !x)} aria-expanded={all}>
              {all ? "Show fewer" : `Show all ${list.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
