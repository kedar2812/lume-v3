import Link from "next/link";
import s from "./settings.module.css";

/**
 * Shown in place of a Settings page when its access was taken away while it was open (another admin
 * changed this person's role): calm words and a way back, never an error screen or a half-saved form.
 */
export function AccessChanged() {
  return (
    <div className={s.changed} role="alert">
      <h2>Your access to this page changed</h2>
      <p>An admin has changed what your role can do, so this page is no longer available to you.</p>
      <Link href="/settings" className={s.changedLink}>
        Back to Settings
      </Link>
    </div>
  );
}
