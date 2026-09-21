const C = 2 * Math.PI * 27;

export function ProgressRing({ value, size = 64, label }: { value: number; size?: number; label: string }) {
  const v = Math.min(1, Math.max(0, value));
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      style={{ transform: "rotate(-90deg)" }}
    >
      <circle cx="32" cy="32" r="27" fill="none" strokeWidth="6" stroke="var(--line-2)" />
      <circle
        cx="32"
        cy="32"
        r="27"
        fill="none"
        strokeWidth="6"
        stroke="var(--ok)"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - v)}
        style={{ transition: "stroke-dashoffset 0.9s var(--spring-soft)" }}
      />
    </svg>
  );
}
