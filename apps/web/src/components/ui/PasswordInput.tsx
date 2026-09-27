"use client";
import {
  useId,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type FocusEvent,
} from "react";
import s from "./PasswordInput.module.css";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

/**
 * A password field with an eye to see what was typed, and a quiet "Caps Lock is on" while it is. Every
 * password LUME asks for uses it, so they all behave the same. Caps Lock is read from the keyboard's own
 * state on each key press and click, so it's right even when Caps Lock was switched on elsewhere.
 */
export function PasswordInput({ className, onKeyDown, onKeyUp, onPointerDown, onBlur, ...input }: Props) {
  const capsId = useId();
  const [shown, setShown] = useState(false);
  const [caps, setCaps] = useState(false);
  const read = (e: KeyboardEvent<HTMLInputElement> | PointerEvent<HTMLInputElement>) =>
    setCaps(typeof e.getModifierState === "function" && e.getModifierState("CapsLock"));
  const describedBy =
    [input["aria-describedby"], caps ? capsId : null].filter(Boolean).join(" ") || undefined;

  return (
    <>
      <span className={s.wrap}>
        <input
          {...input}
          type={shown ? "text" : "password"}
          className={[className, s.input].filter(Boolean).join(" ")}
          aria-describedby={describedBy}
          onKeyDown={(e) => {
            read(e);
            onKeyDown?.(e);
          }}
          onKeyUp={(e) => {
            read(e);
            onKeyUp?.(e);
          }}
          onPointerDown={(e) => {
            read(e);
            onPointerDown?.(e);
          }}
          onBlur={(e: FocusEvent<HTMLInputElement>) => {
            setCaps(false);
            onBlur?.(e);
          }}
        />
        <button
          type="button"
          className={s.eye}
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          aria-controls={input.id}
          // The eye doesn't take the cursor out of the field: typing carries on where it was.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => setShown((v) => !v)}
        >
          <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden>
            <path
              d="M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
            {shown && (
              <path d="M3.5 16.5 16.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </span>
      {caps && (
        <p id={capsId} role="status" className={s.caps}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
            <path
              d="M8 2.5 3 8h3v3h4V8h3L8 2.5ZM6 13h4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </svg>
          Caps Lock is on
        </p>
      )}
    </>
  );
}
