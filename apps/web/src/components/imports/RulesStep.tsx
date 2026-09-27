"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { CountryPicker } from "@/components/ui/CountryPicker";
import { Switch } from "@/components/ui/Switch";
import { importsClient } from "@/lib/imports/client";
import type { DraftView, IntakeField, Rules } from "@/lib/imports/types";
import { COLUMN_CODES } from "./ImportSheet";
import s from "./imports.module.css";

type Contact = Rules["matchOn"][number];
const CONTACTS: [Contact, string][] = [
  ["phone", "Phone"],
  ["email", "Email"],
  ["instagram", "Instagram"],
];
const ON_MATCH: [Rules["onMatch"], string, string][] = [
  ["merge", "Merge", "fills only empty fields, adds a note to its history, never overwrites"],
  ["skip", "Skip", "leaves it as it is"],
  ["duplicate", "Create a duplicate", "makes a second lead anyway"],
];
const TYPE_WAIT_MS = 400;

/** A radio choice with a line under it saying what it does. */
function Choice({
  name,
  checked,
  disabled,
  label,
  hint,
  badge,
  onPick,
  children,
}: {
  name: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint?: string;
  badge?: string;
  onPick(): void;
  children?: ReactNode;
}) {
  return (
    <div className={s.choice} data-on={checked || undefined} data-disabled={disabled || undefined}>
      <label className={s.choiceHead}>
        <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onPick} />
        <span className={s.choiceLabel}>
          {label}
          {badge && <span className={s.badge}>{badge}</span>}
        </span>
      </label>
      {hint && <p className={s.choiceHint}>{hint}</p>}
      {checked && children && <div className={s.choiceMore}>{children}</div>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={s.panel} aria-label={title}>
      <h4 className={s.panelTitle}>{title}</h4>
      {children}
    </section>
  );
}

/** Step 3 (spec §9.3): how existing leads are recognised, where new ones go, and the details. */
export function RulesStep({
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
  const [rules, setRules] = useState<Rules>(draft.rules);
  const [failed, setFailed] = useState<string | null>(null);
  const seq = useRef(0);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => setRules(draft.rules), [draft.rules]);
  useEffect(() => () => clearTimeout(typing.current ?? undefined), []);

  const send = async (next: Rules) => {
    const mine = ++seq.current;
    const r = await importsClient.patch(draft.id, { rules: next });
    if (mine !== seq.current) return; // only the latest edit's answer counts
    if (r.ok) {
      setFailed(null);
      onDraft(r.data);
    } else setFailed(r.message);
  };
  const change = (patch: Partial<Rules>, wait = 0) => {
    const next = { ...rules, ...patch };
    setRules(next);
    clearTimeout(typing.current ?? undefined);
    if (wait) typing.current = setTimeout(() => void send(next), wait);
    else void send(next);
  };

  const problems = draft.problems.filter((p) => !COLUMN_CODES.has(p.code));
  const openStages = draft.choices.stages.filter((st) => st.kind === "open");
  const stages = [...openStages, ...draft.choices.stages.filter((st) => st.kind !== "open")];
  const people = draft.choices.people;
  const ordered = [...rules.matchOn, ...CONTACTS.map(([k]) => k).filter((k) => !rules.matchOn.includes(k))];
  const nameOf = (k: Contact) => CONTACTS.find(([c]) => c === k)![1];
  // A default is asked for while it's missing, and stays in view once chosen.
  const needDefault = new Set([
    ...draft.problems.filter((p) => p.code === "REQUIRED_FIELD_UNCOVERED" && p.field).map((p) => p.field!),
    ...Object.keys(rules.requiredDefaults),
  ]);
  const defaultFields = draft.choices.fields.filter((f) => needDefault.has(f.key));
  const setDefault = (f: IntakeField, v: unknown, wait = 0) => {
    const requiredDefaults = { ...rules.requiredDefaults };
    if (v === undefined || v === "") delete requiredDefaults[f.key];
    else requiredDefaults[f.key] = v;
    change({ requiredDefaults }, wait);
  };
  const move = (k: Contact, by: -1 | 1) => {
    const i = rules.matchOn.indexOf(k);
    const j = i + by;
    if (i < 0 || j < 0 || j >= rules.matchOn.length) return;
    const matchOn = [...rules.matchOn];
    [matchOn[i], matchOn[j]] = [matchOn[j]!, matchOn[i]!];
    change({ matchOn });
  };

  return (
    <>
      <section className={s.body} aria-labelledby="import-rules-title">
        <h3 id="import-rules-title" className={s.stepTitle}>
          How to add them
        </h3>
        <p className={s.lede}>
          LUME’s suggestions are already set. Change anything that doesn’t fit this file.
        </p>
        {(problems.length > 0 || failed) && (
          <ul className={s.problems}>
            {failed && (
              <li role="alert" className={`${s.note} ${s.problem}`}>
                {failed}
              </li>
            )}
            {problems.map((p, i) => (
              <li key={`${p.code}-${i}`} role="alert" className={`${s.note} ${s.problem}`}>
                {p.message}
              </li>
            ))}
          </ul>
        )}

        <Panel title="How LUME recognises an existing lead">
          <div className={s.matchChips} role="group" aria-label="Recognise by, in this order">
            {ordered.map((k) => {
              const on = rules.matchOn.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  className={s.toggleChip}
                  aria-pressed={on}
                  title={on ? "Alt + ← → to change the order" : undefined}
                  onClick={() =>
                    change({ matchOn: on ? rules.matchOn.filter((x) => x !== k) : [...rules.matchOn, k] })
                  }
                  onKeyDown={(e) => {
                    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
                    e.preventDefault();
                    move(k, e.key === "ArrowLeft" ? -1 : 1);
                  }}
                >
                  {on && <span className={s.order}>{rules.matchOn.indexOf(k) + 1}</span>}
                  {nameOf(k)}
                </button>
              );
            })}
          </div>
          <div role="radiogroup" aria-label="When a row matches an existing lead" className={s.choices}>
            {ON_MATCH.map(([v, label, hint]) => (
              <Choice
                key={v}
                name="on-match"
                checked={rules.onMatch === v}
                label={label}
                hint={hint}
                badge={v === "merge" ? "Recommended" : undefined}
                onPick={() => change({ onMatch: v })}
              />
            ))}
          </div>
        </Panel>

        <Panel title="Leads that come back">
          <Switch
            label="Reopen a closed lead"
            checked={rules.reopenClosedTo !== null}
            onChange={(v) => change({ reopenClosedTo: v ? (openStages[0]?.id ?? null) : null })}
          />
          {rules.reopenClosedTo !== null && (
            <label className={s.inlineLabel}>
              Reopen to
              <select
                className={s.select}
                value={rules.reopenClosedTo}
                onChange={(e) => change({ reopenClosedTo: e.target.value })}
              >
                {openStages.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </Panel>

        <Panel title="Where new leads go">
          <div className={s.pair}>
            {draft.choices.pipelines.length > 1 && (
              <label className={s.stack}>
                Pipeline
                <select
                  className={s.select}
                  value={rules.pipelineId}
                  onChange={(e) => change({ pipelineId: e.target.value })}
                >
                  {draft.choices.pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className={s.stack}>
              Stage for new leads
              <select
                className={s.select}
                value={rules.stageId}
                onChange={(e) => change({ stageId: e.target.value })}
              >
                {!stages.some((st) => st.id === rules.stageId) && (
                  <option value={rules.stageId}>Choose a stage…</option>
                )}
                {stages.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div role="radiogroup" aria-label="Who new leads belong to" className={s.choices}>
            <Choice
              name="owner"
              checked={rules.owner.mode === "unassigned"}
              label="Unassigned"
              hint="The team picks them up from Leads."
              onPick={() => change({ owner: { mode: "unassigned" } })}
            />
            <Choice
              name="owner"
              checked={rules.owner.mode === "user"}
              disabled={!draft.can.assign}
              label="One person"
              hint={
                draft.can.assign
                  ? "Every new lead goes to them."
                  : "Your role can’t give leads to other people."
              }
              onPick={() => people[0] && change({ owner: { mode: "user", userId: people[0].id } })}
            >
              {rules.owner.mode === "user" && (
                <select
                  className={s.select}
                  aria-label="Person"
                  value={rules.owner.userId}
                  onChange={(e) => change({ owner: { mode: "user", userId: e.target.value } })}
                >
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </Choice>
            <Choice
              name="owner"
              checked={rules.owner.mode === "round_robin"}
              disabled={!draft.can.assign}
              label="Take turns"
              hint="New leads go round the people you choose, one each in turn."
              onPick={() => change({ owner: { mode: "round_robin", userIds: [] } })}
            >
              {rules.owner.mode === "round_robin" && (
                <div className={s.checks}>
                  {people.map((p) => {
                    const ids = rules.owner.mode === "round_robin" ? rules.owner.userIds : [];
                    const on = ids.includes(p.id);
                    return (
                      <label key={p.id} className={s.check}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() =>
                            change({
                              owner: {
                                mode: "round_robin",
                                userIds: on ? ids.filter((x) => x !== p.id) : [...ids, p.id],
                              },
                            })
                          }
                        />
                        {p.name}
                      </label>
                    );
                  })}
                </div>
              )}
            </Choice>
          </div>
        </Panel>

        <Panel title="Details">
          <div className={s.pair}>
            <div className={s.stack}>
              <span id="import-country">Phone numbers without a country code are from</span>
              <CountryPicker
                label="Default country"
                value={rules.defaultCountry ?? ""}
                onChange={(defaultCountry) => change({ defaultCountry })}
              />
            </div>
          </div>
          <div role="radiogroup" aria-label="Rows without a name" className={s.choicesRow}>
            <p className={s.stackTitle}>Rows without a name</p>
            <Choice
              name="no-name"
              checked={rules.noName === "use_contact"}
              label="Use their phone or email"
              onPick={() => change({ noName: "use_contact" })}
            />
            <Choice
              name="no-name"
              checked={rules.noName === "error"}
              label="Count as a problem"
              onPick={() => change({ noName: "error" })}
            />
          </div>
          <div role="radiogroup" aria-label="An owner LUME doesn't know" className={s.choicesRow}>
            <p className={s.stackTitle}>An owner LUME doesn’t know</p>
            <Choice
              name="unknown-owner"
              checked={rules.unknownOwner === "fallback"}
              label="Use the owner rule"
              onPick={() => change({ unknownOwner: "fallback" })}
            />
            <Choice
              name="unknown-owner"
              checked={rules.unknownOwner === "error"}
              label="Count as a problem"
              onPick={() => change({ unknownOwner: "error" })}
            />
          </div>
          {defaultFields.map((f) => {
            const label = `${f.label} for every imported lead`;
            const v = rules.requiredDefaults[f.key];
            const live = f.options.filter((o) => !o.archived);
            if (f.type === "select" || f.type === "multi_select")
              return (
                <label key={f.key} className={s.stack}>
                  {label}
                  <select
                    className={s.select}
                    aria-label={label}
                    value={Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "")}
                    onChange={(e) =>
                      setDefault(
                        f,
                        e.target.value
                          ? f.type === "multi_select"
                            ? [e.target.value]
                            : e.target.value
                          : undefined,
                      )
                    }
                  >
                    <option value="">Choose…</option>
                    {live.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            if (f.type === "boolean")
              return (
                <Switch key={f.key} label={label} checked={v === true} onChange={(b) => setDefault(f, b)} />
              );
            return (
              <label key={f.key} className={s.stack}>
                {label}
                <input
                  className={s.input}
                  aria-label={label}
                  inputMode={f.type === "number" || f.type === "currency" ? "decimal" : undefined}
                  defaultValue={v === undefined ? "" : String(v)}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const num = f.type === "number" || f.type === "currency";
                    setDefault(f, raw && num ? Number(raw) : raw, TYPE_WAIT_MS);
                  }}
                />
              </label>
            );
          })}
        </Panel>
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
