"use client";
import { useRef, useState } from "react";
import { Chevron, countries, searchCountries } from "./PhoneInput";
import { Flag, SearchList } from "./SearchList";
import s from "./Picker.module.css";

/** A country on its own (where most leads are, in setup and settings): flag, name, and a searchable list. */
export function CountryPicker({
  id,
  label,
  value,
  onChange,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (iso: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const all = countries();
  const current = all.find((c) => c.iso === value);
  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className={s.select}
        aria-label={`${label}: ${current?.name ?? "choose a country"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Flag iso={current?.iso} />
        <span className={s.selectLabel}>{current?.name ?? "Choose a country"}</span>
        <Chevron />
      </button>
      {open && (
        <SearchList
          anchor={button}
          search={(q) =>
            searchCountries(all, q, value).map((c) => ({ id: c.iso, label: c.name, flag: c.iso }))
          }
          selected={value}
          searchLabel="Search countries"
          listLabel="Countries"
          placeholder="Country"
          emptyText={(q) => `No country matches “${q}”`}
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
