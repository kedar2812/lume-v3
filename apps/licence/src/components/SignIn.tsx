"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import s from "./signin.module.css";

type Step = "password" | "code" | "done";

/** The dark two-step sign-in (canvas: AdminSignIn): a password, then the six digits. Only you; every sign-in is logged. */
export function SignIn() {
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [welcome, setWelcome] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === "code") codeInput.current?.focus();
  }, [step]);

  const toCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const r = await api.post<{ next: "code" }>("/api/auth/password", { email, password });
    setBusy(false);
    if (r.ok) setStep("code");
    else setError(r.message);
  };

  const finish = async (digits: string) => {
    setBusy(true);
    const r = await api.post<{ ok: true }>("/api/auth/code", { code: digits });
    if (!r.ok) {
      setBusy(false);
      setError(r.message);
      setCode("");
      setPassword("");
      setStep("password");
      emailInput.current?.focus();
      return;
    }
    const [c, a] = await Promise.all([
      api.get<{ clients: unknown[] }>("/api/clients"),
      api.get<{ alerts: unknown[] }>("/api/alerts"),
    ]);
    const clients = c.ok ? c.data.clients.length : 0;
    const alerts = a.ok ? a.data.alerts.length : 0;
    setWelcome(
      `${clients} ${clients === 1 ? "client" : "clients"} · ${alerts === 0 ? "nothing needs a look" : alerts === 1 ? "1 thing needs a look" : `${alerts} things need a look`}`,
    );
    setBusy(false);
    setStep("done");
  };

  const typed = (v: string) => {
    const digits = v.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && !busy) void finish(digits);
  };

  return (
    <div className={s.page}>
      <div className={s.card}>
        <div className={s.brand}>
          <img src="/lume-mark.png" alt="" width={40} height={40} />
          <div>
            <b>LUME Licences</b>
            <small>license.lumecrm.in</small>
          </div>
        </div>

        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}

        {step === "password" && (
          <form className={s.step} onSubmit={(e) => void toCode(e)}>
            <label className={s.field}>
              Email
              <input
                ref={emailInput}
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className={s.field}>
              Password
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button type="submit" className={s.btn} disabled={busy}>
              {busy ? "Checking…" : "Continue"}
            </button>
          </form>
        )}

        {step === "code" && (
          <div className={s.step}>
            <div className={s.words}>
              <b>Two-step sign-in</b>
              <span>Type the six digits your authenticator shows for LUME Licences.</span>
            </div>
            <label className={s.boxes}>
              <span className="sr">Code</span>
              {[0, 1, 2, 3, 4, 5].map((k) => (
                <span
                  key={k}
                  className={s.box}
                  data-current={k === code.length && !busy ? "" : undefined}
                  aria-hidden
                >
                  {code[k] && <span className={s.digit}>{code[k]}</span>}
                </span>
              ))}
              <input
                ref={codeInput}
                className={s.hidden}
                value={code}
                onChange={(e) => typed(e.target.value)}
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                aria-label="Code"
              />
            </label>
            <span className={s.hint}>{busy ? "Checking…" : "The code changes every 30 seconds."}</span>
          </div>
        )}

        {step === "done" && (
          <div className={s.done}>
            <span className={s.ok} aria-hidden>
              <svg
                width="28"
                height="28"
                viewBox="0 0 28 28"
                fill="none"
                stroke="#fff"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path className={s.draw} d="M7 14.5l5 5 9-11" />
              </svg>
            </span>
            <b>Welcome back</b>
            <span>{welcome}</span>
            <Link href="/clients" className={s.open}>
              Open clients
            </Link>
          </div>
        )}
      </div>
      <p className={s.foot}>Only you. Every sign-in is logged.</p>
    </div>
  );
}
