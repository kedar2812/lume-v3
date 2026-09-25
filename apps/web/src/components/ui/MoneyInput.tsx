"use client";
import { useId, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { currencyCountry } from "@lume/core/shared";
import { currencyName } from "./currencies";
import { Flag } from "./SearchList";
import s from "./Picker.module.css";

/**
 * An amount in the business currency. LUME uses one currency, chosen in setup and Settings, so the
 * currency sits in front as a fact, not a choice; the amount stays as typed until the form reads it.
 */
export function MoneyInput({
  id,
  amount,
  currency,
  onChange,
  size = "md",
  autoFocus,
  onKeyDown,
  ...aria
}: {
  id?: string;
  amount: string;
  /** The business currency's code. */
  currency: string;
  onChange: (amount: string) => void;
  size?: "md" | "sm";
  autoFocus?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
} & Pick<
  InputHTMLAttributes<HTMLInputElement>,
  "aria-invalid" | "aria-describedby" | "aria-label" | "onBlur"
>) {
  const noteId = useId();
  const describedBy = [aria["aria-describedby"], noteId].filter(Boolean).join(" ");
  return (
    <div className={s.field} data-size={size}>
      <span className={s.fixed}>
        <Flag iso={currencyCountry(currency)} />
        <span aria-hidden>{currency}</span>
        <span id={noteId} className={s.srOnly}>
          In {currencyName(currency)}
        </span>
      </span>
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        className={s.input}
        value={amount}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        {...aria}
        aria-describedby={describedBy}
      />
    </div>
  );
}
