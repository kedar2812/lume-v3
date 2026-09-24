import s from "@/components/auth/auth.module.css";

export default function InviteNotFound() {
  return (
    <div className={s.page}>
      <div className={s.aura} aria-hidden>
        <i />
        <i />
      </div>
      <div className={s.wrap}>
        <img src="/lume-mark.png" alt="" className={s.mark} />
        <div className={s.brand}>
          <h1>LUME</h1>
          <p>Invite</p>
        </div>
        <div className={s.card}>
          <div className={s.done}>
            <p className={s.doneTitle}>This link is no longer valid</p>
            <p className={s.doneText}>
              Invites last 72 hours and can be used once. Ask whoever invited you to send a new one.
            </p>
            <a className={s.linkish} href="/sign-in">
              Go to sign in
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
