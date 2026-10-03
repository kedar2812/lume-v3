"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { longDate } from "@/lib/dates";
import {
  usersClient,
  type LeadsChoice,
  type OffboardOutcome,
  type OffboardPreview,
  type TeamMember,
} from "@/lib/settings/people";
import s from "./offboard.module.css";

const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
/** How long each step takes to tick once LUME has done the work: long enough to read, never a wait. */
const TICK_MS = 650;

/**
 * Each colleague's share of `n` leads, the way LUME hands them out (6C ruling C1): each lead to whoever has the
 * fewest open leads at that moment, ties by name. Only those who get some are listed.
 */
export function sharesFor(members: TeamMember[], n: number): { id: string; name: string; count: number }[] {
  const load = new Map(members.map((m) => [m.id, m.openLeads]));
  const given = new Map(members.map((m) => [m.id, 0]));
  for (let i = 0; i < n && members.length; i++) {
    const next = [...members].sort(
      (a, b) => load.get(a.id)! - load.get(b.id)! || a.name.localeCompare(b.name),
    )[0]!;
    load.set(next.id, load.get(next.id)! + 1);
    given.set(next.id, given.get(next.id)! + 1);
  }
  return members.map((m) => ({ id: m.id, name: m.name, count: given.get(m.id)! })).filter((x) => x.count > 0);
}

type Choice = "team" | "person" | "none";

/**
 * Offboard someone (6C, canvas [Offboard]): sign them out everywhere, hand on their leads, disconnect their Google
 * Calendar, and see their last 30 days, then one act. LUME does it all at once; the steps then tick in order with
 * what each did. It can't be closed while it runs.
 */
export function OffboardSheet({
  personId,
  timeZone,
  onClose,
  onDone,
}: {
  personId: string;
  /** The business's clock, for the busiest day's words. */
  timeZone: string;
  onClose: () => void;
  onDone: (outcome: OffboardOutcome) => void;
}) {
  const [preview, setPreview] = useState<OffboardPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>("none");
  const [teamId, setTeamId] = useState("");
  const [userId, setUserId] = useState("");
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<OffboardOutcome | null>(null);
  const [ticked, setTicked] = useState(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    let live = true;
    void usersClient.offboarding(personId).then((r) => {
      if (!live) return;
      if (!r.ok) return setProblem(r.message);
      const p = r.data;
      setPreview(p);
      setTeamId(p.teams[0]?.id ?? "");
      setUserId(p.people[0]?.id ?? "");
      setChoice(p.leads.total === 0 ? "none" : p.teams.length ? "team" : p.people.length ? "person" : "none");
    });
    const pending = timers.current;
    return () => {
      live = false;
      pending.forEach(clearTimeout);
    };
  }, [personId]);

  const steps = preview ? (preview.calendar ? 4 : 3) : 0;
  const done = outcome !== null && ticked >= steps;
  const busy = running || (outcome !== null && !done);

  const close = () => {
    if (busy) return; // Mid-run: nothing closes it.
    if (outcome) onDone(outcome);
    else onClose();
  };

  const go = async () => {
    if (!preview || busy) return;
    setRunning(true);
    setProblem(null);
    const leads: LeadsChoice =
      preview.leads.total === 0 || choice === "none"
        ? { to: "none" }
        : choice === "team"
          ? { to: "team", teamId }
          : { to: "person", userId };
    const r = await usersClient.offboard(personId, leads);
    setRunning(false);
    if (!r.ok) return setProblem(r.message);
    setOutcome(r.data);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return setTicked(steps);
    for (let k = 1; k <= steps; k++)
      timers.current.push(window.setTimeout(() => setTicked(k), k * TICK_MS - TICK_MS / 2));
  };

  if (!preview)
    return (
      <Dialog label="Offboard" onClose={onClose} wide>
        {problem ? (
          <>
            <p role="alert" className={s.problem}>
              {problem}
            </p>
            <div className={s.foot}>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <p className={s.loading} role="status">
            LUME is gathering what there is to hand on…
          </p>
        )}
      </Dialog>
    );

  const p = preview;
  const name = first(p.person.name);
  const team = p.teams.find((t) => t.id === teamId) ?? p.teams[0];
  const shares = team ? sharesFor(team.members, p.leads.total) : [];
  const person = p.people.find((x) => x.id === userId);
  const stateOf = (k: number) =>
    ticked >= k ? "ok" : (running || outcome) && ticked === k - 1 ? "run" : "idle";

  const results = outcome && {
    sessions: outcome.sessions
      ? `Done · ${plural(outcome.sessions, "session")} ended`
      : "Done · no sessions left",
    leads:
      outcome.leads.moved === 0
        ? "Done · no leads to hand on"
        : outcome.leads.to === "team"
          ? `Done · ${plural(outcome.leads.moved, "lead")} shared: ${(outcome.leads.shares ?? [])
              .map((x) => `${first(x.name)} ${x.count.toLocaleString("en-US")}`)
              .join(", ")}`
          : outcome.leads.to === "person"
            ? `Done · ${plural(outcome.leads.moved, "lead")} went to ${person?.name ?? "them"}`
            : `Done · ${plural(outcome.leads.moved, "lead")} ${outcome.leads.moved === 1 ? "is" : "are"} unassigned`,
    calendar: outcome.calendar
      ? outcome.calendar.meetingsMoved
        ? `Done · ${plural(outcome.calendar.meetingsMoved, "meeting")} went with their leads`
        : "Done · disconnected"
      : "",
  };

  const usual = Math.round(p.last30.usualPerDay);
  const busiest = p.last30.busiest;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  const busiestWords = busiest
    ? `Busiest day: ${busiest.day === today ? "today" : longDate(new Date(`${busiest.day}T12:00:00Z`), "UTC")}, ${plural(busiest.count, "contact")}. ${usual ? `Usually about ${usual} a day.` : "Usually fewer than one a day."}`
    : "No contacts opened in the last 30 days.";
  const spiky = !!busiest && busiest.count >= 3 * Math.max(usual, 1);

  return (
    <Dialog label={`Offboard ${p.person.name}`} onClose={close} width={620}>
      <div className={s.sheet}>
        <header className={s.head}>
          <Avatar name={p.person.name} size={44} />
          <div>
            <h2 className={s.title}>Offboard {p.person.name}</h2>
            <p className={s.sub}>{name} won’t be able to sign in. You can bring them back later.</p>
          </div>
        </header>

        <ol className={s.steps}>
          <Step n={1} state={stateOf(1)} title={`Sign ${name} out everywhere`}>
            {results && ticked >= 1 ? (
              <p className={s.ok}>{results.sessions}</p>
            ) : (
              <p className={s.line}>
                {p.sessions ? plural(p.sessions, "live session") : "Already signed out"}
              </p>
            )}
          </Step>

          <Step
            n={2}
            state={stateOf(2)}
            title={
              p.leads.total
                ? `Hand on ${name}’s ${plural(p.leads.total, "lead")}`
                : `${name} has no leads to hand on`
            }
          >
            {results && ticked >= 2 ? (
              <p className={s.ok}>{results.leads}</p>
            ) : (
              p.leads.total > 0 && (
                <div role="radiogroup" aria-label={`Who takes ${name}’s leads`} className={s.choices}>
                  {team && (
                    <Option
                      on={choice === "team"}
                      disabled={busy}
                      onPick={() => setChoice("team")}
                      title={`Share them across the ${team.name} team`}
                      detail="Whoever has the fewest open leads gets the next one"
                    >
                      {choice === "team" && (
                        <>
                          {p.teams.length > 1 && (
                            <select
                              aria-label="Team"
                              className={s.select}
                              value={team.id}
                              disabled={busy}
                              onChange={(e) => setTeamId(e.target.value)}
                            >
                              {p.teams.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                            </select>
                          )}
                          <span className={s.split} aria-label="Each person’s share">
                            {shares.map((x) => (
                              <span key={x.id}>
                                {x.name} · {x.count.toLocaleString("en-US")}
                              </span>
                            ))}
                          </span>
                        </>
                      )}
                    </Option>
                  )}
                  {p.people.length > 0 && (
                    <Option
                      on={choice === "person"}
                      disabled={busy}
                      onPick={() => setChoice("person")}
                      title="Give them all to one person"
                      detail={choice === "person" ? "" : (person?.name ?? "")}
                    >
                      {choice === "person" && (
                        <select
                          aria-label="Person"
                          className={s.select}
                          value={userId}
                          disabled={busy}
                          onChange={(e) => setUserId(e.target.value)}
                        >
                          {p.people.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </Option>
                  )}
                  <Option
                    on={choice === "none"}
                    disabled={busy}
                    onPick={() => setChoice("none")}
                    title="Leave them unassigned"
                    detail="An admin hands them out later"
                  />
                </div>
              )
            )}
          </Step>

          {p.calendar && (
            <Step
              n={3}
              state={stateOf(3)}
              title={
                <>
                  Disconnect {name}’s Google Calendar
                  <span className={s.gmark}>
                    <img src="/brand/google-calendar.png" alt="" width={14} height={14} />
                  </span>
                </>
              }
            >
              {results && ticked >= 3 ? (
                <p className={s.ok}>{results.calendar}</p>
              ) : (
                <p className={s.line}>{p.calendar.email} · LUME stops reading it at once</p>
              )}
            </Step>
          )}

          <Step n={steps} state={stateOf(steps)} title={`${name}’s last 30 days`}>
            <ul className={s.figures} aria-label={`${name}’s last 30 days`}>
              <li data-tone={spiky ? "warn" : undefined}>
                <b>{p.last30.reveals.toLocaleString("en-US")}</b>
                <span>{p.last30.reveals === 1 ? "contact opened" : "contacts opened"}</span>
              </li>
              <li>
                <b>{p.last30.leadsOpened.toLocaleString("en-US")}</b>
                <span>{p.last30.leadsOpened === 1 ? "lead opened" : "leads opened"}</span>
              </li>
              <li>
                <b>{p.last30.exports.toLocaleString("en-US")}</b>
                <span>{p.last30.exports === 1 ? "export" : "exports"}</span>
              </li>
              <li data-tone={p.last30.alerts ? "warn" : undefined}>
                <b>{p.last30.alerts.toLocaleString("en-US")}</b>
                <span>{p.last30.alerts === 1 ? "alert" : "alerts"}</span>
              </li>
            </ul>
            <p className={s.line}>{busiestWords}</p>
          </Step>
        </ol>

        {problem && (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        )}

        <footer className={s.foot}>
          {done ? (
            <>
              <p role="status" className={s.finished}>
                <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden>
                  <path
                    d="M3.4 8.4 6.4 11.4 12.6 4.8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {p.person.name} is offboarded. LUME recorded every step.
              </p>
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </>
          ) : (
            <>
              <Link className={s.audit} href={`/settings/audit?actor=${p.person.id}`}>
                Open {name}’s audit log
              </Link>
              <span className={s.grow} />
              <Button variant="ghost" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button variant="danger" loading={busy} onClick={() => void go()}>
                Offboard {name}
              </Button>
            </>
          )}
        </footer>
      </div>
    </Dialog>
  );
}

function Step({
  n,
  state,
  title,
  children,
}: {
  n: number;
  state: "idle" | "run" | "ok";
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className={s.step}>
      <span className={s.num} data-state={state} aria-hidden>
        {state === "ok" ? (
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path
              d="M3.4 8.4 6.4 11.4 12.6 4.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          n
        )}
      </span>
      <div className={s.stepBody}>
        <b className={s.stepTitle}>{title}</b>
        {children}
      </div>
    </li>
  );
}

function Option({
  on,
  disabled,
  onPick,
  title,
  detail,
  children,
}: {
  on: boolean;
  disabled: boolean;
  onPick: () => void;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className={on ? `${s.option} ${s.on}` : s.option}>
      <label className={s.optionLabel}>
        <input
          type="radio"
          name="offboard-leads"
          className={s.radio}
          checked={on}
          disabled={disabled}
          onChange={onPick}
        />
        <span>
          <b>{title}</b>
          {detail && <span className={s.detail}>{detail}</span>}
        </span>
      </label>
      {children && <div className={s.extra}>{children}</div>}
    </div>
  );
}
