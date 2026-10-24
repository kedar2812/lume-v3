"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { autopilotClient } from "@/lib/autopilot/client";
import type {
  AutopilotSetup,
  Estimate,
  Permissions,
  ReadyCode,
  RunBody,
  RunGoal,
  RunSelection,
  StartResult,
} from "@/lib/autopilot/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import { GoalPicker, type GoalChoice } from "./GoalPicker";
import { PermissionRows } from "./PermissionRows";
import s from "./start.module.css";

/** The most leads one run takes (the server holds it too). */
const RUN_MAX = 500;
/** How long to wait after the last change before asking for a fresh estimate. */
const SETTLE_MS = 400;
/** The mark draws once before the sheet closes (§1.4). */
const DRAW_MS = 700;
const FIX_WORDS: Record<ReadyCode, string> = {
  AI_OFF: "Open Integrations",
  AI_MONTH: "See LUME AI's use",
  REPLY_OFF: "Open WhatsApp settings",
  NO_NUMBER: "Open WhatsApp settings",
  NUMBER_QUALITY: "Open WhatsApp settings",
  NO_TEMPLATES: "Open Templates",
};
const leadsWord = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "lead" : "leads"}`;
function money(m: { amount: number; currency: string }) {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: m.currency,
      maximumFractionDigits: m.amount >= 10 ? 0 : 2,
      minimumFractionDigits: 0,
    }).format(m.amount);
  } catch {
    return `${m.amount.toFixed(2)} ${m.currency}`;
  }
}
/** "2 first messages · about ₹43 to Meta · uses about 6% of this month's LUME AI" (§1.4). */
function estimateLine(e: Estimate): string {
  const parts = [
    `${e.firstMessages.toLocaleString("en-US")} first ${e.firstMessages === 1 ? "message" : "messages"}`,
  ];
  if (e.metaCost) parts.push(`about ${money(e.metaCost)} to Meta`);
  if (e.monthShare !== null) {
    const pct = Math.round(e.monthShare * 100);
    parts.push(
      pct < 1 ? "uses under 1% of this month's LUME AI" : `uses about ${pct}% of this month's LUME AI`,
    );
  }
  return parts.join(" · ");
}
const goalOf = (g: GoalChoice): RunGoal =>
  g.kind === "brief"
    ? { kind: "brief", text: g.text }
    : g.kind === "stage"
      ? { kind: "stage", stageId: g.stageId }
      : g;

/**
 * Let LUME AI handle these (Autopilot spec 2026-10-19 §1): the goal, who it speaks as and when, what it may do, and in
 * plain numbers what Start will do. Everything is read from the business's own setup; anything missing is said in words
 * with where to fix it. Start draws the mark once and hands the run to the island.
 */
export function StartSheet({
  target,
  count,
  onClose,
  onStarted,
}: {
  target: { leadIds: string[] } | { selection: RunSelection };
  count: number;
  onClose(): void;
  onStarted(r: StartResult): void;
}) {
  const reduce = useReducedMotion();
  const id = useId();
  const [setup, setSetup] = useState<AutopilotSetup | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [goal, setGoal] = useState<GoalChoice>({ kind: "reply" });
  const [speaker, setSpeaker] = useState("");
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [capText, setCapText] = useState("");
  const [remember, setRemember] = useState(false);
  const [est, setEst] = useState<Estimate | null>(null);
  const [estProblem, setEstProblem] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const title = `Let LUME AI handle ${leadsWord(count)}`;
  const tooMany = count > RUN_MAX;

  const load = useCallback(() => {
    setLoadProblem(null);
    void autopilotClient.setup().then((r) => {
      if (!r.ok) return setLoadProblem(r.message);
      const v = r.data;
      setSetup(v);
      setGoal(v.goals[0] ? { kind: "stage", stageId: v.goals[0].stageId } : { kind: "reply" });
      setSpeaker(
        v.standing.speaker && v.speakers.some((p) => p.id === v.standing.speaker) ? v.standing.speaker : "",
      );
      setPermissions(v.standing.permissions);
      setCap(v.standing.dailyCap);
      setCapText(v.standing.dailyCap === null ? "" : String(v.standing.dailyCap));
    });
  }, []);
  useEffect(() => {
    if (!tooMany) load();
  }, [load, tooMany]);

  const body = useMemo((): RunBody | null => {
    if (!setup || !permissions) return null;
    return {
      ...target,
      // An unconfirmed brief isn't sent: the estimate counts the same leads whatever the goal's words.
      goal: goal.kind === "brief" && !goal.locked ? { kind: "reply" } : goalOf(goal),
      speakerId: speaker || null,
      permissions,
      followUpDays: setup.standing.followUpDays,
      dailyCap: cap,
      remember,
    };
  }, [setup, permissions, target, goal, speaker, cap, remember]);

  // The estimate follows the choices, once they've settled; an answer for older choices never shows.
  const asked = useRef(0);
  const latest = useRef(body);
  latest.current = body;
  // "Use these every time" changes nothing about what Start would do.
  const estimateKey = body && setup?.ready.ok ? JSON.stringify({ ...body, remember: false }) : null;
  useEffect(() => {
    if (!estimateKey) return;
    const mine = ++asked.current;
    const t = setTimeout(
      () => {
        if (!latest.current) return;
        void autopilotClient.estimate(latest.current).then((r) => {
          if (mine !== asked.current) return;
          if (r.ok) {
            setEst(r.data);
            setEstProblem(null);
          } else setEstProblem(r.message);
        });
      },
      asked.current === 1 ? 0 : SETTLE_MS,
    );
    return () => clearTimeout(t);
  }, [estimateKey]);

  const why =
    goal.kind === "brief" && !goal.locked
      ? "Confirm your goal to start the run"
      : est && est.eligible === 0
        ? "None of these leads can be messaged"
        : null;

  const go = async () => {
    if (!body || why) return;
    setBusy(true);
    setProblem(null);
    const r = await autopilotClient.start(body);
    if (!r.ok) {
      setBusy(false);
      return setProblem(r.message);
    }
    if (reduce) return onStarted(r.data);
    setDrawing(true);
    setTimeout(() => onStarted(r.data), DRAW_MS);
  };

  const skippedBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of est?.skipped ?? []) m.set(x.why, (m.get(x.why) ?? 0) + 1);
    return [...m.entries()];
  }, [est]);

  const ready = setup?.ready.ok ? setup : null;
  const footer = ready ? (
    <div className={s.footer}>
      <div className={s.estimate} aria-live="polite">
        {est ? (
          <>
            {/* With no one to message, the line under Start says so. */}
            {est.eligible > 0 && <span>{estimateLine(est)}</span>}
            {est.skipped.length > 0 && (
              <button
                type="button"
                className={s.skippedToggle}
                aria-expanded={showSkipped}
                onClick={() => setShowSkipped((x) => !x)}
              >
                {est.skipped.length.toLocaleString("en-US")} skipped
              </button>
            )}
          </>
        ) : estProblem ? (
          <span className={s.problem}>{estProblem}</span>
        ) : (
          <span className={s.estimateWait}>
            <Skeleton width={240} height={13} />
            <span className={s.srOnly}>Working out what Start will do</span>
          </span>
        )}
      </div>
      <AnimatePresence initial={false}>
        {showSkipped && skippedBy.length > 0 && (
          <motion.ul
            aria-label="Skipped leads"
            className={s.skipped}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={toMotion(SPRINGS.default)}
          >
            {skippedBy.map(([w, n]) => (
              <li key={w}>
                {w} · {n.toLocaleString("en-US")}
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      <Button
        variant="primary"
        className={s.start}
        loading={busy}
        disabled={!!why || !body}
        aria-describedby={why ? `${id}-why` : undefined}
        onClick={() => void go()}
      >
        {drawing ? (
          <span className={s.drawing}>
            <AiGlyph size={18} draw="once" />
            Starting
          </span>
        ) : (
          "Start the run"
        )}
      </Button>
      {why && (
        <p id={`${id}-why`} className={s.why}>
          {why}
        </p>
      )}
    </div>
  ) : undefined;

  return (
    <Sheet label={title} onClose={onClose} footer={footer}>
      <header className={s.head}>
        <AiGlyph size={22} />
        <h2 className={s.title}>{title}</h2>
      </header>

      {tooMany ? (
        <div className={s.notReady}>
          <p>A run takes up to 500 leads. Narrow the filter, then try again.</p>
        </div>
      ) : !setup ? (
        loadProblem ? (
          <div className={s.notReady} role="alert">
            <p>{loadProblem}</p>
            <Button size="sm" onClick={load}>
              Try again
            </Button>
          </div>
        ) : (
          <div className={s.loading} aria-busy aria-label="Getting your choices">
            <Skeleton width="30%" height={14} />
            <Skeleton height={34} radius={10} />
            <Skeleton width="45%" height={14} />
            <Skeleton height={34} radius={10} />
            <Skeleton width="60%" height={14} />
            <Skeleton height={120} radius={14} />
          </div>
        )
      ) : !setup.ready.ok ? (
        <div className={s.notReady}>
          <p>{setup.ready.message}</p>
          {setup.ready.fixHref && (
            <Link href={setup.ready.fixHref} className={s.fixLink}>
              {FIX_WORDS[setup.ready.code]}
            </Link>
          )}
        </div>
      ) : (
        <div className={s.form}>
          <section className={s.section} aria-labelledby={`${id}-goal`}>
            <h3 id={`${id}-goal`} className={s.sectionTitle}>
              Goal
            </h3>
            <GoalPicker goals={setup.goals} value={goal} onChange={setGoal} />
          </section>

          <section className={s.section} aria-labelledby={`${id}-who`}>
            <h3 id={`${id}-who`} className={s.sectionTitle}>
              Who it speaks as, and when
            </h3>
            <Field label="Speaks as" hint="Their name goes in the messages.">
              {(c) => (
                <select {...c} value={speaker} onChange={(e) => setSpeaker(e.target.value)}>
                  <option value="">You</option>
                  {setup.speakers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className={s.when}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden className={s.whenIcon}>
                <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path
                  d="M12 7.5V12l3 2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
              <span>{setup.hours.line}</span>
              <Link href="/settings/follow-ups" className={s.link}>
                Change hours
              </Link>
            </div>
            <div className={s.capRow}>
              <Switch
                checked={cap !== null}
                label="Set a daily cap"
                onChange={(on) => {
                  setCapText(on ? "40" : "");
                  setCap(on ? 40 : null);
                }}
              />
              {cap === null ? (
                <span className={s.capNote}>
                  {typeof setup.number?.tierLimit === "number"
                    ? `Up to ${setup.number.tierLimit.toLocaleString("en-US")} a day, your number's WhatsApp limit`
                    : "Paced to your number's WhatsApp limit"}
                </span>
              ) : (
                <label className={s.capNote}>
                  <input
                    type="number"
                    min={1}
                    max={10_000}
                    inputMode="numeric"
                    className={s.capInput}
                    aria-label="Messages a day, at most"
                    value={capText}
                    onChange={(e) => {
                      setCapText(e.target.value);
                      const n = Number(e.target.value);
                      if (Number.isInteger(n) && n >= 1 && n <= 10_000) setCap(n);
                    }}
                  />
                  a day, at most
                </label>
              )}
            </div>
          </section>

          <section className={s.section} aria-labelledby={`${id}-may`}>
            <h3 id={`${id}-may`} className={s.sectionTitle}>
              What can LUME AI do for you?
            </h3>
            {permissions && (
              <PermissionRows
                value={permissions}
                onChange={setPermissions}
                followUpDays={setup.standing.followUpDays}
                stages={[]}
                available={setup.available}
              />
            )}
            {ready?.canRemember && (
              <div className={s.remember}>
                <Switch checked={remember} label="Use these every time" onChange={setRemember} />
                <span className={s.capNote}>
                  Saves these choices as LUME AI&apos;s standing choices in Settings.
                </span>
              </div>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}
