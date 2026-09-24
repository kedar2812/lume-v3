"use client";
import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import s from "./auth.module.css";

/**
 * Six boxes for a two-step code, with paste support. `onComplete` fires once all digits are in (sign-in
 * submits on it); `onChange` reports every edit (setup, where a button submits instead).
 */
export function OtpInput({
  length = 6,
  onComplete,
  onChange,
  label = "Two-step code",
  disabled = false,
}: {
  length?: number;
  onComplete?(code: string): void;
  onChange?(code: string): void;
  label?: string;
  disabled?: boolean;
}) {
  const [digits, setDigits] = useState<string[]>(() => Array(length).fill(""));
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const done = useRef(false);

  function commit(next: string[]) {
    setDigits(next);
    onChange?.(next.join(""));
    if (next.every(Boolean) && !done.current) {
      done.current = true;
      onComplete?.(next.join(""));
    }
    if (!next.every(Boolean)) done.current = false;
  }

  function onKeyDown(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      e.preventDefault();
      const next = [...digits];
      if (next[i]) next[i] = "";
      else if (i > 0) {
        next[i - 1] = "";
        refs.current[i - 1]?.focus();
      }
      commit(next);
      return;
    }
    if (!/^\d$/.test(e.key)) return;
    e.preventDefault();
    const next = [...digits];
    next[i] = e.key;
    commit(next);
    refs.current[Math.min(i + 1, length - 1)]?.focus();
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const code = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (code.length !== length) return;
    e.preventDefault();
    commit(code.split(""));
    refs.current[length - 1]?.focus();
  }

  return (
    <div className={s.otp} role="group" aria-label={label}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1} of ${length}`}
          maxLength={1}
          disabled={disabled}
          onChange={() => undefined}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
        />
      ))}
    </div>
  );
}
