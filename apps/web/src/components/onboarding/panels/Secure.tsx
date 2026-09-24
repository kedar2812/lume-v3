import { OtpInput } from "@/components/auth/OtpInput";
import { QrCode } from "@/components/setup/QrCode";
import { RecoveryCodeList } from "@/components/setup/RecoveryCodes";
import s from "../onboarding.module.css";
import { PanelHead } from "./Head";

/**
 * Required for anyone whose role needs two-step sign-in. The code is checked by the footer's Verify;
 * then the recovery codes appear once, and Continue waits for "I've saved these".
 */
export function SecurePanel({
  kicker,
  enrolment,
  codes,
  saved,
  onSaved,
  onCode,
  otpKey,
  busy,
  onRetry,
}: {
  kicker: string;
  enrolment: { secret: string; otpauthUri: string } | null | "failed";
  codes: string[] | null;
  saved: boolean;
  onSaved: (v: boolean) => void;
  onCode: (code: string) => void;
  otpKey: number;
  busy: boolean;
  onRetry: () => void;
}) {
  if (codes)
    return (
      <>
        <PanelHead
          kicker={kicker}
          title="Save your recovery codes"
          lead="Two-step sign-in is on. Each code below signs you in once if you ever lose your phone, and LUME can’t show them again."
        />
        <div className={s.codesWrap}>
          <RecoveryCodeList codes={codes} saved={saved} onSavedChange={onSaved} />
        </div>
      </>
    );
  return (
    <>
      <PanelHead
        kicker={kicker}
        title="Secure your account"
        lead="Your role can see and change things that matter, so LUME asks for a code from your phone each time you sign in."
      />
      {enrolment === "failed" ? (
        <p className={s.inlineNote}>
          LUME couldn’t start two-step setup.{" "}
          <button type="button" className={s.linkish} onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : (
        <div className={s.secure}>
          <div className={s.qrSlot}>{enrolment && <QrCode text={enrolment.otpauthUri} size={150} />}</div>
          <div>
            <ol className={s.howto}>
              <li>
                Open <b>Google Authenticator</b>, <b>1Password</b> or any authenticator app.
              </li>
              <li>Scan this code.</li>
              <li>Type the 6-digit code it shows.</li>
            </ol>
            <OtpInput key={otpKey} label="6-digit code" onChange={onCode} disabled={busy || !enrolment} />
            {enrolment && (
              <p className={s.clock}>
                Can’t scan? Enter this key: <code className={s.key}>{enrolment.secret}</code>
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
