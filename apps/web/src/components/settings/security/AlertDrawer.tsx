"use client";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { timeOf } from "@/lib/dates";
import { SPRINGS, toMotion } from "@/lib/motion";
import { securityClient, type Alert, type AlertDetail } from "@/lib/settings/security";
import { BurstChart } from "./BurstChart";
import s from "./security.module.css";

const FOCUSABLE = 'button:not([disabled]), [href], input, select, [tabindex]:not([tabindex="-1"])';
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const first = (name: string) => name.split(/\s+/)[0] ?? name;
const usual = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const CHART: Record<Alert["rule"], string> = {
  reveals: "Contacts opened, each minute",
  leadsOpened: "Leads opened, each minute",
  queueRuns: "Send-queue runs, each minute",
};
type Answer = "restored" | "kept_suspended" | "dismissed";

/** What happened, in a sentence with its numbers, then the limit and the person's usual day. */
function What({ d }: { d: AlertDetail }) {
  const a = d.alert;
  const who = first(a.user.name);
  const minutes = Math.max(1, Math.round((Date.parse(a.windowEnd) - Date.parse(a.windowStart)) / 60_000));
  const span = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const u = d.person.usualPerDay;
  if (a.rule === "queueRuns")
    return (
      <p className={s.what}>
        {who} started <b>{a.observed} send-queue runs today</b>. Your limit is {a.threshold} a day;{" "}
        {u ? `${who} usually runs about ${usual(u)}.` : `${who} hasn’t run any in the last 30 days.`}
      </p>
    );
  const noun = a.rule === "reveals" ? "leads" : "different leads";
  return (
    <p className={s.what}>
      {who} opened {a.rule === "reveals" ? "the contact details of " : ""}
      <b>
        {a.observed} {noun} in {span}
      </b>
      . Your limit is {a.threshold} an hour;{" "}
      {u ? `${who} usually opens about ${usual(u)} a day.` : `${who} hasn’t opened any in the last 30 days.`}
    </p>
  );
}

const dotOf = (words: string) =>
  /^The \d/.test(words)
    ? s.dotAmber
    : /^(Ended|Paused|Kept)/.test(words)
      ? s.dotRed
      : /^Access restored/.test(words)
        ? s.dotGreen
        : s.dot;

/**
 * One alert (canvas [Main]): it slides in from the right over a soft scrim and holds focus until it closes
 * (Escape, the scrim, or ×), then hands focus back. The person, what they did, the burst, what LUME did, and the
 * choices: Restore access or Keep them paused — or Dismiss, for an alert that paused nobody.
 */
export function AlertDrawer({
  id,
  timezone,
  canOffboard = false,
  onClose,
  onResolved,
}: {
  id: string;
  timezone: string;
  /** Offboarding is for people who manage users (6C): the drawer links to People's Offboard sheet. */
  canOffboard?: boolean;
  onClose: () => void;
  onResolved: (a: Alert) => void;
}) {
  const reduce = useReducedMotion();
  const panel = useRef<HTMLElement>(null);
  const [d, setD] = useState<AlertDetail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<Answer | null>(null);
  const [done, setDone] = useState<Answer | null>(null);

  useEffect(() => {
    let live = true;
    void securityClient.alert(id).then((r) => {
      if (!live) return;
      if (r.ok) setD(r.data);
      else setFailed(r.message);
    });
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, []);

  const answer = async (resolution: Answer) => {
    setBusy(resolution);
    setFailed(null);
    const r = await securityClient.resolve(id, resolution);
    setBusy(null);
    if (!r.ok) return setFailed(r.message);
    setDone(resolution);
    onResolved(r.data.alert);
  };

  const a = d?.alert;
  const who = a ? first(a.user.name) : "";
  const doneWords =
    done === "restored"
      ? `${who} has access again`
      : done === "kept_suspended"
        ? `${who} stays paused`
        : "Dismissed. LUME keeps watching.";
  const slide = reduce ? { opacity: 0 } : { x: "104%" };

  return (
    <div className={s.layer}>
      <motion.div
        className={s.scrim}
        onClick={onClose}
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.25 }}
      />
      <motion.aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={a ? `Alert: ${a.user.name}` : "Alert"}
        className={s.drawer}
        initial={slide}
        animate={reduce ? { opacity: 1 } : { x: 0 }}
        exit={slide}
        transition={reduce ? { duration: 0.2 } : toMotion(SPRINGS.drawer)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            return onClose();
          }
          if (e.key !== "Tab") return;
          const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
          if (e.shiftKey && document.activeElement === items[0]) {
            e.preventDefault();
            items.at(-1)?.focus();
          } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
            e.preventDefault();
            items[0]?.focus();
          }
        }}
      >
        <div className={s.drawerHead}>
          {a && (
            <span className={a.status === "open" ? s.pillWarn : s.pillMute}>
              {a.status === "open" ? "Alert" : "Answered"} · {timeOf(new Date(a.createdAt), timezone)}
            </span>
          )}
          <button type="button" className={s.close} aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
              <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className={s.drawerBody} data-open={d ? "true" : undefined}>
          {!d && !failed && <div className={s.loading} aria-busy="true" />}
          {failed && (
            <p role="alert" className={s.problem}>
              {failed}
            </p>
          )}
          {d && a && (
            <>
              <div className={s.person}>
                <span className={s.avatarLg} aria-hidden>
                  {a.user.initials}
                </span>
                <div>
                  <h2 className={s.personName}>{a.user.name}</h2>
                  <p className={s.cap}>
                    {[
                      d.person.roles.join(", ") || null,
                      d.person.joined ? `joined in ${MONTHS[new Date(d.person.joined).getUTCMonth()]}` : null,
                      `${d.person.leadCount} ${d.person.leadCount === 1 ? "lead" : "leads"}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              </div>
              <What d={d} />
              <BurstChart burst={d.burst} threshold={a.threshold} timezone={timezone} label={CHART[a.rule]} />
              <div>
                <h3 className={s.eyebrowSm}>What LUME did</h3>
                <ol className={s.timeline}>
                  {d.timeline.map((t, i) => (
                    <li key={i} className={s.step}>
                      <span className={s.stepTime}>{timeOf(new Date(t.at), timezone)}</span>
                      <i className={dotOf(t.words)} aria-hidden />
                      <span>{t.words}</span>
                    </li>
                  ))}
                </ol>
              </div>
              {a.status === "open" && !done && (
                <div>
                  <h3 className={s.eyebrowSm}>What would you like to do?</h3>
                  <div className={s.answers}>
                    {a.action === "suspended" ? (
                      <>
                        <button
                          type="button"
                          className={s.answer}
                          disabled={busy !== null}
                          onClick={() => void answer("restored")}
                        >
                          <span className={`${s.answerIcon} ${s.iconOk}`} aria-hidden>
                            <svg viewBox="0 0 16 16" width="16" height="16">
                              <path
                                d="M3.5 8.5 6.5 11.5 12.5 4.5"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </span>
                          <span>
                            <b>Restore access</b>{" "}
                            <span className={s.detail}>It was work. {who} can sign in again.</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className={s.answer}
                          disabled={busy !== null}
                          onClick={() => void answer("kept_suspended")}
                        >
                          <span className={`${s.answerIcon} ${s.iconBad}`} aria-hidden>
                            <svg viewBox="0 0 16 16" width="16" height="16">
                              <path
                                d="M6 4v8M10 4v8"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                              />
                            </svg>
                          </span>
                          <span>
                            <b>Keep {who} paused</b>{" "}
                            <span className={s.detail}>Look into it first. Their leads stay theirs.</span>
                          </span>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={s.answer}
                        disabled={busy !== null}
                        onClick={() => void answer("dismissed")}
                      >
                        <span className={`${s.answerIcon} ${s.iconOk}`} aria-hidden>
                          <svg viewBox="0 0 16 16" width="16" height="16">
                            <path
                              d="M3.5 8.5 6.5 11.5 12.5 4.5"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                        <span>
                          <b>Dismiss</b>{" "}
                          <span className={s.detail}>Nothing more to do. LUME keeps watching.</span>
                        </span>
                      </button>
                    )}
                    {canOffboard && (
                      <Link className={s.answer} href={`/settings/people?offboard=${a.user.id}`}>
                        <span className={`${s.answerIcon} ${s.iconBad}`} aria-hidden>
                          <svg viewBox="0 0 16 16" width="16" height="16">
                            <circle
                              cx="8"
                              cy="5.4"
                              r="2.6"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.6"
                            />
                            <path
                              d="M2.8 13.6c.6-2.5 2.6-3.9 5.2-3.9s4.6 1.4 5.2 3.9"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.6"
                              strokeLinecap="round"
                            />
                          </svg>
                        </span>
                        <span>
                          <b>Offboard {who}</b>{" "}
                          <span className={s.detail}>
                            Disable them, hand their leads on, see their last 30 days.
                          </span>
                        </span>
                      </Link>
                    )}
                  </div>
                </div>
              )}
              {done && (
                <p role="status" className={done === "kept_suspended" ? s.doneBad : s.done}>
                  <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden>
                    <path
                      d="M3.5 8.5 6.5 11.5 12.5 4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {doneWords}
                </p>
              )}
              <Link className={s.auditLink} href={`/settings/audit?actor=${a.user.id}`}>
                Open {who}’s audit log
              </Link>
            </>
          )}
        </div>
      </motion.aside>
    </div>
  );
}
