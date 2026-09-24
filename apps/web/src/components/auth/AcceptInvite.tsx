"use client";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import s from "@/components/auth/auth.module.css";
import { passwordProblemText, type AcceptResult } from "@/lib/auth-client";
import { PasswordField } from "./PasswordField";

export type Invite = { email: string; name: string; businessName: string };

/** The invited person chooses a password; the address is fixed by the invite and cannot be edited. */
export function AcceptInvite({
  invite,
  onAccept,
  onDone,
}: {
  invite: Invite;
  onAccept(password: string): Promise<AcceptResult>;
  onDone(): void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await onAccept(password);
    setBusy(false);
    if (r.status === "ok") return onDone();
    if (r.status === "gone") {
      setGone(true);
      setError("This invite has already been used or has expired. Ask for a new one.");
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
        <p>{invite.businessName}</p>
      </div>
      <div className={s.card}>
        <form onSubmit={submit} noValidate>
          <p className={s.otpTitle}>You’re invited</p>
          <p className={s.otpSub}>Choose a password and you’re in, {invite.name.split(" ")[0]}.</p>
          <div className={s.field}>
            <label htmlFor="invite-email">Email</label>
            <input id="invite-email" className={s.input} value={invite.email} disabled readOnly />
          </div>
          <PasswordField
            label="Choose a password"
            name="password"
            value={password}
            onChange={setPassword}
            error={error}
          />
          {gone && (
            <div className={s.fine} style={{ justifyContent: "center" }}>
              <a href="/sign-in">Back to sign in</a>
            </div>
          )}
          <Button type="submit" variant="primary" className={s.submit} loading={busy} disabled={gone}>
            Join LUME
          </Button>
        </form>
      </div>
    </div>
  );
}
