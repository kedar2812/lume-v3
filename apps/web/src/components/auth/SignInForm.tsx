"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import type { AuthStep, SignInResult } from "@/lib/auth-client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { OtpInput } from "./OtpInput";
import s from "./auth.module.css";

type Props = {
  businessName: string;
  onSignIn(email: string, password: string): Promise<SignInResult>;
  onVerify(code: string): Promise<AuthStep>;
  onVerifyRecovery(code: string): Promise<AuthStep>;
  onSuccess(): void;
};

const MESSAGES = {
  invalid: "That email and password don’t match. Try again.",
  unavailable: "LUME can’t reach the server right now. Try again in a moment.",
  otp: "That code didn’t work. Check your authenticator app and try again.",
  recovery: "That recovery code didn’t work. Each code works only once.",
} as const;

/** "Try again in 15 minutes" is kinder, and more honest, than "try again later". */
const lockedMessage = (retryAfterSec: number | undefined): string => {
  if (!retryAfterSec) return "Too many attempts. Wait a few minutes, then try again.";
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
};

export function SignInForm({ businessName, onSignIn, onVerify, onVerifyRecovery, onSuccess }: Props) {
  const [step, setStep] = useState<"password" | "otp" | "recovery">("password");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otpKey, setOtpKey] = useState(0);
  const card = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  const shake = () => {
    const el = card.current;
    if (!el || reduce) return;
    el.classList.remove(s.shake!);
    void el.offsetWidth;
    el.classList.add(s.shake!);
  };

  const fail = (message: string) => {
    setError(message);
    shake();
  };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const r = await onSignIn(String(f.get("email") ?? ""), String(f.get("password") ?? ""));
    setBusy(false);
    if (r.status === "ok") return onSuccess();
    if (r.status === "otp_required") return setStep("otp");
    fail(r.status === "locked" ? lockedMessage(r.retryAfterSec) : MESSAGES[r.status]);
  }

  async function verify(code: string) {
    setBusy(true);
    setError(null);
    const r = await onVerify(code);
    setBusy(false);
    if (r === "ok") return onSuccess();
    setOtpKey((k) => k + 1);
    fail(r === "invalid" ? MESSAGES.otp : r === "locked" ? lockedMessage(undefined) : MESSAGES.unavailable);
  }

  async function useRecoveryCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("recovery") ?? "");
    setBusy(true);
    setError(null);
    const r = await onVerifyRecovery(code);
    setBusy(false);
    if (r === "ok") return onSuccess();
    fail(
      r === "invalid" ? MESSAGES.recovery : r === "locked" ? lockedMessage(undefined) : MESSAGES.unavailable,
    );
  }

  const errorLine = (id: string, center = false) =>
    error && (
      <p
        id={id}
        role="alert"
        className={s.error}
        style={center ? { textAlign: "center", marginTop: 10 } : undefined}
      >
        {error}
      </p>
    );

  return (
    <div className={s.wrap}>
      {/* Page-load entrance is CSS (auth.module.css): it applies before first paint, so the server-rendered
          HTML and the client agree, and prefers-reduced-motion switches it off natively. */}
      <img src="/lume-mark.png" alt="" className={s.mark} />
      <div className={s.brand}>
        <h1>LUME</h1>
        <p>{businessName}</p>
      </div>
      <div ref={card} className={s.card}>
        <AnimatePresence mode="wait" initial={false}>
          {step === "password" ? (
            <motion.form
              key="pw"
              onSubmit={submit}
              noValidate
              initial={{ opacity: 0, x: -24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={toMotion(SPRINGS.default)}
            >
              <div className={s.field}>
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  className={s.input}
                />
              </div>
              <div className={s.field}>
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  className={s.input}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "signin-error" : undefined}
                />
              </div>
              {errorLine("signin-error")}
              <Button type="submit" variant="primary" className={s.submit} loading={busy}>
                Sign in
              </Button>
              <div className={s.fine}>
                <span>Private workspace. Invite only.</span>
                <a href="/forgot">Forgot your password?</a>
              </div>
            </motion.form>
          ) : step === "otp" ? (
            <motion.div
              key="otp"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={toMotion(SPRINGS.default)}
            >
              <p className={s.otpTitle}>Two-step check</p>
              <p className={s.otpSub}>Enter the 6-digit code from your authenticator app.</p>
              <OtpInput key={otpKey} onComplete={verify} disabled={busy} />
              {errorLine("otp-error", true)}
              <div className={s.fine} style={{ justifyContent: "center" }}>
                <button
                  type="button"
                  className={s.linkish}
                  onClick={() => (setError(null), setStep("recovery"))}
                >
                  Lost your phone? Use a recovery code instead
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.form
              key="recovery"
              onSubmit={useRecoveryCode}
              noValidate
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={toMotion(SPRINGS.default)}
            >
              <p className={s.otpTitle}>Recovery code</p>
              <p className={s.otpSub}>One of the codes you saved when you set up two-step sign-in.</p>
              <div className={s.field}>
                <label htmlFor="recovery">Recovery code</label>
                <input
                  id="recovery"
                  name="recovery"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="XXXXX-XXXXX"
                  required
                  className={s.input}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "recovery-error" : undefined}
                />
              </div>
              {errorLine("recovery-error")}
              <Button type="submit" variant="primary" className={s.submit} loading={busy}>
                Use code
              </Button>
              <div className={s.fine} style={{ justifyContent: "center" }}>
                <button type="button" className={s.linkish} onClick={() => (setError(null), setStep("otp"))}>
                  Back to the app code
                </button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
