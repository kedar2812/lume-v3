"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { can, onboardingStepsFor, type Preferences } from "@lume/core/shared";
import { useSound } from "@/components/feedback/SoundProvider";
import { Button } from "@/components/ui/Button";
import { dayPreview } from "@/lib/day-preview";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { OnboardingActions } from "@/lib/onboarding-client";
import type { ThemePref } from "@/lib/theme";
import { guessTimezone } from "@/lib/timezones";
import type { Session } from "@/server/session";
import { AlertsPanel } from "./panels/Alerts";
import { ConnectPanel } from "./panels/Connect";
import { DayPanel } from "./panels/Day";
import { DonePanel } from "./panels/Done";
import { LookPanel } from "./panels/Look";
import { PipelinePanel } from "./panels/Pipeline";
import { SecurePanel } from "./panels/Secure";
import { TeamPanel } from "./panels/Team";
import { WelcomePanel } from "./panels/Welcome";
import { YouPanel } from "./panels/You";
import { Rail } from "./Rail";
import s from "./onboarding.module.css";

export type { OnboardingActions };

const SAVE_FAILED = "LUME couldn’t save that. Check your connection and try again.";
const THEME_NAME: Record<ThemePref, string> = {
  porcelain: "Porcelain",
  obsidian: "Obsidian",
  system: "Match device",
};
const SKIP_LABEL: Partial<Record<string, string>> = {
  team: "Later",
  pipeline: "Later",
  connect: "I’ll do this later",
};

/**
 * First sign-in (spec §4). The step list comes from @lume/core, so the API and this sheet always agree
 * on who sees what. Every step saves on Continue and records where the person is, so a closed tab
 * resumes in the same place; only a required step (two-step enrolment) cannot be skipped.
 */
export function Onboarding({
  session,
  actions,
  onFinished,
  businessName = "",
}: {
  session: Session;
  actions: OnboardingActions;
  onFinished: (o: { startTour: boolean }) => void;
  businessName?: string;
}) {
  const steps = useMemo(
    () =>
      onboardingStepsFor({
        actor: session.actor,
        twoFactorEnabled: session.twoFactor.enabled,
        capabilities: session.capabilities,
      }),
    [session],
  );
  const requiredAt = steps.findIndex((x) => x.required);
  const [index, setIndex] = useState(() => {
    const stored = steps.findIndex((x) => x.id === session.onboarding.step);
    // Never resume past a required step that is still outstanding.
    return Math.max(0, requiredAt >= 0 ? Math.min(stored, requiredAt) : stored);
  });
  const [reached, setReached] = useState(index);
  const [direction, setDirection] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(session.user.name);
  const [timezone, setTimezone] = useState(session.user.timezone ?? "");
  const [theme, setTheme] = useState<ThemePref>(session.user.theme);
  const themeAtStart = useRef<string | null>(null);
  const [prefs, setPrefs] = useState<Preferences>(session.preferences);

  const [enrolment, setEnrolment] = useState<{ secret: string; otpauthUri: string } | null | "failed">(null);
  const enrolStarted = useRef(false);
  const [code, setCode] = useState("");
  const [otpKey, setOtpKey] = useState(0);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);

  const sound = useSound();
  const reduce = useReducedMotion();
  const pane = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  const step = steps[index]!;
  const secured = requiredAt < 0 || (codes !== null && saved);
  const lockedAfter = secured ? steps.length : requiredAt;
  const firstName = name.trim().split(/\s+/)[0] || session.user.name.split(" ")[0] || "";
  const isAdmin = session.user.isOwner || can(session.actor, "users.manage");
  const counted = steps.filter((x) => x.id !== "welcome" && x.id !== "done");
  const kicker = (() => {
    const n = counted.findIndex((x) => x.id === step.id) + 1;
    const extra = step.required ? " · Required" : step.group === "workspace" ? " · Workspace" : "";
    return `Step ${n} of ${counted.length}${extra}`;
  })();

  // The server can't know this person's zone, so the guess happens after mount.
  useEffect(() => {
    setTimezone((tz) => tz || guessTimezone());
    themeAtStart.current = document.documentElement.dataset.theme ?? session.user.theme;
  }, [session.user.theme]);

  useEffect(() => {
    if (step.id !== "secure" || enrolStarted.current) return;
    enrolStarted.current = true; // once: a second secret would silently replace the one on screen
    void actions.startEnrolment().then((r) => setEnrolment(r ?? "failed"));
  }, [step.id, actions]);

  useEffect(() => {
    pane.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
    if (step.id === "done") sound.play("done");
    // Deliberately keyed on the step alone: the chime must play once on arrival, not on every re-render.
  }, [index]);

  // The fade at the bottom shows only while there is more to scroll to — re-measured whenever the
  // panel's content changes size (a list that loads after the step appears, a field that grows).
  useEffect(() => {
    const panel = pane.current?.querySelector<HTMLElement>(`[data-panel="${step.id}"]`);
    const body = panel?.firstElementChild;
    if (!panel || !body) return;
    const measure = () => setMore(panel.scrollHeight - panel.clientHeight - panel.scrollTop > 8);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [step.id]);

  function go(i: number) {
    setDirection(i > index ? 1 : -1);
    setIndex(i);
    setReached((r) => Math.max(r, i));
    setError(null);
  }

  function forward() {
    const next = steps[index + 1];
    if (!next) return;
    void actions.markStep(next.id);
    go(index + 1);
  }

  async function saving(fn: () => Promise<boolean>): Promise<boolean> {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (!ok) setError(SAVE_FAILED);
    return ok;
  }

  async function verify() {
    setBusy(true);
    setError(null);
    const r = await actions.confirmEnrolment(code);
    setBusy(false);
    if (r.ok) return setCodes(r.recoveryCodes);
    setError(r.message);
    setCode("");
    setOtpKey((k) => k + 1);
  }

  async function primary() {
    setError(null);
    switch (step.id) {
      case "you": {
        const trimmed = name.trim() || session.user.name;
        if (!(await saving(() => actions.saveProfile({ name: trimmed, ...(timezone ? { timezone } : {}) }))))
          return;
        break;
      }
      case "secure":
        if (!codes) return verify();
        break;
      case "look":
        if (!(await saving(() => actions.saveProfile({ theme })))) return;
        themeAtStart.current = theme;
        break;
      case "day": {
        const { workingDays, workStart, workEnd, digestTime } = prefs;
        if (!(await saving(() => actions.savePreferences({ workingDays, workStart, workEnd, digestTime }))))
          return;
        break;
      }
      case "alerts":
        if (!(await saving(() => actions.savePreferences({ sounds: prefs.sounds, alerts: prefs.alerts }))))
          return;
        sound.setEnabled(prefs.sounds.enabled);
        sound.setVolume(prefs.sounds.volume);
        break;
    }
    forward();
  }

  function skip() {
    // A previewed theme that wasn't chosen goes back to what it was.
    if (step.id === "look" && themeAtStart.current)
      document.documentElement.dataset.theme = themeAtStart.current;
    void actions.skipStep(step.id);
    forward();
  }

  async function finish(startTour: boolean) {
    setBusy(true);
    await actions.complete();
    onFinished({ startTour });
  }

  function previewTheme(t: ThemePref) {
    setTheme(t);
    document.documentElement.dataset.theme = t;
  }

  const panel = (() => {
    switch (step.id) {
      case "welcome":
        return (
          <WelcomePanel
            firstName={firstName}
            businessName={businessName}
            steps={steps}
            isOwner={session.user.isOwner}
          />
        );
      case "you":
        return (
          <YouPanel
            kicker={kicker}
            name={name}
            onName={setName}
            timezone={timezone}
            onTimezone={setTimezone}
            invited={!session.user.isOwner}
          />
        );
      case "secure":
        return (
          <SecurePanel
            kicker={kicker}
            enrolment={enrolment}
            codes={codes}
            saved={saved}
            onSaved={setSaved}
            onCode={setCode}
            otpKey={otpKey}
            busy={busy}
            onRetry={() => {
              setEnrolment(null);
              void actions.startEnrolment().then((r) => setEnrolment(r ?? "failed"));
            }}
          />
        );
      case "look":
        return <LookPanel kicker={kicker} theme={theme} onTheme={previewTheme} />;
      case "day":
        return <DayPanel kicker={kicker} value={prefs} onChange={(d) => setPrefs({ ...prefs, ...d })} />;
      case "alerts":
        return (
          <AlertsPanel
            kicker={kicker}
            value={prefs}
            onChange={(a) => setPrefs({ ...prefs, ...a })}
            onSample={(volume) => {
              sound.setVolume(volume);
              sound.play("done");
            }}
            isAdmin={isAdmin}
          />
        );
      case "team":
        return <TeamPanel kicker={kicker} actions={actions} isOwner={session.user.isOwner} />;
      case "pipeline":
        return <PipelinePanel kicker={kicker} actions={actions} isOwner={session.user.isOwner} />;
      case "connect":
        return (
          <ConnectPanel
            kicker={kicker}
            calendar={session.capabilities.calendar}
            sheets={
              session.capabilities.sheets && (session.user.isOwner || can(session.actor, "leads.import"))
            }
          />
        );
      case "done":
        return (
          <DonePanel
            firstName={firstName}
            lead={
              isAdmin
                ? "Your workspace is in good shape. Want a two-minute tour, including the admin tools?"
                : "Want a two-minute tour of the places you’ll use most? You can replay it any time from Settings."
            }
            summary={[
              { label: "Timezone", value: timezone || "UTC" },
              { label: "Look", value: THEME_NAME[theme] },
              {
                label: "Your day",
                value: dayPreview(prefs.workingDays, prefs.workStart, prefs.workEnd, prefs.digestTime),
              },
            ]}
          />
        );
    }
  })();

  const primaryLabel =
    step.id === "secure"
      ? codes
        ? "Continue"
        : "Verify"
      : step.id === "pipeline"
        ? "Looks good"
        : "Continue";
  const primaryDisabled =
    step.id === "secure"
      ? codes
        ? !saved
        : code.length !== 6 || !enrolment || enrolment === "failed"
      : false;
  const offset = reduce ? 0 : 26 * direction;

  return (
    <div className={s.sheet} role="dialog" aria-modal="true" aria-label={`Welcome to LUME, ${firstName}`}>
      <Rail
        steps={steps}
        index={index}
        reached={reached}
        lockedAfter={lockedAfter}
        businessName={businessName}
        onJump={go}
      />
      <section className={s.pane} ref={pane} data-more={more || undefined}>
        <AnimatePresence initial={false} custom={direction}>
          <motion.div
            key={step.id}
            data-panel={step.id}
            className={s.panel}
            initial={{ opacity: 0, x: offset }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -offset }}
            transition={toMotion(SPRINGS.default)}
            onScroll={(e) => {
              const el = e.currentTarget;
              setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 8);
            }}
          >
            <div>{panel}</div>
          </motion.div>
        </AnimatePresence>
        <div className={s.footBar}>
          {error && (
            <p role="alert" className={s.footAlert}>
              {error}
            </p>
          )}
          {step.id === "welcome" ? (
            <>
              <span className={s.estimate}>About {steps.length > 7 ? "2 minutes" : "1 minute"}</span>
              <Button variant="primary" onClick={forward}>
                Let’s go
                <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden className={s.arrow}>
                  <path
                    d="M3 7h8M7.5 3.5 11 7l-3.5 3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Button>
            </>
          ) : step.id === "done" ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => void finish(false)}>
                Explore on my own
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void finish(true)}>
                Take the tour
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => go(index - 1)}>
                Back
              </Button>
              <span className={s.footRight}>
                {!step.required && (
                  <Button variant="ghost" disabled={busy} onClick={skip}>
                    {SKIP_LABEL[step.id] ?? "Skip"}
                  </Button>
                )}
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={primaryDisabled}
                  onClick={() => void primary()}
                >
                  {primaryLabel}
                </Button>
              </span>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
