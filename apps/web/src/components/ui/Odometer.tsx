import s from "./Odometer.module.css";

const DIGITS = "0123456789";

/** Numbers that roll digit-by-digit to their new value (spec §5.3). The full value is announced once. */
export function Odometer({
  value,
  format = String,
  label,
}: {
  value: number;
  format?: (n: number) => string;
  label?: string;
}) {
  const text = format(value);
  let digitIndex = 0;
  const digitCount = [...text].filter((c) => DIGITS.includes(c)).length;
  return (
    <span className={s.odo} aria-label={label ? `${label}: ${text}` : text} role="img">
      {[...text].map((c, i) => {
        if (!DIGITS.includes(c))
          return (
            <span key={`c${i}`} className={s.char} aria-hidden>
              {c}
            </span>
          );
        const delay = (digitCount - 1 - digitIndex++) * 35;
        return (
          <span key={`d${i}`} className={s.slot} aria-hidden>
            <span
              className={s.strip}
              data-digit={c}
              style={{ transform: `translateY(-${c}em)`, transitionDelay: `${delay}ms` }}
            >
              {[...DIGITS].map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
