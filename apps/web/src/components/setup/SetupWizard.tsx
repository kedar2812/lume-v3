"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { OtpInput } from "@/components/auth/OtpInput";
import { PasswordField } from "@/components/auth/PasswordField";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { TimezonePicker } from "@/components/ui/TimezonePicker";
import { passwordProblemText } from "@/lib/auth-client";
import { SPRINGS, toMotion } from "@/lib/motion";
import type { KeyAnswer, KeyLicence, SetupInput, SetupResult } from "@/lib/setup-client";
import { CountryPicker } from "@/components/ui/CountryPicker";
import { CurrencyPicker } from "@/components/ui/CurrencyPicker";
import { guessRegion, guessTimezone } from "@/lib/timezones";
import { KeyStep } from "./KeyStep";
import { OnlineMoment } from "./OnlineMoment";
import { QrCode } from "./QrCode";
import { RecoveryCodes } from "./RecoveryCodes";
import s from "./setup.module.css";

type Props = {
  onStartTotp(token: string): Promise<{ secret: string; otpauthUri: string } | { error: string }>;
  onComplete(input: SetupInput): Promise<SetupResult>;
  onDone(): void;
  /** A client's install (spec 2026-10-15 §1.1): the first step is the product key, not the setup token. */
  needsKey?: boolean;
  onActivateKey?(key: string): Promise<KeyAnswer>;
  /** The "your LUME is online" moment starts (true) and ends (false): the screen steps its own mark aside. */
  onCelebrate?(on: boolean): void;
};

const STEPS = 4;
// The generic starter comes first and is the default (licensing spec §0 rule 4); industry starters are a choice.
const PRESETS = [
  {
    id: "general" as const,
    name: "General sales",
    detail: "New → Contacted → Qualified → Proposal → Won / Lost. A plain pipeline you can rename later.",
  },
  {
    id: "coaching" as const,
    name: "Coaching / consulting",
    detail:
      "New → Message sent → Replied → Call booked → Call done → Follow-up later → Won / Lost, plus Struggles and Handled by.",
  },
];

/**
 * First run, once per installation: the setup token from the server logs, the business, the owner,
 * and two-step sign-in — which is mandatory for the owner, so it is part of getting in rather than a
 * setting to find later (report §12.2). Nothing is written until the last step succeeds.
 */
export function SetupWizard({
  onStartTotp,
  onComplete,
  onDone,
  needsKey,
  onActivateKey,
  onCelebrate,
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3 | 4 | "online" | "codes">(1);
  const [licence, setLicence] = useState<KeyLicence | null>(null);
  const reduce = useReducedMotion() ?? false;
  const [token, setToken] = useState("");
  const [business, setBusiness] = useState({ name: "", timezone: "", currency: "", defaultCountry: "" });
  const [preset, setPreset] = useState<"coaching" | "general">("general");
  const [owner, setOwner] = useState({ name: "", email: "", password: "" });
  const [totp, setTotp] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);

  // After mount, because the server cannot know which zone this person is in.
  useEffect(() => {
    // Guesses from this browser (after mount: the server can't know them), each only if still unset.
    setBusiness((b) => {
      const region = guessRegion();
      return {
        ...b,
        timezone: b.timezone || guessTimezone(),
        currency: b.currency || region.currency,
        defaultCountry: b.defaultCountry || region.country,
      };
    });
  }, []);

  /** The token (typed, or unlocked by the product key) starts two-step; then on to the business. */
  async function startWith(t: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    const r = await onStartTotp(t);
    setBusy(false);
    if ("error" in r) {
      setError(r.error);
      return false;
    }
    setTotp(r);
    setStep(2);
    return true;
  }
  async function submitToken(e: FormEvent) {
    e.preventDefault();
    await startWith(token.trim());
  }
  /** Proceed to onboarding, from the moment: the key's token starts setup as a typed one would. */
  async function proceed() {
    onCelebrate?.(false);
    if (!(await startWith(token))) setStep(1);
  }

  async function finish(e: FormEvent) {
    e.preventDefault();
    if (!totp) return;
    setBusy(true);
    setError(null);
    const r = await onComplete({
      token: token.trim(),
      business,
      preset,
      owner,
      totp: { secret: totp.secret, code },
    });
    setBusy(false);
    if (r.status === "ok") {
      setCodes(r.recoveryCodes);
      return setStep("codes");
    }
    if (r.status === "weak") {
      setPasswordError(passwordProblemText(r.problems));
      return setStep(3);
    }
    if (r.status === "token") {
      setError(
        needsKey
          ? "This setup has expired. Enter your product key again to carry on."
          : "That setup token isn’t valid any more. Start again with the one in the server logs.",
      );
      return setStep(1);
    }
    setError(
      r.status === "code"
        ? "That code didn’t work. Check the time on your phone, then try the next one."
        : "LUME can’t reach the server right now. Try again in a moment.",
    );
  }

  const alert = error && (
    <p role="alert" className={s.error}>
      {error}
    </p>
  );

  const frame = (key: string, title: string, sub: string, body: ReactNode) => (
    <motion.div
      key={key}
      className={s.frame}
      initial={{ opacity: 0, x: 22 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -22 }}
      transition={toMotion(SPRINGS.default)}
    >
      <p className={s.title}>{title}</p>
      <p className={s.sub}>{sub}</p>
      {body}
    </motion.div>
  );

  const back = (to: 1 | 2 | 3) => (
    <Button
      onClick={() => {
        setError(null);
        setStep(to);
      }}
    >
      Back
    </Button>
  );

  return (
    <div className={s.card}>
      {step !== "codes" && step !== "online" && (
        <div className={s.progress}>
          <span className={s.count}>
            Step {step} of {STEPS}
          </span>
          <span className={s.track} aria-hidden>
            <i style={{ transform: `scaleX(${step / STEPS})` }} />
          </span>
        </div>
      )}
      <AnimatePresence mode="wait" initial={false}>
        {step === 1 &&
          needsKey &&
          onActivateKey &&
          frame(
            "key",
            "Your product key",
            "The key that came with your LUME. It ties this LUME to your licence, and it works on one server only.",
            <>
              <KeyStep
                onActivate={onActivateKey}
                onApproved={(t, l) => {
                  setToken(t);
                  setLicence(l);
                  setError(null);
                  setStep("online");
                  onCelebrate?.(true);
                }}
              />
              {alert}
            </>,
          )}

        {step === "online" && licence && (
          <motion.div key="online" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <OnlineMoment licence={licence} reduce={reduce} busy={busy} onProceed={() => void proceed()} />
          </motion.div>
        )}

        {step === 1 &&
          !needsKey &&
          frame(
            "token",
            "Let’s set up LUME",
            "LUME printed a setup token in the server logs when it started. Paste it here to prove this installation is yours.",
            <form method="post" onSubmit={submitToken} noValidate>
              <Field
                label="Setup token"
                error={error}
                hint="It looks like a long line of letters and numbers."
              >
                {(control) => (
                  <input
                    {...control}
                    name="token"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                )}
              </Field>
              <Button type="submit" variant="primary" className={s.submit} loading={busy}>
                Continue
              </Button>
            </form>,
          )}

        {step === 2 &&
          frame(
            "business",
            "About the business",
            "This names the workspace and sets the clock everything in LUME is measured against.",
            <form
              method="post"
              onSubmit={(e) => {
                e.preventDefault();
                setStep(3);
              }}
              noValidate
            >
              <Field label="Business name">
                {(control) => (
                  <input
                    {...control}
                    name="business"
                    required
                    value={business.name}
                    onChange={(e) => setBusiness({ ...business, name: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Timezone" hint="Every “today”, digest and reminder uses this zone.">
                {(control) => (
                  <TimezonePicker
                    control={control}
                    value={business.timezone}
                    onChange={(timezone) => setBusiness({ ...business, timezone })}
                  />
                )}
              </Field>
              <div className={s.pair}>
                <Field label="Currency">
                  {(control) => (
                    <CurrencyPicker
                      id={control.id}
                      label="Currency"
                      value={business.currency}
                      onChange={(currency) => setBusiness({ ...business, currency })}
                    />
                  )}
                </Field>
                <Field label="Most leads are in">
                  {(control) => (
                    <CountryPicker
                      id={control.id}
                      label="Most leads are in"
                      value={business.defaultCountry}
                      onChange={(defaultCountry) => setBusiness({ ...business, defaultCountry })}
                    />
                  )}
                </Field>
              </div>
              <p className={s.legend}>How you sell</p>
              <div className={s.presets} role="radiogroup" aria-label="How you sell">
                {PRESETS.map((p) => (
                  <label key={p.id} className={s.preset} data-on={preset === p.id || undefined}>
                    <input
                      type="radio"
                      name="preset"
                      value={p.id}
                      checked={preset === p.id}
                      onChange={() => setPreset(p.id)}
                    />
                    <span className={s.presetName}>{p.name}</span>
                    <span className={s.presetDetail}>{p.detail}</span>
                  </label>
                ))}
              </div>
              <p className={s.fine}>Both give you stages you can rename, reorder or add to in Settings.</p>
              <div className={s.row}>
                {!needsKey && back(1)}
                <Button type="submit" variant="primary" loading={busy}>
                  Continue
                </Button>
              </div>
            </form>,
          )}

        {step === 3 &&
          frame(
            "owner",
            "Your account",
            "You’ll be the owner: the one account that can never be locked out or removed.",
            <form
              method="post"
              onSubmit={(e) => {
                e.preventDefault();
                setPasswordError(null);
                setStep(4);
              }}
              noValidate
            >
              <Field label="Your name">
                {(control) => (
                  <input
                    {...control}
                    name="name"
                    autoComplete="name"
                    required
                    value={owner.name}
                    onChange={(e) => setOwner({ ...owner, name: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Email">
                {(control) => (
                  <input
                    {...control}
                    name="email"
                    type="email"
                    autoComplete="username"
                    required
                    value={owner.email}
                    onChange={(e) => setOwner({ ...owner, email: e.target.value })}
                  />
                )}
              </Field>
              <PasswordField
                label="Password"
                name="password"
                value={owner.password}
                onChange={(password) => setOwner({ ...owner, password })}
                error={passwordError}
              />
              <div className={s.row}>
                {back(2)}
                <Button type="submit" variant="primary">
                  Continue
                </Button>
              </div>
            </form>,
          )}

        {step === 4 &&
          frame(
            "totp",
            "Two-step sign-in",
            "Scan this with an authenticator app — Google Authenticator, 1Password, Authy. It’s required for the owner.",
            <form method="post" onSubmit={finish} noValidate>
              <div className={s.qrRow}>
                {totp && <QrCode text={totp.otpauthUri} />}
                <div>
                  <p className={s.fine}>Can’t scan? Type this key into the app instead:</p>
                  <code className={s.secret} data-testid="totp-secret">
                    {totp?.secret}
                  </code>
                </div>
              </div>
              <p className={s.legend} aria-hidden>
                6-digit code
              </p>
              <OtpInput label="6-digit code" onChange={setCode} disabled={busy} />
              {alert}
              <div className={s.row}>
                {back(3)}
                <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6}>
                  Finish setup
                </Button>
              </div>
            </form>,
          )}

        {step === "codes" && (
          <motion.div
            key="codes"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={toMotion(SPRINGS.default)}
          >
            <RecoveryCodes codes={codes} onDone={onDone} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
