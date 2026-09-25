"use client";
import { useRef, useState } from "react";
import { currencyCountry } from "@lume/core/shared";
import { currencyName, searchCurrencies } from "./currencies";
import { Chevron } from "./PhoneInput";
import { Flag, SearchList } from "./SearchList";
import s from "./Picker.module.css";

/**
 * A currency on its own (the business currency in setup and settings): its flag, name and code, and
 * a searchable list of every currency in use.
 */
export function CurrencyPicker({
  id,
  label,
  value,
  onChange,
}: {
  id?: string;
  /** What it is for, read before the value ("Currency: Indian Rupee, INR"). */
  label: string;
  value: string;
  onChange: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className={s.select}
        aria-label={`${label}: ${currencyName(value)}, ${value}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Flag iso={currencyCountry(value)} />
        <span className={s.selectLabel}>{currencyName(value)}</span>
        <span className={s.muted}>{value}</span>
        <Chevron />
      </button>
      {open && (
        <SearchList
          anchor={button}
          search={(q) => searchCurrencies(q, value)}
          selected={value}
          searchLabel="Search currencies"
          listLabel="Currencies"
          placeholder="Currency, code or symbol"
          emptyText={(q) => `No currency matches “${q}”`}
          onPick={(item) => {
            onChange(item.id);
            setOpen(false);
            button.current?.focus();
          }}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) button.current?.focus();
          }}
        />
      )}
    </>
  );
}
