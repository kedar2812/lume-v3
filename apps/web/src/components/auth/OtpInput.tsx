"use client";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import s from "./auth.module.css";

/**
 * Six boxes for a two-step code, with paste support. `onComplete` fires once all digits are in (sign-in
 * submits on it); `onChange` reports every edit (setup, where a button submits instead). With `autoFocus` the first box
 * is ready to type into as it appears, and again whenever it's enabled after a check (owner 2026-11-02: no click first).
 */
export function OtpInput({
  length = 6,
  onComplete,
  onChange,
  label = "Two-step code",
  disabled = false,
  autoFocus = false,
}: {
  length?: number;
  onComplete?(code: string): void;
  onChange?(code: string): void;
  label?: string;
  disabled?: boolean;
  /** Where the code is the screen's one task (sign-in, setting up two-step); never in a sheet whose password comes first. */
  autoFocus?: boolean;
}) {
  const [digits, setDigits] = useState<string[]>(() => Array(length).fill(""));
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const done = useRef(false);
  const digitsNow = useRef(digits);
  digitsNow.current = digits;

  // On arrival, and when a check that disabled the boxes is over: the first empty box, ready for the next digit.
  useEffect(() => {
    if (!autoFocus || disabled) return;
    const i = digitsNow.current.findIndex((d) => !d);
    refs.current[i === -1 ? length - 1 : i]?.focus();
  }, [autoFocus, disabled, length]);

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

  /**
   * What a keyboard that doesn't name its keys types (Android's reports "Unidentified"), and a whole code an autofill puts
   * in one box (iPhone's one-time code): the digits that arrived, from this box on.
   */
  function onInput(i: number, e: ChangeEvent<HTMLInputElement>) {
    const typed = e.target.value.replace(/\D/g, "");
    if (!typed) return;
    if (typed.length >= length) {
      commit(typed.slice(0, length).split(""));
      refs.current[length - 1]?.focus();
      return;
    }
    // The box held a digit already: the new one is what was added to it.
    const add = (digits[i] && typed.startsWith(digits[i]!) ? typed.slice(digits[i]!.length) : typed).split(
      "",
    );
    const next = [...digits];
    add.forEach((d, k) => {
      if (i + k < length) next[i + k] = d;
    });
    commit(next);
    refs.current[Math.min(i + add.length, length - 1)]?.focus();
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
          disabled={disabled}
          onChange={(e) => onInput(i, e)}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={onPaste}
        />
      ))}
    </div>
  );
}
