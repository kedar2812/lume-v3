"use client";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { PhoneInput } from "@/components/ui/PhoneInput";
import { Switch } from "@/components/ui/Switch";
import type { FieldDefView } from "@/lib/leads/types";
import { useCatalog } from "../CatalogProvider";
import s from "./fields.module.css";

type Props = {
  def: FieldDefView;
  value: unknown;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
  autoFocus?: boolean;
  /** A message to show under the editor (the API's reason, when a save was refused). */
  error?: string | null;
  /**
   * In a form (the create sheet, the required-fields prompt), every change is reported and nothing
   * commits on its own: no Enter/blur commit, no Done button.
   */
  inForm?: boolean;
};

const INPUT_TYPE: Partial<Record<FieldDefView["type"], string>> = {
  email: "email",
  phone: "tel",
  url: "url",
};

/** Parse money or a number as a person types it ("4,750.50"). null for empty; a message when it's wrong. */
function parseNumber(raw: string, money: boolean): { value: number | null } | { error: string } {
  const t = raw.replace(/[\s,]/g, "");
  if (!t) return { value: null };
  const n = Number(t);
  if (!Number.isFinite(n)) return { error: "Enter a number" };
  if (money && n < 0) return { error: "Enter an amount of 0 or more" };
  if (money && Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { error: "Use at most two decimals" };
  return { value: n };
}

const toLocalInput = (iso: unknown) => {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
};

/**
 * One editor for any field type. Enter commits and Escape cancels; leaving the field commits a change and
 * cancels an untouched one. Every control is labelled with the field's name.
 */
export function FieldEditor({ def, value, onCommit, onCancel, autoFocus, error, inForm = false }: Props) {
  const catalog = useCatalog();
  const first = useRef<HTMLElement | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = problem ?? error ?? null;

  useEffect(() => {
    if (autoFocus) first.current?.focus();
  }, [autoFocus]);

  const keys = (commit: () => void) => (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Enter" && !inForm) {
      e.preventDefault();
      commit();
    }
  };

  const message = shown && (
    <p role="alert" className={s.error}>
      {shown}
    </p>
  );

  switch (def.type) {
    case "boolean":
      return (
        <div className={s.wrap}>
          <Switch label={def.label} checked={value === true} onChange={(v) => onCommit(v)} />
          {message}
        </div>
      );

    case "select":
    case "user": {
      const options =
        def.type === "user"
          ? catalog.people.filter((p) => p.active).map((p) => ({ id: p.id, label: p.name }))
          : def.options.filter((o) => !o.archived);
      return (
        <div className={s.wrap}>
          <select
            ref={(el) => {
              first.current = el;
            }}
            aria-label={def.label}
            className={s.control}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onCommit(e.target.value || null)}
            onKeyDown={keys(() => undefined)}
          >
            <option value="">{def.type === "user" ? "Nobody" : "—"}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          {message}
        </div>
      );
    }

    case "multi_select":
      return (
        <MultiEditor
          def={def}
          value={value}
          onCommit={onCommit}
          onCancel={onCancel}
          inForm={inForm}
          message={message}
          autoFocus={autoFocus}
        />
      );

    case "long_text":
      return (
        <TextEditor
          def={def}
          value={value}
          multiline
          onCommit={onCommit}
          onCancel={onCancel}
          setProblem={setProblem}
          inForm={inForm}
          message={message}
          focusRef={first}
        />
      );

    case "number":
    case "currency":
      if (def.isCore && def.key === "value")
        return (
          <MoneyEditor
            def={def}
            value={typeof value === "number" ? value : null}
            currency={catalog.currency}
            onCommit={onCommit}
            onCancel={onCancel}
            inForm={inForm}
            autoFocus={autoFocus}
            setProblem={setProblem}
            message={message}
          />
        );
      return (
        <TextEditor
          def={def}
          value={value === null || value === undefined ? "" : String(value)}
          parse={(raw) => parseNumber(raw, def.type === "currency")}
          inputMode="decimal"
          onCommit={onCommit}
          onCancel={onCancel}
          setProblem={setProblem}
          inForm={inForm}
          message={message}
          focusRef={first}
        />
      );

    case "phone":
      return (
        <PhoneEditor
          def={def}
          value={typeof value === "string" ? value : ""}
          defaultCountry={catalog.country}
          onCommit={onCommit}
          onCancel={onCancel}
          inForm={inForm}
          autoFocus={autoFocus}
          message={message}
        />
      );

    case "date":
    case "datetime": {
      const isDate = def.type === "date";
      const start = isDate ? (typeof value === "string" ? value.slice(0, 10) : "") : toLocalInput(value);
      return (
        <DateEditor
          label={def.label}
          type={isDate ? "date" : "datetime-local"}
          start={start}
          toValue={(raw) => (raw ? (isDate ? raw : new Date(raw).toISOString()) : null)}
          onCommit={onCommit}
          onCancel={onCancel}
          inForm={inForm}
          message={message}
          focusRef={first}
          keys={keys}
        />
      );
    }

    default:
      return (
        <TextEditor
          def={def}
          value={value}
          type={INPUT_TYPE[def.type]}
          onCommit={onCommit}
          onCancel={onCancel}
          setProblem={setProblem}
          inForm={inForm}
          message={message}
          focusRef={first}
        />
      );
  }
}

function TextEditor({
  def,
  value,
  multiline,
  type,
  inputMode,
  parse,
  onCommit,
  onCancel,
  setProblem,
  inForm,
  message,
  focusRef,
}: {
  def: FieldDefView;
  value: unknown;
  multiline?: boolean;
  type?: string;
  inputMode?: "decimal";
  parse?: (raw: string) => { value: unknown } | { error: string };
  onCommit: (v: unknown) => void;
  onCancel: () => void;
  setProblem: (m: string | null) => void;
  inForm: boolean;
  message: ReactNode;
  focusRef: MutableRefObject<HTMLElement | null>;
}) {
  const initial = value === null || value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);

  const result = (raw: string): { value: unknown } | { error: string } =>
    parse ? parse(raw) : { value: raw.trim() === "" ? null : raw.trim() };

  const commit = () => {
    if (done.current) return;
    const r = result(draft);
    if ("error" in r) return setProblem(r.error);
    setProblem(null);
    done.current = true;
    if (draft.trim() === initial.trim()) return onCancel();
    onCommit(r.value);
  };

  const change = (raw: string) => {
    setDraft(raw);
    if (!inForm) return;
    const r = result(raw);
    if ("error" in r) setProblem(r.error);
    else {
      setProblem(null);
      onCommit(r.value);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      done.current = true;
      return onCancel();
    }
    if (inForm) return;
    if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  };

  const common = {
    "aria-label": def.label,
    className: s.control,
    value: draft,
    onChange: (e: { target: { value: string } }) => change(e.target.value),
    onKeyDown,
    onBlur: inForm ? undefined : commit,
  };
  return (
    <div className={s.wrap}>
      {multiline ? (
        <textarea {...common} rows={3} ref={(el) => void (focusRef.current = el)} />
      ) : (
        <input
          {...common}
          type={type === "email" || type === "tel" || type === "url" ? type : "text"}
          inputMode={inputMode}
          ref={(el) => void (focusRef.current = el)}
        />
      )}
      {message}
    </div>
  );
}

function DateEditor({
  label,
  type,
  start,
  toValue,
  onCommit,
  onCancel,
  inForm,
  message,
  focusRef,
  keys,
}: {
  label: string;
  type: "date" | "datetime-local";
  start: string;
  toValue: (raw: string) => unknown;
  onCommit: (v: unknown) => void;
  onCancel: () => void;
  inForm: boolean;
  message: ReactNode;
  focusRef: MutableRefObject<HTMLElement | null>;
  keys: (commit: () => void) => (e: KeyboardEvent) => void;
}) {
  const [draft, setDraft] = useState(start);
  const commit = () => (draft === start ? onCancel() : onCommit(toValue(draft)));
  return (
    <div className={s.wrap}>
      <input
        type={type}
        aria-label={label}
        className={s.control}
        value={draft}
        ref={(el) => void (focusRef.current = el)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (inForm) onCommit(toValue(e.target.value));
        }}
        onKeyDown={keys(commit)}
        onBlur={inForm ? undefined : commit}
      />
      {message}
    </div>
  );
}

function MultiEditor({
  def,
  value,
  onCommit,
  onCancel,
  inForm,
  message,
  autoFocus,
}: {
  def: FieldDefView;
  value: unknown;
  onCommit: (v: unknown) => void;
  onCancel: () => void;
  inForm: boolean;
  message: ReactNode;
  autoFocus?: boolean;
}) {
  const live = def.options.filter((o) => !o.archived);
  const [picked, setPicked] = useState<string[]>(Array.isArray(value) ? (value as string[]) : []);
  const box = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    if (autoFocus) box.current?.querySelector("input")?.focus();
  }, [autoFocus]);
  // Ids in the options' own order, so the saved value never depends on click order.
  const ordered = (ids: string[]) => live.map((o) => o.id).filter((id) => ids.includes(id));
  const toggle = (id: string) => {
    const next = ordered(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
    setPicked(next);
    if (inForm) onCommit(next);
  };
  return (
    <fieldset
      ref={box}
      className={s.multi}
      aria-label={def.label}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {live.map((o) => (
        <label key={o.id} className={s.option}>
          <input type="checkbox" checked={picked.includes(o.id)} onChange={() => toggle(o.id)} />
          {o.label}
        </label>
      ))}
      {!inForm && (
        <div className={s.actions}>
          <button type="button" className={s.ghost} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={s.done} onClick={() => onCommit(ordered(picked))}>
            Done
          </button>
        </div>
      )}
      {message}
    </fieldset>
  );
}

/**
 * A phone: country and number (PhoneInput). Enter saves, Escape cancels; leaving the whole field saves,
 * but moving between the number and the country list doesn't, so half a number is never saved.
 */
function PhoneEditor({
  def,
  value,
  defaultCountry,
  onCommit,
  onCancel,
  inForm,
  autoFocus,
  message,
}: {
  def: FieldDefView;
  value: string;
  defaultCountry: string | null;
  onCommit: (v: unknown) => void;
  onCancel: () => void;
  inForm: boolean;
  autoFocus?: boolean;
  message: ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    if (draft.trim() === value.trim()) return onCancel();
    onCommit(draft.trim() || null);
  };
  return (
    <div
      className={s.wrap}
      onBlur={(e) => {
        // The country list floats in a portal: focus moving there hasn't left the field.
        const to = e.relatedTarget as HTMLElement | null;
        if (!inForm && !e.currentTarget.contains(to) && !to?.closest("[data-search-panel]")) commit();
      }}
    >
      <PhoneInput
        aria-label={def.label}
        value={draft}
        defaultCountry={defaultCountry}
        size="sm"
        autoFocus={autoFocus}
        onChange={(v) => {
          setDraft(v);
          if (inForm) onCommit(v || null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            done.current = true;
            onCancel();
          } else if (e.key === "Enter" && !inForm) {
            e.preventDefault();
            commit();
          }
        }}
      />
      {message}
    </div>
  );
}

/**
 * A lead's value, in the business currency (MoneyInput). Enter saves, Escape cancels, leaving saves.
 */
function MoneyEditor({
  def,
  value,
  currency,
  onCommit,
  onCancel,
  inForm,
  autoFocus,
  setProblem,
  message,
}: {
  def: FieldDefView;
  value: number | null;
  currency: string;
  onCommit: (v: unknown) => void;
  onCancel: () => void;
  inForm: boolean;
  autoFocus?: boolean;
  setProblem: (m: string | null) => void;
  message: ReactNode;
}) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const done = useRef(false);
  const commit = () => {
    if (done.current) return;
    const r = parseNumber(draft, true);
    if ("error" in r) return setProblem(r.error);
    setProblem(null);
    done.current = true;
    if (r.value === value) return onCancel();
    onCommit(r.value);
  };
  return (
    <div className={s.wrap}>
      <MoneyInput
        aria-label={def.label}
        amount={draft}
        currency={currency}
        size="sm"
        autoFocus={autoFocus}
        onChange={(next) => {
          setDraft(next);
          if (!inForm) return;
          const r = parseNumber(next, true);
          if ("error" in r) setProblem(r.error);
          else {
            setProblem(null);
            onCommit(r.value);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            done.current = true;
            onCancel();
          } else if (e.key === "Enter" && !inForm) {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={inForm ? undefined : commit}
      />
      {message}
    </div>
  );
}
