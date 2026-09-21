"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import type { SignInResult } from "@/lib/auth-client";
import { SPRINGS, toMotion } from "@/lib/motion";
import { OtpInput } from "./OtpInput";
import s from "./auth.module.css";

type Props = {
  businessName: string;
  onSignIn(email: string, password: string): Promise<SignInResult>;
  onVerify(code: string): Promise<"ok" | "invalid" | "unavailable">;
  onSuccess(): void;
};

const MESSAGES = {
  invalid: "That email and password don’t match. Try again.",
  locked: "Too many attempts. Wait a few minutes, then try again.",
  unavailable: "LUME can’t reach the server right now. Try again in a moment.",
  otp: "That code didn’t work. Check your authenticator app and try again.",
} as const;

export function SignInForm({ businessName, onSignIn, onVerify, onSuccess }: Props) {
  const [step, setStep] = useState<"password" | "otp">("password");
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

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const r = await onSignIn(String(f.get("email") ?? ""), String(f.get("password") ?? ""));
    setBusy(false);
    if (r.status === "ok") return onSuccess();
    if (r.status === "otp_required") return setStep("otp");
    setError(MESSAGES[r.status]);
    shake();
  }

  async function verify(code: string) {
    setBusy(true);
    setError(null);
    const r = await onVerify(code);
    setBusy(false);
    if (r === "ok") return onSuccess();
    setError(r === "invalid" ? MESSAGES.otp : MESSAGES.unavailable);
    setOtpKey((k) => k + 1);
    shake();
  }

  const bloom = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : {
        initial: { opacity: 0, scale: 0.35, rotate: -120, filter: "blur(8px)" },
        animate: { opacity: 1, scale: 1, rotate: 0, filter: "blur(0px)" },
      };

  return (
    <div className={s.wrap}>
      <motion.img
        src="/lume-mark.png"
        alt=""
        className={s.mark}
        {...bloom}
        transition={{ ...toMotion(SPRINGS.bounce), visualDuration: 1.1 }}
      />
      <motion.div
        className={s.brand}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...toMotion(SPRINGS.soft), delay: reduce ? 0 : 0.35 }}
      >
        <h1>LUME</h1>
        <p>{businessName}</p>
      </motion.div>
      <motion.div
        ref={card}
        className={s.card}
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ ...toMotion(SPRINGS.soft), delay: reduce ? 0 : 0.56 }}
      >
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
              {error && (
                <p id="signin-error" role="alert" className={s.error}>
                  {error}
                </p>
              )}
              <Button type="submit" variant="primary" className={s.submit} loading={busy}>
                Sign in
              </Button>
              <div className={s.fine}>
                <span>Private workspace. Invite only.</span>
                <a href="/forgot-password">Forgot password?</a>
              </div>
            </motion.form>
          ) : (
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
              {error && (
                <p role="alert" className={s.error} style={{ textAlign: "center", marginTop: 10 }}>
                  {error}
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
