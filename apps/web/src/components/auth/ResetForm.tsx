"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import s from "@/components/auth/auth.module.css";
import { passwordProblemText, type ResetResult } from "@/lib/auth-client";
import { PasswordField } from "./PasswordField";

export function ResetForm({
  businessName,
  onReset,
  onDone,
}: {
  businessName: string;
  onReset(password: string): Promise<ResetResult>;
  onDone(): void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await onReset(password);
    setBusy(false);
    if (r.status === "ok") {
      setSaved(true);
      onDone();
      return;
    }
    if (r.status === "expired") {
      setExpired(true);
      setError("That link has expired or has already been used.");
      return;
    }
    setError(
      r.status === "weak"
        ? passwordProblemText(r.problems)
        : "LUME can’t reach the server right now. Try again in a moment.",
    );
  }

  return (
    <div className={s.wrap}>
      <img src="/lume-mark.png" alt="" className={s.mark} />
      <div className={s.brand}>
        <h1>LUME</h1>
        {businessName && <p>{businessName}</p>}
      </div>
      <div className={s.card}>
        {saved ? (
          <div className={s.done}>
            <p className={s.doneTitle}>Password saved</p>
            <p className={s.doneText}>Sign in with your new password.</p>
          </div>
        ) : (
          <form method="post" onSubmit={submit} noValidate>
            <p className={s.otpTitle}>Choose a new password</p>
            <p className={s.otpSub}>This also signs you out everywhere else.</p>
            <PasswordField
              label="New password"
              name="password"
              value={password}
              onChange={setPassword}
              error={error}
            />
            {expired && (
              <div className={s.fine} style={{ justifyContent: "center" }}>
                <a href="/forgot">Ask for a new link</a>
              </div>
            )}
            <Button type="submit" variant="primary" className={s.submit} loading={busy} disabled={expired}>
              Save password
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
