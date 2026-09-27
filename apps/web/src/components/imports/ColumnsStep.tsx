"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { CountryPicker } from "@/components/ui/CountryPicker";
import { importsClient } from "@/lib/imports/client";
import {
  choiceOf,
  columnFor,
  fieldChoice,
  targetType,
  withColumn,
  withTransform,
} from "@/lib/imports/mapping";
import type { ColumnMap, DateOrder, DraftView, IntakeField, Mapping } from "@/lib/imports/types";
import { COLUMN_CODES } from "./ImportSheet";
import { UnmatchedPanel } from "./UnmatchedPanel";
import s from "./imports.module.css";

const DATE_ORDERS: [DateOrder, string][] = [
  ["DMY", "Day/Month"],
  ["MDY", "Month/Day"],
  ["YMD", "Year first"],
];
const NEW_TYPES: [IntakeField["type"], string][] = [
  ["text", "Text"],
  ["long_text", "Long text"],
  ["number", "Number"],
  ["currency", "Amount"],
  ["date", "Date"],
  ["select", "One choice"],
  ["multi_select", "Several choices"],
  ["boolean", "Yes / no"],
  ["phone", "Phone"],
  ["email", "Email"],
  ["url", "Link"],
  ["instagram", "Instagram"],
];
const GROUPS = ["Contact", "Lead", "Custom"] as const;
const TYPE_WAIT_MS = 400;

/** The way a date column should be read, asked only when the file itself can't tell (spec §6.7). */
function DateOrderChoice({
  header,
  value,
  required,
  onChange,
}: {
  header: string;
  value: DateOrder | undefined;
  required: boolean;
  onChange: (v: DateOrder) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={`Read dates in ${header} as`}
      aria-required={required}
      className={s.pills}
    >
      {DATE_ORDERS.map(([v, l]) => (
        <label key={v} className={s.pill} data-on={value === v || undefined}>
          <input
            type="radio"
            className={s.srOnly}
            name={`date-order-${header}`}
            checked={value === v}
            onChange={() => onChange(v)}
          />
          {l}
        </label>
      ))}
    </div>
  );
}

/** Step 2 (spec §9.2): where each column goes, how it's read, and every value LUME doesn't recognise. */
export function ColumnsStep({
  draft,
  onDraft,
  blocked,
  onContinue,
}: {
  draft: DraftView;
  onDraft(d: DraftView): void;
  blocked: boolean;
  onContinue(): void;
}) {
  // Edits show at once; the server's answer (re-analysed, with problems) replaces them when it arrives.
  const [mapping, setMapping] = useState<Mapping>(draft.mapping);
  const [failed, setFailed] = useState<string | null>(null);
  const seq = useRef(0);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setMapping(draft.mapping), [draft.mapping]);
  useEffect(() => () => clearTimeout(typing.current ?? undefined), []);

  const send = async (next: Mapping) => {
    const mine = ++seq.current;
    const r = await importsClient.patch(draft.id, { mapping: next });
    if (mine !== seq.current) return; // a later edit has been sent: only its answer counts
    if (r.ok) {
      setFailed(null);
      onDraft(r.data);
    } else setFailed(r.message);
  };
  const change = (next: Mapping, wait = 0) => {
    setMapping(next);
    clearTimeout(typing.current ?? undefined);
    if (wait) typing.current = setTimeout(() => void send(next), wait);
    else void send(next);
  };

  const problems = draft.problems.filter((p) => COLUMN_CODES.has(p.code));
  const byGroup = GROUPS.map((g) => [g, draft.targets.filter((t) => t.group === g)] as const);

  const transformLine = (c: ColumnMap, header: string) => {
    const type = targetType(c, draft.choices.fields);
    const a = draft.analysis.find((x) => x.column === c.column);
    const t = c.to === "ignore" ? undefined : c.transform;
    return (
      <>
        {c.to === "new_field" && (
          <div className={s.newField}>
            <input
              className={s.input}
              aria-label="New field's name"
              value={c.label}
              maxLength={60}
              onChange={(e) => change(withColumn(mapping, { ...c, label: e.target.value }), TYPE_WAIT_MS)}
            />
            <select
              className={s.select}
              aria-label="New field's type"
              value={c.type}
              onChange={(e) =>
                change(withColumn(mapping, { ...c, type: e.target.value as IntakeField["type"] }))
              }
            >
              {NEW_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        )}
        {(type === "date" || type === "datetime") &&
          (t?.dateOrder || a?.dateOrder === "conflict" || a?.dateOrder === "ambiguous") && (
            <DateOrderChoice
              header={header}
              value={t?.dateOrder}
              required={a?.dateOrder === "conflict"}
              onChange={(dateOrder) => change(withTransform(mapping, c.column, { dateOrder }))}
            />
          )}
        {type === "phone" && (
          <div className={s.inline}>
            <CountryPicker
              label="Default country"
              value={t?.defaultCountry ?? draft.rules.defaultCountry ?? ""}
              onChange={(defaultCountry) => change(withTransform(mapping, c.column, { defaultCountry }))}
            />
          </div>
        )}
        {(type === "multi_select" || type === "tags") && (
          <label className={s.inlineLabel}>
            Split on
            <select
              className={s.select}
              value={t?.splitOn === "|" ? "|" : ""}
              onChange={(e) =>
                change(
                  withTransform(mapping, c.column, { splitOn: e.target.value === "|" ? "|" : undefined }),
                )
              }
            >
              <option value="">Commas or semicolons</option>
              <option value="|">Bars ( | )</option>
            </select>
          </label>
        )}
      </>
    );
  };

  return (
    <>
      <section className={s.body} aria-labelledby="import-columns-title">
        <h3 id="import-columns-title" className={s.stepTitle}>
          Match your columns
        </h3>
        <p className={s.lede}>
          LUME matched what it could. Check each column, and choose where the rest go — anything set to Ignore
          stays out.
        </p>
        {(problems.length > 0 || failed) && (
          <ul className={s.problems}>
            {failed && (
              <li role="alert" className={`${s.note} ${s.problem}`}>
                {failed}
              </li>
            )}
            {problems.map((p, i) => (
              <li key={`${p.code}-${p.column}-${i}`} role="alert" className={`${s.note} ${s.problem}`}>
                {p.message}
              </li>
            ))}
          </ul>
        )}
        <div className={s.tableWrap}>
          <table className={s.columns}>
            <caption className={s.srOnly}>Your columns</caption>
            <thead>
              <tr>
                <th scope="col">Your column</th>
                <th scope="col">Goes to</th>
              </tr>
            </thead>
            <tbody>
              {draft.headers.map((header, column) => {
                const c: ColumnMap = mapping.columns.find((x) => x.column === column) ?? {
                  column,
                  to: "ignore",
                };
                const samples = draft.sample
                  .map((r) => r[column]?.trim() ?? "")
                  .filter(Boolean)
                  .slice(0, 3);
                return (
                  <tr key={column} data-ignored={c.to === "ignore" || undefined}>
                    <th scope="row">
                      <span className={s.colName}>{header}</span>
                      <span className={s.samples}>
                        {samples.length ? (
                          samples.map((v, i) => (
                            <span key={i} className={s.sampleValue}>
                              {v}
                            </span>
                          ))
                        ) : (
                          <span className={s.sampleEmpty}>Empty in the first rows</span>
                        )}
                      </span>
                    </th>
                    <td>
                      <select
                        className={s.select}
                        aria-label={`${header} goes to`}
                        value={choiceOf(c)}
                        onChange={(e) =>
                          change(withColumn(mapping, columnFor(column, e.target.value, header, c)))
                        }
                      >
                        <option value="ignore">Ignore</option>
                        {byGroup.map(
                          ([g, list]) =>
                            list.length > 0 && (
                              <optgroup key={g} label={g}>
                                {list.map((t) => (
                                  <option key={t.key} value={fieldChoice(t.key)}>
                                    {t.label}
                                  </option>
                                ))}
                                {g === "Lead" && (
                                  <>
                                    <option value="name_part:first">First name</option>
                                    <option value="name_part:last">Last name</option>
                                  </>
                                )}
                              </optgroup>
                            ),
                        )}
                        {draft.can.manageFields && <option value="new_field">New field…</option>}
                      </select>
                      {transformLine(c, header)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <UnmatchedPanel draft={draft} mapping={mapping} onChange={change} />
      </section>
      <footer className={s.foot}>
        {blocked && <p className={s.footNote}>Settle what’s listed above to continue.</p>}
        <Button variant="primary" disabled={blocked} onClick={onContinue}>
          Continue
        </Button>
      </footer>
    </>
  );
}
