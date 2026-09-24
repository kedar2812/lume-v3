"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import s from "@/components/auth/auth.module.css";
import { requestPasswordReset } from "@/lib/auth-client";

/**
 * The answer is the same whether or not the address has an account (report §12.1), so this screen
 * cannot be used to find out who works here.
 */
export function ForgotForm({ businessName }: { businessName: string }) {
  const [state, setState] = useState<"form" | "sent" | "unavailable">("form");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    const r = await requestPasswordReset(email);
    setBusy(false);
    setState(r === "sent" ? "sent" : "unavailable");
  }

  return (
    <div className={s.wrap}>
      <img src="/lume-mark.png" alt="" className={s.mark} />
      <div className={s.brand}>
        <h1>LUME</h1>
        <p>{businessName}</p>
      </div>
      <div className={s.card}>
        {state === "sent" ? (
          <div className={s.done}>
            <p className={s.doneTitle}>Check your email</p>
            <p className={s.doneText}>
              If that address has an account, a reset link is on its way. It expires in 30 minutes.
            </p>
            <a className={s.linkish} href="/sign-in">
              Back to sign in
            </a>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <p className={s.otpTitle}>Reset your password</p>
            <p className={s.otpSub}>We’ll email you a link to choose a new one.</p>
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
            {state === "unavailable" && (
              <p role="alert" className={s.error}>
                LUME can’t reach the server right now. Try again in a moment.
              </p>
            )}
            <Button type="submit" variant="primary" className={s.submit} loading={busy}>
              Send the link
            </Button>
            <div className={s.fine} style={{ justifyContent: "center" }}>
              <a href="/sign-in">Back to sign in</a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
