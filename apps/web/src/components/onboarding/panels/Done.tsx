import s from "../onboarding.module.css";

export function DonePanel({
  firstName,
  lead,
  summary,
}: {
  firstName: string;
  lead: string;
  summary: { label: string; value: string }[];
}) {
  return (
    <>
      <span className={s.check} aria-hidden>
        <svg viewBox="0 0 24 24" width="28" height="28">
          <path
            d="M5 12.5 10 17l9-10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <h1 className={s.title} tabIndex={-1}>
        You’re all set, {firstName}
      </h1>
      <p className={s.lead}>{lead}</p>
      <dl className={s.recap}>
        {summary.map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
