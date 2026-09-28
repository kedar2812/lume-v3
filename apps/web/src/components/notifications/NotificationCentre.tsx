"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useSound } from "@/components/feedback/SoundProvider";
import { SNOOZE } from "@/components/tasks/NextFollowUp";
import { Popover } from "@/components/ui/Popover";
import { SPRINGS, toMotion } from "@/lib/motion";
import { notificationsClient, type NotificationView } from "@/lib/notifications/client";
import { useStream } from "@/lib/notifications/stream";
import { tasksClient } from "@/lib/tasks/client";
import { timezoneOf, whenInWords } from "@/lib/tasks/format";
import type { TaskView, TodayView } from "@/lib/tasks/types";
import s from "./centre.module.css";

type Filter = "all" | "needs" | "updates";
type GroupId = "overdue" | "now" | "later" | "updates";
const GROUPS: { id: GroupId; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "now", label: "Due now" },
  { id: "later", label: "Later today" },
  { id: "updates", label: "Updates" },
];
/** Updates that are really asks (they sit under Needs you too). */
const ASKS = new Set(["task_escalated", "follow_up_nudge", "follow_up_assigned"]);
/** Due and soon reminders are the follow-ups themselves (shown from Today's list, not twice). */
const REMINDERS = new Set(["follow_up_due", "follow_up_soon"]);
const READ_AFTER_MS = 600;

type Entry =
  | { key: string; type: "task"; group: GroupId; task: TaskView; unread: number[] }
  | { key: string; type: "note"; group: "updates"; n: NotificationView };

/**
 * The notification centre (3B Task 5; frontend spec §8.5): a glass panel anchored to the bell, holding
 * everything that needs you — Overdue, Due now, Later today — and the Updates, each with its action inline.
 * No scrim: the page behind stays usable. `.` toggles it (in TopBar); J/K move, E done, S snooze, Enter
 * opens the lead, F full screen, Esc steps back out.
 */
export function NotificationCentre({
  open,
  onClose,
  tz: userTz,
}: {
  open: boolean;
  onClose(): void;
  tz?: string | null;
}) {
  const tz = timezoneOf(userTz);
  const reduce = useReducedMotion();
  const router = useRouter();
  const sound = useSound();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [day, setDay] = useState<TodayView | null>(null);
  const [notes, setNotes] = useState<NotificationView[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [full, setFull] = useState(false);
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const reading = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const load = useCallback(async () => {
    const [t, n] = await Promise.all([tasksClient.today(), notificationsClient.list()]);
    if (t.ok) setDay(t.data);
    if (n.ok) setNotes(n.data.items);
    if (!t.ok || !n.ok) setError((!t.ok ? t.message : !n.ok ? n.message : null) ?? null);
  }, []);
  useEffect(() => {
    if (open) void load();
    else setFull(false);
  }, [open, load]);
  useStream(() => {
    if (open) void load();
  });

  // Mark read: after 600 ms under the pointer or with focus (never on a mere pass-by).
  const markSoon = (ids: number[]) => {
    for (const id of ids) {
      if (reading.current.has(id)) continue;
      reading.current.set(
        id,
        setTimeout(() => {
          reading.current.delete(id);
          setNotes((cur) => cur.map((x) => (x.id === id ? { ...x, read: true } : x)));
          void notificationsClient.read([id]);
        }, READ_AFTER_MS),
      );
    }
  };
  const cancelRead = (ids: number[]) => {
    for (const id of ids) {
      clearTimeout(reading.current.get(id));
      reading.current.delete(id);
    }
  };

  const entries: Entry[] = [];
  if (day) {
    const unreadFor = (taskId: string) =>
      notes.filter((n) => !n.read && REMINDERS.has(n.kind) && n.taskId === taskId).map((n) => n.id);
    const add = (group: GroupId, list: TaskView[]) =>
      list.forEach((t) =>
        entries.push({ key: `t-${t.id}`, type: "task", group, task: t, unread: unreadFor(t.id) }),
      );
    add("overdue", day.overdue);
    add("now", day.soon);
    add("later", day.later);
  }
  for (const n of notes)
    if (!REMINDERS.has(n.kind)) entries.push({ key: `n-${n.id}`, type: "note", group: "updates", n });
  const shown = entries.filter((e) =>
    filter === "all"
      ? true
      : filter === "needs"
        ? e.type === "task" || ASKS.has(e.n.kind)
        : e.type === "note",
  );
  const unread = notes.filter((n) => !n.read).length;

  const done = async (t: TaskView) => {
    const r = await tasksClient.done(t.id);
    if (!r.ok) return setError(r.message);
    sound.play(r.data.clearedToday ? "cleared" : "done");
    await load();
  };
  const snooze = async (t: TaskView, preset: (typeof SNOOZE)[number]["preset"]) => {
    const r = await tasksClient.snooze(t.id, { preset });
    if (!r.ok) return setError(r.message);
    await load();
  };
  const remind = async (taskId: string) => {
    const r = await tasksClient.nudge(taskId);
    if (!r.ok) return setError(r.message);
    setReminded((cur) => new Set(cur).add(taskId));
  };
  const leadOf = (e: Entry) => (e.type === "task" ? e.task.leadId : e.n.leadId);

  // The keyboard, while it's open (and nobody is typing in a field).
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKey.current = (e) => {
    const t = e.target as HTMLElement | null;
    if (e.metaKey || e.ctrlKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (full) setFull(false);
      else onClose();
      return;
    }
    const items = [...(panel.current?.querySelectorAll<HTMLElement>("[data-entry]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const current = at >= 0 ? shown.find((x) => x.key === items[at]!.dataset.entry) : undefined;
    const key = e.key.toLowerCase();
    if (key === "j" || key === "k") {
      e.preventDefault();
      const next = items[Math.min(items.length - 1, Math.max(0, at + (key === "j" ? 1 : -1)))] ?? items[0];
      next?.focus();
    } else if (key === "f") {
      e.preventDefault();
      setFull((v) => !v);
    } else if (key === "e" && current?.type === "task" && current.task.canEdit) {
      e.preventDefault();
      void done(current.task);
    } else if (key === "s" && current?.type === "task") {
      e.preventDefault();
      items[at]!.querySelector<HTMLButtonElement>("[data-snooze] button[aria-haspopup]")?.click();
    } else if (e.key === "Enter" && current && leadOf(current)) {
      e.preventDefault();
      router.push(`/leads?lead=${leadOf(current)}`);
    }
  };
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={panel}
          role="dialog"
          aria-labelledby={titleId}
          className={s.panel}
          data-full={full || undefined}
          layout={!reduce}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -8 }}
          transition={toMotion(SPRINGS.default)}
        >
          <header className={s.head}>
            <div className={s.titleRow}>
              <h2 id={titleId} className={s.title}>
                Notifications
              </h2>
              {unread > 0 && <span className={s.count}>{unread} new</span>}
              <button type="button" className={s.linkBtn} onClick={() => void markAll()} disabled={!unread}>
                Mark all read
              </button>
              <button
                type="button"
                className={s.iconBtn}
                aria-label={full ? "Leave full screen (F)" : "Full screen (F)"}
                aria-pressed={full}
                onClick={() => setFull((v) => !v)}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                  <path
                    d={
                      full
                        ? "M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"
                        : "M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"
                    }
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
            <div role="radiogroup" aria-label="Show" className={s.seg}>
              {(
                [
                  ["all", "All"],
                  ["needs", "Needs you"],
                  ["updates", "Updates"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={filter === id}
                  className={s.segBtn}
                  onClick={() => setFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </header>

          <div className={s.scroll}>
            {error && (
              <p role="alert" className={s.error}>
                {error}
              </p>
            )}
            {day && shown.length === 0 && (
              <div className={s.empty}>
                <img src="/lume-mark.png" alt="" width={54} height={54} />
                <p>You&apos;re all caught up</p>
              </div>
            )}
            {GROUPS.map((g) => {
              const list = shown.filter((e) => e.group === g.id);
              if (!list.length) return null;
              return (
                <section key={g.id} className={s.group}>
                  <h3 className={s.groupHead} data-group={g.id}>
                    <i aria-hidden />
                    {g.label}
                    <span className={s.groupCount}>{list.length}</span>
                  </h3>
                  <ul className={s.items} aria-label={g.label}>
                    <AnimatePresence initial={false}>
                      {list.map((e) => (
                        <motion.li
                          key={e.key}
                          layout={!reduce}
                          tabIndex={0}
                          data-entry={e.key}
                          aria-label={label(e, tz)}
                          className={s.item}
                          data-read={(e.type === "task" ? e.unread.length === 0 : e.n.read) || undefined}
                          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                          transition={toMotion(SPRINGS.default)}
                          onPointerEnter={() => markSoon(unreadOf(e))}
                          onPointerLeave={() => cancelRead(unreadOf(e))}
                          onFocus={() => markSoon(unreadOf(e))}
                          onBlur={() => cancelRead(unreadOf(e))}
                        >
                          <span className={s.dot} aria-hidden />
                          <span
                            className={s.tile}
                            data-kind={e.type === "task" ? g.id : e.n.kind}
                            aria-hidden
                          >
                            {icon(e)}
                          </span>
                          <div className={s.body}>
                            <div className={s.line}>
                              <b>{e.type === "task" ? e.task.leadName : e.n.title}</b>
                              <time data-volatile>
                                {e.type === "task"
                                  ? whenInWords(e.task.dueAt, new Date(), tz)
                                  : whenInWords(e.n.createdAt, new Date(), tz).replace(" (overdue)", "")}
                              </time>
                            </div>
                            <p className={s.meta}>
                              {e.type === "task" ? (
                                <>
                                  {e.task.title}
                                  {g.id === "overdue" && <span className={s.hot}> · overdue</span>}
                                  {g.id === "now" && <span className={s.soon}> · due now</span>}
                                </>
                              ) : (
                                (e.n.body ?? "")
                              )}
                            </p>
                            <div className={s.actions}>{actions(e)}</div>
                          </div>
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ul>
                </section>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  async function markAll() {
    const r = await notificationsClient.readAll();
    if (r.ok) setNotes((cur) => cur.map((n) => ({ ...n, read: true })));
  }
  function unreadOf(e: Entry): number[] {
    return e.type === "task" ? e.unread : e.n.read ? [] : [e.n.id];
  }
  function actions(e: Entry): ReactNode {
    if (e.type === "task")
      return (
        <>
          {e.task.canEdit && (
            <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => void done(e.task)}>
              Done
            </button>
          )}
          {e.task.canEdit && (
            <span data-snooze>
              <Popover
                label={`Snooze ${e.task.title} — ${e.task.leadName}`}
                trigger="Snooze"
                triggerClassName={s.btn}
                role="menu"
                align="start"
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
                          void snooze(e.task, o.preset);
                        }}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                )}
              </Popover>
            </span>
          )}
          <button
            type="button"
            className={`${s.btn} ${s.ghost}`}
            onClick={() => router.push(`/leads?lead=${e.task.leadId}`)}
          >
            Open
          </button>
        </>
      );
    const n = e.n;
    return (
      <>
        {n.leadId && (
          <button type="button" className={s.btn} onClick={() => router.push(`/leads?lead=${n.leadId}`)}>
            Open lead
          </button>
        )}
        {n.kind === "task_escalated" &&
          n.taskId &&
          (reminded.has(n.taskId) ? (
            <span className={s.sent}>Reminded</span>
          ) : (
            <button type="button" className={`${s.btn} ${s.primary}`} onClick={() => void remind(n.taskId!)}>
              Remind them
            </button>
          ))}
      </>
    );
  }
}

/** An item's accessible name: whom it's about and when, read the same way it looks. */
function label(e: Entry, tz: string): string {
  if (e.type === "task")
    return `${e.task.leadName}: ${e.task.title}, ${whenInWords(e.task.dueAt, new Date(), tz)}`;
  return e.n.title;
}

function icon(e: Entry): ReactNode {
  const path =
    e.type === "task"
      ? "M8 3.5v4.5l3 2M14.5 8a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" // a clock: a follow-up
      : e.n.kind === "task_escalated"
        ? "M8 2 14.5 13.5h-13L8 2Zm0 4.5V9m0 2.2v.1" // a warning triangle
        : e.n.kind === "lead_assigned"
          ? "M5.5 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M12 5v5m-2.5-2.5h5" // a person, added
          : "M3 6.5a5 5 0 0 1 10 0c0 4 1.5 5 1.5 5h-13S3 10.5 3 6.5ZM6.5 13.5a1.6 1.6 0 0 0 3 0"; // a bell
  return (
    <svg viewBox="0 0 16 16" width="16" height="16">
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
