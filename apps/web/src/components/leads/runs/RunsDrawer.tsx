"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { can } from "@lume/core/shared";
import { useToast } from "@/components/feedback/ToastProvider";
import { Scrim } from "@/components/ui/Scrim";
import { useModalFocus } from "@/components/ui/useModalFocus";
import { bulkRunsClient, isLive, reasonWords, runLine, took, type RunView } from "@/lib/leads/bulk-runs";
import { longDate } from "@/lib/dates";
import { useLoadingSignal } from "@/lib/loading";
import type { Session } from "@/server/session";
import { useCatalog } from "../CatalogProvider";
import s from "./runs.module.css";
import { roving } from "@/lib/roving";

const fmt = (n: number) => n.toLocaleString("en-US");

/** "Today", "Yesterday", or "October 1, Thursday": the day a run was made, in the owner's month-first words. */
function dayWords(iso: string, tz: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.floor(
    (new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000,
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return longDate(d, tz);
}

/** Hours of undo left, as a ring and a few words ("23 h", "40 min"). */
function undoLeft(r: RunView, now = Date.now()): { frac: number; words: string } | null {
  if (!r.canUndo || !r.undoUntil) return null;
  const ms = Date.parse(r.undoUntil) - now;
  if (ms <= 0) return null;
  const h = ms / 3_600_000;
  return {
    frac: Math.min(1, h / 24),
    words: h >= 1 ? `${Math.floor(h)} h` : `${Math.max(1, Math.round(h * 60))} min`,
  };
}

/**
 * Recent bulk actions (7C, canvas Runs): the last 7 days, newest first, each with what it did, what it skipped
 * and why, and Undo while its 24 hours last. Someone with bulk edits at 'all' can see everyone's.
 */
export function RunsDrawer({
  session,
  onClose,
  onChanged,
}: {
  session: Session;
  onClose: () => void;
  onChanged: () => void;
}) {
  const catalog = useCatalog();
  const { toast } = useToast();
  const everyoneAllowed = can(session.actor, "leads.bulk_edit", "all");
  const [view, setView] = useState<"mine" | "all">("mine");
  const [runs, setRuns] = useState<RunView[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // A run that was going and has now finished changed leads: the list behind refreshes (7C final review, Important 2).
  const wasLive = useRef<Set<string>>(new Set());
  const tellChanged = useRef(onChanged);
  tellChanged.current = onChanged;
  const load = useCallback(async () => {
    const r = await bulkRunsClient.list();
    if (!r.ok) return;
    const nowLive = new Set(r.data.runs.filter(isLive).map((x) => x.id));
    if ([...wasLive.current].some((id) => !nowLive.has(id))) tellChanged.current();
    wasLive.current = nowLive;
    setRuns(r.data.runs);
  }, []);
  useEffect(() => void load(), [load]);
  useLoadingSignal(runs === null);
  // While anything is running, the list reads itself again every two seconds.
  const anyLive = !!runs?.some(isLive);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [anyLive, load]);
  const panel = useRef<HTMLElement>(null);
  const focus = useModalFocus(panel, onClose);

  const people = catalog.people;
  const name = {
    person: (id: string | null) => people.find((p) => p.id === id)?.name ?? "someone",
    stage: (id: string) =>
      catalog.pipelines.flatMap((p) => p.stages).find((x) => x.id === id)?.name ?? "a stage",
    tag: (id: string) => catalog.tags.find((t) => t.id === id)?.label ?? "a tag",
  };
  const shown = (runs ?? []).filter((r) => view === "all" || r.userId === session.user.id);
  const tz = session.user.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = [...new Set(shown.map((r) => dayWords(r.createdAt, tz)))];
  const act = async (r: RunView, what: "undo" | "cancel") => {
    const res = what === "undo" ? await bulkRunsClient.undo(r.id) : await bulkRunsClient.cancel(r.id);
    if (!res.ok)
      return toast({
        tone: "warn",
        title: what === "undo" ? "LUME couldn’t undo that" : "LUME couldn’t stop it",
        detail: res.message,
      });
    await load();
    onChanged();
  };
  const changed = shown.reduce((a, r) => a + (r.action.type === "undo" ? 0 : r.done), 0);
  const undoable = shown.filter((r) => undoLeft(r)).length;

  return (
    <Scrim onClose={onClose}>
      <aside
        ref={panel}
        className={s.drawer}
        role="dialog"
        aria-modal="true"
        aria-label="Recent bulk actions"
        onKeyDown={focus.onKeyDown}
      >
        <header className={s.head}>
          <div style={{ flex: 1 }}>
            <h2>Recent bulk actions</h2>
            <p>The last 7 days. Undo works for 24 hours after each one.</p>
          </div>
          {everyoneAllowed && (
            <span
              className={s.seg}
              role="radiogroup"
              aria-label="Whose"
              onKeyDown={(e) => roving(e, "radio")}
            >
              <span
                className={s.knob}
                style={{ transform: view === "mine" ? "translateX(0)" : "translateX(100%)" }}
              />
              <button
                type="button"
                role="radio"
                aria-checked={view === "mine"}
                tabIndex={view === "mine" ? 0 : -1}
                onClick={() => setView("mine")}
              >
                Mine
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={view === "all"}
                tabIndex={view === "all" ? 0 : -1}
                onClick={() => setView("all")}
              >
                Everyone’s
              </button>
            </span>
          )}
          <button type="button" className={s.close} aria-label="Close" onClick={onClose}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        {runs === null ? (
          <div className={s.list} aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={s.skel} />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className={s.empty}>
            <b>No bulk actions this week</b>
            <span>Select leads on the list to act on many at once.</span>
          </div>
        ) : (
          <>
            <div className={s.stats}>
              <div>
                <b>{shown.length}</b>
                <span>bulk {shown.length === 1 ? "action" : "actions"} this week</span>
              </div>
              <div>
                <b>{fmt(changed)}</b>
                <span>leads changed</span>
              </div>
              <div>
                <b>{undoable}</b>
                <span>can still be undone</span>
              </div>
            </div>
            <div className={s.list}>
              {days.map((day) => (
                <section key={day}>
                  <h3 className={s.day}>{day}</h3>
                  {shown
                    .filter((r) => dayWords(r.createdAt, tz) === day)
                    .map((r) => {
                      const live = isLive(r);
                      const left = undoLeft(r);
                      const exp = open === r.id;
                      const by = r.userId === session.user.id ? "You" : name.person(r.userId);
                      const p = r.total ? (r.done + r.skipped) / r.total : 0;
                      const untouched = Math.max(0, r.total - r.done - r.skipped);
                      return (
                        <article key={r.id} className={s.run} data-open={exp || undefined}>
                          <button
                            type="button"
                            className={s.rh}
                            aria-expanded={exp}
                            onClick={() => setOpen(exp ? null : r.id)}
                          >
                            <span className={s.gl} data-kind={live ? "live" : r.status}>
                              {live ? (
                                <svg viewBox="0 0 40 40" aria-hidden>
                                  <circle className={s.bg} cx="20" cy="20" r="17" />
                                  <circle
                                    className={s.fg}
                                    cx="20"
                                    cy="20"
                                    r="17"
                                    style={{ strokeDashoffset: 107 - 107 * p }}
                                  />
                                </svg>
                              ) : r.status === "undone" || r.action.type === "undo" ? (
                                <svg
                                  width="19"
                                  height="19"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden
                                >
                                  <path d="M9 14 4 9l5-5" />
                                  <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
                                </svg>
                              ) : r.status === "failed" ? (
                                <svg
                                  width="19"
                                  height="19"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.2"
                                  strokeLinecap="round"
                                  aria-hidden
                                >
                                  <circle cx="12" cy="12" r="9" />
                                  <path d="M12 8v4.5M12 16h.01" />
                                </svg>
                              ) : r.status === "cancelled" ? (
                                <svg
                                  width="15"
                                  height="15"
                                  viewBox="0 0 24 24"
                                  fill="currentColor"
                                  aria-hidden
                                >
                                  <rect x="6" y="6" width="12" height="12" rx="2" />
                                </svg>
                              ) : (
                                <svg
                                  width="19"
                                  height="19"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.4"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden
                                >
                                  <path d="M20 6 9 17l-5-5" />
                                </svg>
                              )}
                              {live && <b>{Math.round(p * 100)}%</b>}
                            </span>
                            <div className={s.rt}>
                              <b>{runLine(r, name)}</b>
                              <span>
                                {by} ·{" "}
                                {new Date(r.createdAt)
                                  .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
                                  .toLowerCase()}
                                {live
                                  ? ` · ${fmt(r.done)} of ${fmt(r.total)}`
                                  : took(r)
                                    ? ` · ${took(r)!.replace("Done in", "took")}`
                                    : ""}
                              </span>
                              {live && (
                                <span className={s.bar}>
                                  <i style={{ transform: `scaleX(${p})` }} />
                                </span>
                              )}
                            </div>
                            <span className={s.side}>
                              {left && (
                                <span className={s.win} data-low={left.frac < 2 / 24 || undefined}>
                                  <svg viewBox="0 0 18 18" aria-hidden>
                                    <circle className={s.bg} cx="9" cy="9" r="7" />
                                    <circle
                                      className={s.fg}
                                      cx="9"
                                      cy="9"
                                      r="7"
                                      style={{ strokeDashoffset: 44 - 44 * left.frac }}
                                    />
                                  </svg>
                                  {left.words}
                                </span>
                              )}
                              {r.status === "undone" && "Undone"}
                              {r.status === "cancelled" && "Stopped"}
                              {r.status === "failed" && "Didn’t finish"}
                            </span>
                          </button>
                          <div className={s.body} {...(exp ? {} : { inert: true, "aria-hidden": true })}>
                            <div>
                              <div className={s.bin}>
                                <div className={s.split} aria-hidden>
                                  {r.done > 0 && (
                                    <i
                                      style={{
                                        flexGrow: r.done,
                                        background: r.status === "done" ? "var(--ok)" : "var(--accent)",
                                      }}
                                    />
                                  )}
                                  {r.skipped > 0 && (
                                    <i style={{ flexGrow: r.skipped, background: "var(--warn)" }} />
                                  )}
                                  {untouched > 0 && (
                                    <i style={{ flexGrow: untouched, background: "var(--line-2)" }} />
                                  )}
                                </div>
                                <p className={s.legend}>
                                  <b>{fmt(r.done)}</b> {r.action.type === "undo" ? "put back" : "changed"}
                                  {r.skipped > 0 && (
                                    <>
                                      {" "}
                                      · <b>{fmt(r.skipped)}</b> skipped
                                    </>
                                  )}
                                  {untouched > 0 && (
                                    <>
                                      {" "}
                                      · <b>{fmt(untouched)}</b> {live ? "still to do" : "not touched"}
                                    </>
                                  )}
                                </p>
                                {r.status === "failed" && (
                                  <p className={s.callout}>
                                    {r.error === "Their access changed"
                                      ? "It stopped because access changed while it ran. What was done stays, and can be undone."
                                      : "It stopped partway. What was done stays, and can be undone."}
                                  </p>
                                )}
                                {Object.keys(r.skippedBy).length > 0 && (
                                  <ul className={s.reasons}>
                                    {Object.entries(r.skippedBy).map(([code, c]) => (
                                      <li key={code}>{reasonWords(code, c)}.</li>
                                    ))}
                                  </ul>
                                )}
                                <dl className={s.facts}>
                                  <dt>Selected</dt>
                                  <dd>
                                    {r.selection.kind === "filter"
                                      ? `Everything a filter showed (${fmt(r.selection.total)} at the start${r.selection.except ? `, ${r.selection.except} left out` : ""})`
                                      : r.selection.kind === "undo"
                                        ? "The leads a bulk action changed"
                                        : `${fmt(r.selection.total)} picked by hand`}
                                  </dd>
                                  <dt>By</dt>
                                  <dd>{r.userId === session.user.id ? "You" : name.person(r.userId)}</dd>
                                </dl>
                                <div className={s.acts}>
                                  {r.canUndo && (
                                    <button
                                      type="button"
                                      className={s.btn}
                                      onClick={() => void act(r, "undo")}
                                    >
                                      {r.status === "done" ? "Undo" : `Undo these ${fmt(r.done)}`}
                                    </button>
                                  )}
                                  {live && (
                                    <button
                                      type="button"
                                      className={s.btn}
                                      onClick={() => void act(r, "cancel")}
                                    >
                                      Stop
                                    </button>
                                  )}
                                  {left && (
                                    <span className={s.cap}>
                                      Undo until{" "}
                                      {new Date(r.undoUntil!).toLocaleString("en-US", {
                                        weekday: "long",
                                        hour: "numeric",
                                        minute: "2-digit",
                                      })}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                </section>
              ))}
            </div>
          </>
        )}
        <footer className={s.foot}>
          Each lead keeps its own history. The audit log keeps one entry per bulk action.
        </footer>
      </aside>
    </Scrim>
  );
}
