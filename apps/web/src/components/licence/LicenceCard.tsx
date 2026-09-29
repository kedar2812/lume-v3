"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type { LicenceForPerson } from "@/lib/licence/client";
import { licenceClient } from "@/lib/licence/client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { ExportAll } from "./ExportAll";
import { ago, day, until, useLicence } from "./LicenceProvider";
import s from "./licence.module.css";

const R = 56;
const CIRC = 2 * Math.PI * R;

const STATE_WORDS: Record<LicenceForPerson["state"], string> = {
  active: "Active",
  grace: "Grace",
  read_only: "Read-only",
  suspended: "Paused",
};

function typeWords(l: LicenceForPerson): string {
  if (l.dev) return "Development licence";
  if (l.licenseType === "perpetual") return "Perpetual licence";
  if (l.licenseType === "trial") return "Trial";
  if (l.licenseType === "subscription") return "Subscription";
  return "Not checked yet";
}
function paidWords(l: LicenceForPerson): { label: string; value: string } {
  if (l.licenseType === "perpetual") return { label: "Paid until", value: "Never expires" };
  if (l.licenseType === "trial" && l.trialEndsAt) return { label: "Trial ends", value: day(l.trialEndsAt) };
  return { label: "Paid until", value: l.paidUntil ? day(l.paidUntil) : "—" };
}

/**
 * Settings → About, the licence (canvas: Main): a ring drawn round the mark, the state, what kind of
 * licence it is and until when, this installation, and the check-ins. Check now (admins) spins the ring,
 * then a green tick settles on it. Below: what LUME tells its licence server, and the export.
 */
export function LicenceCard() {
  const { licence, canExport, set } = useLicence();
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<"idle" | "checking" | "verified" | "failed">("idle");
  const paid = paidWords(licence);

  const check = async () => {
    if (phase === "checking") return;
    setPhase("checking");
    const r = await licenceClient.check();
    if (!r.ok) return setPhase("failed");
    set(r.data);
    setPhase(r.data.state === "active" ? "verified" : "idle");
  };

  return (
    <div className={s.aboutStack}>
      <motion.section
        aria-label="Licence"
        className={s.licenceCard}
        initial={reduce ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={toMotion(SPRINGS.default)}
      >
        <div className={s.ringWrap}>
          <svg
            viewBox="0 0 128 128"
            width="128"
            height="128"
            aria-hidden
            data-testid="licence-ring"
            data-motion={reduce ? "none" : "draw"}
          >
            <circle cx="64" cy="64" r={R} className={s.ringTrack} />
            {phase === "checking" && !reduce ? (
              <motion.circle
                cx="64"
                cy="64"
                r={R}
                className={s.ringLine}
                strokeDasharray={`${CIRC * 0.26} ${CIRC}`}
                style={{ transformOrigin: "64px 64px" }}
                animate={{ rotate: 360 }}
                transition={{ repeat: Infinity, ease: "linear", duration: 0.9 }}
              />
            ) : (
              <motion.circle
                cx="64"
                cy="64"
                r={R}
                className={s.ringLine}
                transform="rotate(-90 64 64)"
                strokeDasharray={CIRC}
                initial={reduce ? false : { strokeDashoffset: CIRC }}
                animate={{ strokeDashoffset: 0 }}
                transition={{ duration: 1.4, delay: 0.25, ease: [0.5, 0, 0.2, 1] }}
              />
            )}
          </svg>
          {/* The mark exactly as supplied (never redrawn). */}
          <img src="/lume-mark.png" alt="" width={56} height={56} className={s.ringMark} />
          <AnimatePresence>
            {phase === "verified" && (
              <motion.span
                key="ok"
                data-testid="licence-verified"
                className={s.verified}
                initial={reduce ? false : { scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={toMotion(SPRINGS.bounce)}
              >
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <motion.path
                    d="M3.5 8.5l3 3 6-7"
                    fill="none"
                    stroke="#fff"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={reduce ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.45, delay: 0.15 }}
                  />
                </svg>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <div className={s.licenceFacts}>
          <div className={s.licenceHead}>
            <span className={s.kicker}>Licence</span>
            <span
              className={s.statePill}
              data-state={licence.state}
              data-halo={phase === "verified" || undefined}
            >
              <span aria-hidden />
              {licence.dev ? "Active" : STATE_WORDS[licence.state]}
            </span>
          </div>
          <p className={s.licenceType}>{typeWords(licence)}</p>
          <dl className={s.factGrid}>
            <div>
              <dt>{paid.label}</dt>
              <dd>{licence.dev ? "—" : paid.value}</dd>
            </div>
            <div>
              <dt>This installation</dt>
              <dd className={s.num}>{licence.instanceId ?? "—"}</dd>
            </div>
            <div data-flash={phase === "verified" || undefined}>
              <dt>Last check-in</dt>
              <dd>{licence.checkedAt ? ago(licence.checkedAt) : "Not yet"}</dd>
            </div>
            <div>
              <dt>Next check-in</dt>
              <dd className={s.num}>{licence.nextCheckAt ? until(licence.nextCheckAt) : "—"}</dd>
            </div>
          </dl>
          {licence.canCheck && !licence.dev && (
            <div className={s.checkRow}>
              <button
                type="button"
                className={s.btnSecondary}
                onClick={() => void check()}
                disabled={phase === "checking"}
              >
                {phase === "checking"
                  ? "Checking…"
                  : phase === "verified"
                    ? "Checked · all good"
                    : "Check now"}
              </button>
              <span className={s.checkNote}>
                {phase === "failed"
                  ? "LUME couldn't reach its licence server just now."
                  : "LUME checks by itself every 6 hours."}
              </span>
            </div>
          )}
        </div>
      </motion.section>

      <div className={s.aboutPair}>
        <section aria-label="What LUME tells its licence server" className={s.aboutCard}>
          <h3 className={s.aboutCardTitle}>
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden>
              <path
                d="M9 1.8l5.8 2.2v4.6c0 3.7-2.5 6.3-5.8 7.6-3.3-1.3-5.8-3.9-5.8-7.6V4z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
            What LUME tells its licence server
          </h3>
          <div className={s.chips}>
            {[
              "This installation's ID",
              "Licence key",
              "LUME version",
              "How many people use it",
              "How many leads (a number)",
              "Server time",
            ].map((c) => (
              <span key={c} className={s.chip}>
                {c}
              </span>
            ))}
          </div>
          <p className={s.aboutWords}>
            Never a lead&apos;s name, number, email or anything they said. Those stay on this server.
          </p>
        </section>
        <section aria-label="Your data, always yours" className={s.aboutCard}>
          <h3 className={s.aboutCardTitle}>
            <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden>
              <path
                d="M9 2.5v9M5.5 8L9 11.5 12.5 8M3 13.5v1.5h12v-1.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Your data, always yours
          </h3>
          <p className={s.aboutWords}>
            Leads, notes, history, follow-ups and people, as CSV files and one Excel workbook. Works whatever
            the licence says.
          </p>
          {canExport && (
            <div>
              <ExportAll variant="secondary" />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
