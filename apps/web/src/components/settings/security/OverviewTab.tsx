"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { shortDate, timeOf } from "@/lib/dates";
import { SPRINGS, toMotion } from "@/lib/motion";
import { useStream } from "@/lib/notifications/stream";
import { alertSentence, securityClient, type Alert, type SecurityActivity } from "@/lib/settings/security";
import { Activity } from "./Activity";
import { AlertDrawer } from "./AlertDrawer";
import s from "./security.module.css";

const RESOLVED: Record<NonNullable<Alert["resolution"]>, string> = {
  restored: "Restored",
  kept_suspended: "Kept paused",
  dismissed: "Dismissed",
  offboarded: "Offboarded",
};
/** After an answer, the drawer shows its result for a moment, then closes. */
const CLOSE_AFTER_MS = 1300;

/**
 * Security → Overview (6A, canvas [Main]): amber when an alert needs you, green when all is quiet; the open
 * alerts, each opening its drawer; then the last 30 days, each with how it was answered. A link with
 * `?alert=<id>` (the HUD, a notification) opens that alert straight away.
 */
export function OverviewTab({
  initial,
  timezone,
  openId,
  canOffboard = false,
  activity = null,
}: {
  initial: Alert[];
  timezone: string;
  openId: string | null;
  /** The viewer manages people: an alert offers Offboard, and a session Sign out (6C). */
  canOffboard?: boolean;
  /** Security activity, for someone who may read the audit log (6C ruling C4); null hides it. */
  activity?: SecurityActivity | null;
}) {
  const reduce = useReducedMotion();
  const [alerts, setAlerts] = useState(initial);
  const [opened, setOpened] = useState<string | null>(openId);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const titleId = useId();
  // The page's own answer wins when it changes: Review from the HUD or the notification centre while already here
  // brings new alerts and a new ?alert= (6A final review).
  useEffect(() => setAlerts(initial), [initial]);
  useEffect(() => {
    if (openId) setOpened(openId);
  }, [openId]);
  // An alert arriving live refreshes the list and the status card, so they never disagree with the HUD.
  useStream((n) => {
    if (n.kind !== "security_alert") return;
    void securityClient.alerts("recent").then((r) => r.ok && setAlerts(r.data.alerts));
  });
  const open = alerts.filter((a) => a.status === "open");
  const earlier = alerts.filter((a) => a.status === "resolved");
  const newest = open[0];

  const close = () => {
    const id = opened;
    setOpened(null);
    if (typeof window !== "undefined" && window.location.search.includes("alert="))
      window.history.replaceState(null, "", window.location.pathname);
    if (id) queueMicrotask(() => rows.current.get(id)?.focus());
  };
  const resolved = async (a: Alert) => {
    setAlerts((all) => all.map((x) => (x.id === a.id ? a : x)));
    const r = await securityClient.alerts("recent");
    if (r.ok) setAlerts(r.data.alerts);
    setTimeout(close, CLOSE_AFTER_MS);
  };

  const title = newest
    ? open.length === 1
      ? "1 alert needs you"
      : `${open.length} alerts need you`
    : "All quiet";
  const sub = newest
    ? newest.action === "suspended"
      ? `LUME paused ${newest.user.name}’s access at ${timeOf(new Date(newest.createdAt), timezone)}.`
      : `${alertSentence(newest)}. LUME told you at ${timeOf(new Date(newest.createdAt), timezone)}.`
    : "LUME is watching. Nothing needs you right now.";

  return (
    <div className={s.stack}>
      <section aria-labelledby={titleId} className={newest ? s.statusAlert : s.statusQuiet}>
        <span className={s.statusIcon} aria-hidden>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.svg
              key={newest ? "alert" : "quiet"}
              viewBox="0 0 24 24"
              width="22"
              height="22"
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={toMotion(SPRINGS.bounce)}
            >
              <path
                d="M12 3 5 6v5.5c0 4.2 2.9 7.9 7 9.5 4.1-1.6 7-5.3 7-9.5V6l-7-3Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinejoin="round"
              />
              {newest ? (
                <path
                  d="M12 8v4.5M12 15.6v.1"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                />
              ) : (
                <path
                  d="m8.8 12.2 2.3 2.3 4.3-4.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </motion.svg>
          </AnimatePresence>
        </span>
        <div>
          <h2 id={titleId} className={s.statusTitle}>
            {title}
          </h2>
          <p className={s.statusSub}>{sub}</p>
        </div>
      </section>

      {open.length > 0 && (
        <ul className={s.alertList} aria-label="Open alerts">
          {open.map((a) => (
            <li key={a.id}>
              <AlertRow
                a={a}
                onOpen={() => setOpened(a.id)}
                rowRef={(el) => el && rows.current.set(a.id, el)}
              />
            </li>
          ))}
        </ul>
      )}

      {activity && <Activity data={activity} timezone={timezone} canManagePeople={canOffboard} />}

      {earlier.length > 0 && (
        <section>
          <h2 className={s.eyebrowSm}>Earlier · last 30 days</h2>
          <ul className={s.alertList} aria-label="Earlier alerts">
            {earlier.map((a) => (
              <li key={a.id}>
                <AlertRow
                  a={a}
                  onOpen={() => setOpened(a.id)}
                  rowRef={(el) => el && rows.current.set(a.id, el)}
                  outcome={`${RESOLVED[a.resolution ?? "dismissed"]} by ${a.resolvedBy ?? "an admin"} · ${shortDate(new Date(a.resolvedAt ?? a.createdAt), timezone)}`}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <AnimatePresence>
        {opened && (
          <AlertDrawer
            key={opened}
            id={opened}
            timezone={timezone}
            canOffboard={canOffboard}
            onClose={close}
            onResolved={(a) => void resolved(a)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function AlertRow({
  a,
  onOpen,
  rowRef,
  outcome,
}: {
  a: Alert;
  onOpen: () => void;
  rowRef: (el: HTMLButtonElement | null) => void;
  outcome?: string;
}) {
  const paused = a.action === "suspended";
  return (
    <button
      type="button"
      ref={rowRef}
      className={outcome ? `${s.alertRow} ${s.alertRowDone}` : s.alertRow}
      onClick={onOpen}
    >
      <span className={s.avatar} aria-hidden>
        {a.user.initials}
      </span>
      <span className={s.alertText}>
        <b>{alertSentence(a)}</b>
        <span className={s.detail}>
          {outcome ??
            (paused
              ? "LUME ended their sessions and paused sign-in"
              : "LUME told you; nothing changed for them")}
        </span>
      </span>
      {!outcome && <span className={paused ? s.pillBad : s.pillWarn}>{paused ? "Paused" : "Told you"}</span>}
      <span className={s.review}>{outcome ? "View" : "Review"}</span>
    </button>
  );
}
