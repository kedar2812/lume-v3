"use client";
import {
  IG_LIMITS,
  messageProblems,
  textBytes,
  type FlowProblem,
  type GNode,
  type GraphCondition,
  type UpdateAction,
} from "@lume/core/shared";
import { useState, type ReactNode } from "react";
import type { Catalog } from "@/lib/leads/types";
import { KindIcon } from "./StepCard";
import { KINDS } from "./kinds";
import s from "./builder.module.css";

/** Flows a "Go to another flow" step may name. */
export type FlowChoice = { id: string; name: string; status: string };

const rid = () => Math.random().toString(36).slice(2, 8);
const chars = (v: string) => [...v].length;

/** A labelled control, its counter on the right. */
function Field({
  label,
  count,
  children,
  hint,
}: {
  label: string;
  count?: ReactNode;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className={s.field}>
      <span className={s.lbl}>
        {label}
        {count !== undefined && <span>{count}</span>}
      </span>
      {children}
      {hint && <span className={s.hint}>{hint}</span>}
    </label>
  );
}
const Remove = ({ onClick, what }: { onClick: () => void; what: string }) => (
  <button type="button" className={s.x} aria-label={`Remove ${what}`} onClick={onClick}>
    ×
  </button>
);

const WAITS: [number, string][] = [
  [0, "Never"],
  [15, "15 minutes"],
  [60, "1 hour"],
  [180, "3 hours"],
  [1440, "1 day"],
  [2880, "2 days"],
];
const UNITS: [number, string][] = [
  [1, "minutes"],
  [60, "hours"],
  [1440, "days"],
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The step's panel (plan 2026-11-23-flow-builder, Task B2; canvas board Builder, the inspector): every setting of the
 * step it shows, Instagram's limits as they're written, and the step's problems in words. Every change goes straight
 * back as the step, whole.
 */
export function Inspector({
  node,
  problems,
  catalog,
  flows,
  onChange,
  onDelete,
  onClose,
}: {
  node: GNode;
  problems: FlowProblem[];
  catalog: Catalog;
  flows: FlowChoice[];
  onChange: (n: GNode) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const kind = KINDS[node.type];
  return (
    <aside className={s.insp} aria-label={`${kind.label} step`} data-tool>
      <div className={s.ih}>
        <span className={s.nt}>
          <KindIcon d={kind.icon} />
        </span>
        <b className={s.ihTitle}>{kind.label}</b>
        <button type="button" className={s.ghostBtn} onClick={onDelete}>
          Delete
        </button>
        <button type="button" className={s.x} aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className={s.ib}>
        <Editor node={node} catalog={catalog} flows={flows} onChange={onChange} />
        {problems.length > 0 && (
          <div className={s.stepProbs} role="list" aria-label="This step's problems">
            {problems.map((p, i) => (
              <p key={i} role="listitem" data-warning={p.warning || undefined}>
                {p.words}
                {p.fix ? ` ${p.fix}` : ""}
              </p>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function Editor({
  node: n,
  catalog,
  flows,
  onChange,
}: {
  node: GNode;
  catalog: Catalog;
  flows: FlowChoice[];
  onChange: (n: GNode) => void;
}) {
  switch (n.type) {
    case "message": {
      const withButtons = n.buttons.length > 0;
      const used = withButtons ? chars(n.text) : textBytes(n.text);
      const max = withButtons ? IG_LIMITS.buttonTextChars : IG_LIMITS.textBytes;
      return (
        <>
          <Field label="Message" count={`${used.toLocaleString("en-IN")} of ${max.toLocaleString("en-IN")}`}>
            <textarea
              className={s.input}
              rows={5}
              value={n.text}
              onChange={(e) => onChange({ ...n, text: e.target.value })}
            />
          </Field>
          <div className={s.group}>
            <span className={s.lbl}>
              Quick replies <span>{`${n.replies.length} of ${IG_LIMITS.quickReplies}`}</span>
            </span>
            {n.replies.map((r) => (
              <div key={r.id} className={s.row}>
                <input
                  className={s.input}
                  aria-label="Quick reply"
                  maxLength={IG_LIMITS.quickReplyChars}
                  value={r.title}
                  onChange={(e) =>
                    onChange({
                      ...n,
                      replies: n.replies.map((x) => (x.id === r.id ? { ...x, title: e.target.value } : x)),
                    })
                  }
                />
                <span className={s.counter}>{`${chars(r.title)}/${IG_LIMITS.quickReplyChars}`}</span>
                <Remove
                  what={`the reply ${r.title}`}
                  onClick={() => onChange({ ...n, replies: n.replies.filter((x) => x.id !== r.id) })}
                />
              </div>
            ))}
            {n.replies.length < IG_LIMITS.quickReplies && !withButtons && (
              <button
                type="button"
                className={s.add}
                onClick={() =>
                  onChange({ ...n, replies: [...n.replies, { id: rid(), title: "", next: null }] })
                }
              >
                + Add a quick reply
              </button>
            )}
          </div>
          <div className={s.group}>
            <span className={s.lbl}>
              Buttons <span>{`${n.buttons.length} of ${IG_LIMITS.buttons}`}</span>
            </span>
            {n.buttons.map((b) => (
              <div key={b.id} className={s.stack2}>
                <div className={s.row}>
                  <input
                    className={s.input}
                    aria-label="Button words"
                    maxLength={IG_LIMITS.buttonTitleChars}
                    value={b.title}
                    onChange={(e) =>
                      onChange({
                        ...n,
                        buttons: n.buttons.map((x) => (x.id === b.id ? { ...x, title: e.target.value } : x)),
                      })
                    }
                  />
                  <Remove
                    what={`the button ${b.title}`}
                    onClick={() => onChange({ ...n, buttons: n.buttons.filter((x) => x.id !== b.id) })}
                  />
                </div>
                <input
                  className={s.input}
                  aria-label="Button link"
                  placeholder="https://"
                  inputMode="url"
                  value={b.url}
                  onChange={(e) =>
                    onChange({
                      ...n,
                      buttons: n.buttons.map((x) => (x.id === b.id ? { ...x, url: e.target.value } : x)),
                    })
                  }
                />
              </div>
            ))}
            {n.buttons.length < IG_LIMITS.buttons && n.replies.length === 0 && (
              <button
                type="button"
                className={s.add}
                onClick={() => onChange({ ...n, buttons: [...n.buttons, { id: rid(), title: "", url: "" }] })}
              >
                + Add a button
              </button>
            )}
            {(n.replies.length > 0 || withButtons) && (
              <span className={s.hint}>
                Instagram takes quick replies or buttons in one message, not both.
              </span>
            )}
          </div>
          <Limits
            problems={messageProblems({
              text: n.text,
              quickReplies: n.replies.map((r) => ({ title: r.title, payload: r.id })),
              buttons: n.buttons,
            })}
          />
        </>
      );
    }
    case "ask": {
      const fieldKeys = catalog.fields
        .filter((f) => !f.archived)
        .map((f) => ({ key: f.key, label: f.label }));
      return (
        <>
          <Field
            label="Question"
            count={`${textBytes(n.text).toLocaleString("en-IN")} of ${IG_LIMITS.textBytes.toLocaleString("en-IN")}`}
          >
            <textarea
              className={s.input}
              rows={3}
              value={n.text}
              onChange={(e) => onChange({ ...n, text: e.target.value })}
            />
          </Field>
          <Field
            label="Save the answer to"
            hint="A lead field, or a name of your own that only this flow reads."
          >
            <input
              className={s.input}
              list="flow-fields"
              value={n.save.field}
              onChange={(e) => onChange({ ...n, save: { ...n.save, field: e.target.value } })}
            />
            <datalist id="flow-fields">
              {fieldKeys.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="The answer is">
            <select
              className={s.input}
              value={n.save.kind}
              onChange={(e) => {
                const kind = e.target.value as typeof n.save.kind;
                onChange({
                  ...n,
                  save: { ...n.save, kind },
                  // Choices only while it asks for one: their lines go with them.
                  ...(kind !== "choice" ? { choices: undefined } : {}),
                  ...(kind === "choice" && !n.choices?.length
                    ? {
                        choices: [
                          { id: rid(), title: "", next: null },
                          { id: rid(), title: "", next: null },
                        ],
                      }
                    : {}),
                });
              }}
            >
              <option value="text">Any words</option>
              <option value="email">An email</option>
              <option value="phone">A phone number</option>
              <option value="number">A number</option>
              <option value="choice">One of a few choices</option>
            </select>
          </Field>
          {n.save.kind === "choice" && (
            <div className={s.group}>
              <span className={s.lbl}>
                Choices <span>{`${n.choices?.length ?? 0} of ${IG_LIMITS.quickReplies}`}</span>
              </span>
              {(n.choices ?? []).map((c) => (
                <div key={c.id} className={s.row}>
                  <input
                    className={s.input}
                    aria-label="Choice"
                    maxLength={IG_LIMITS.quickReplyChars}
                    value={c.title}
                    onChange={(e) =>
                      onChange({
                        ...n,
                        choices: (n.choices ?? []).map((x) =>
                          x.id === c.id ? { ...x, title: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <Remove
                    what={`the choice ${c.title}`}
                    onClick={() =>
                      onChange({ ...n, choices: (n.choices ?? []).filter((x) => x.id !== c.id) })
                    }
                  />
                </div>
              ))}
              {(n.choices?.length ?? 0) < IG_LIMITS.quickReplies && (
                <button
                  type="button"
                  className={s.add}
                  onClick={() =>
                    onChange({ ...n, choices: [...(n.choices ?? []), { id: rid(), title: "", next: null }] })
                  }
                >
                  + Add a choice
                </button>
              )}
            </div>
          )}
          <Field
            label="When the answer isn't one"
            hint="Said once; a second miss passes the conversation to your team."
          >
            <textarea
              className={s.input}
              rows={2}
              value={n.retry}
              onChange={(e) => onChange({ ...n, retry: e.target.value })}
            />
          </Field>
          <Field label="No answer after">
            <select
              className={s.input}
              value={n.noAnswer.afterMinutes}
              onChange={(e) =>
                onChange({ ...n, noAnswer: { ...n.noAnswer, afterMinutes: Number(e.target.value) } })
              }
            >
              {!WAITS.some(([m]) => m === n.noAnswer.afterMinutes) && (
                <option value={n.noAnswer.afterMinutes}>{`${n.noAnswer.afterMinutes} minutes`}</option>
              )}
              {WAITS.map(([m, l]) => (
                <option key={m} value={m}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        </>
      );
    }
    case "check":
      return (
        <>
          <Field label="Goes down Yes when">
            <select
              className={s.input}
              value={n.match}
              onChange={(e) => onChange({ ...n, match: e.target.value as "all" | "any" })}
            >
              <option value="all">Every rule holds</option>
              <option value="any">Any rule holds</option>
            </select>
          </Field>
          <div className={s.group}>
            <span className={s.lbl}>Rules</span>
            {n.rules.map((r, i) => (
              <Rule
                key={i}
                rule={r}
                catalog={catalog}
                onChange={(nr) => onChange({ ...n, rules: n.rules.map((x, j) => (j === i ? nr : x)) })}
                onRemove={() => onChange({ ...n, rules: n.rules.filter((_, j) => j !== i) })}
              />
            ))}
            <button
              type="button"
              className={s.add}
              onClick={() => onChange({ ...n, rules: [...n.rules, { on: "tag", key: "", op: "is" }] })}
            >
              + Add a rule
            </button>
          </div>
        </>
      );
    case "split": {
      const total = n.paths.reduce((a, p) => a + p.weight, 0);
      return (
        <div className={s.group}>
          <span className={s.lbl}>
            Paths <span data-off={total !== 100 || undefined}>{`${total}% of 100%`}</span>
          </span>
          {n.paths.map((p, i) => (
            <div key={p.id} className={s.row}>
              <span className={s.pathName}>{`Path ${String.fromCharCode(65 + i)}`}</span>
              <input
                className={s.input}
                type="number"
                min={1}
                max={99}
                aria-label={`Path ${String.fromCharCode(65 + i)}, per cent`}
                value={p.weight}
                onChange={(e) =>
                  onChange({
                    ...n,
                    paths: n.paths.map((x) =>
                      x.id === p.id ? { ...x, weight: Math.round(Number(e.target.value) || 0) } : x,
                    ),
                  })
                }
              />
              <span className={s.counter}>%</span>
              {n.paths.length > 2 && (
                <Remove
                  what={`path ${String.fromCharCode(65 + i)}`}
                  onClick={() => onChange({ ...n, paths: n.paths.filter((x) => x.id !== p.id) })}
                />
              )}
            </div>
          ))}
          {n.paths.length < 12 && (
            <button
              type="button"
              className={s.add}
              onClick={() => onChange({ ...n, paths: [...n.paths, { id: rid(), weight: 0, next: null }] })}
            >
              + Add a path
            </button>
          )}
          <span className={s.hint}>Each person always takes the same path.</span>
        </div>
      );
    }
    case "wait": {
      const timed = "minutes" in n.for;
      return (
        <>
          <Field label="Wait">
            <select
              className={s.input}
              value={timed ? "for" : "until"}
              onChange={(e) =>
                onChange({
                  ...n,
                  for:
                    e.target.value === "for"
                      ? { minutes: 60 }
                      : { until: { time: "09:00", days: [1, 2, 3, 4, 5] } },
                })
              }
            >
              <option value="for">For a while</option>
              <option value="until">Until a time of day</option>
            </select>
          </Field>
          {"minutes" in n.for ? (
            <WaitFor minutes={n.for.minutes} onChange={(m) => onChange({ ...n, for: { minutes: m } })} />
          ) : (
            <>
              <Field label="At">
                <input
                  className={s.input}
                  type="time"
                  value={n.for.until.time}
                  onChange={(e) =>
                    onChange({
                      ...n,
                      for: {
                        until: { ...("until" in n.for ? n.for.until : { days: [] }), time: e.target.value },
                      },
                    })
                  }
                />
              </Field>
              <fieldset className={s.days}>
                <legend className={s.lbl}>On</legend>
                {DAYS.map((d, i) => {
                  const until = "until" in n.for ? n.for.until : { time: "09:00", days: [] as number[] };
                  const on = until.days.includes(i);
                  return (
                    <label key={d} className={s.day} data-on={on || undefined}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          onChange({
                            ...n,
                            for: {
                              until: {
                                ...until,
                                days: on ? until.days.filter((x) => x !== i) : [...until.days, i].sort(),
                              },
                            },
                          })
                        }
                      />
                      {d}
                    </label>
                  );
                })}
              </fieldset>
            </>
          )}
          <span className={s.hint}>
            Instagram lets LUME write for 24 hours after the person&apos;s last message (7 days after an ad).
          </span>
        </>
      );
    }
    case "update":
      return (
        <div className={s.group}>
          <span className={s.lbl}>Changes to the lead</span>
          {n.actions.map((a, i) => (
            <Action
              key={i}
              action={a}
              catalog={catalog}
              onChange={(na) => onChange({ ...n, actions: n.actions.map((x, j) => (j === i ? na : x)) })}
              onRemove={() => onChange({ ...n, actions: n.actions.filter((_, j) => j !== i) })}
            />
          ))}
          <button
            type="button"
            className={s.add}
            onClick={() => onChange({ ...n, actions: [...n.actions, { kind: "tag", tagId: "", add: true }] })}
          >
            + Add a change
          </button>
        </div>
      );
    case "notify":
      return (
        <>
          <Field label="Tell">
            <select
              className={s.input}
              value={typeof n.to === "object" ? "person" : n.to}
              onChange={(e) => {
                const v = e.target.value;
                onChange({
                  ...n,
                  to:
                    v === "person"
                      ? { userId: catalog.people.find((p) => p.active)?.id ?? "" }
                      : (v as "owner" | "admins"),
                });
              }}
            >
              <option value="owner">Whoever owns the lead</option>
              <option value="admins">The admins</option>
              <option value="person">Someone in particular</option>
            </select>
          </Field>
          {typeof n.to === "object" && (
            <Field label="Who">
              <select
                className={s.input}
                value={n.to.userId}
                onChange={(e) => onChange({ ...n, to: { userId: e.target.value } })}
              >
                {catalog.people
                  .filter((p) => p.active)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          <Field label="What they're told" count={`${chars(n.text)} of 500`}>
            <textarea
              className={s.input}
              rows={3}
              maxLength={500}
              value={n.text}
              onChange={(e) => onChange({ ...n, text: e.target.value })}
            />
          </Field>
        </>
      );
    case "goto":
      return (
        <Field label="Go on to" hint="That flow starts from its first step. LUME stops after three in a row.">
          <select
            className={s.input}
            value={n.flowId}
            onChange={(e) => onChange({ ...n, flowId: e.target.value })}
          >
            <option value="">Choose a flow</option>
            {n.flowId && !flows.some((f) => f.id === n.flowId) && (
              <option value={n.flowId}>A flow that isn&apos;t live</option>
            )}
            {flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.status === "paused" ? " (paused)" : ""}
              </option>
            ))}
          </select>
        </Field>
      );
    case "handoff":
      return (
        <>
          <Field label="Hand the conversation to">
            <select
              className={s.input}
              value={n.to}
              onChange={(e) =>
                onChange(
                  e.target.value === "ai"
                    ? { id: n.id, type: "handoff", to: "ai", note: n.note, goal: { kind: "reply" } }
                    : { id: n.id, type: "handoff", to: "person", note: n.note },
                )
              }
            >
              <option value="person">A person on the team</option>
              <option value="ai">LUME AI</option>
            </select>
          </Field>
          <Field label="A note for them" count={`${chars(n.note ?? "")} of 500`}>
            <input
              className={s.input}
              maxLength={500}
              value={n.note ?? ""}
              onChange={(e) => onChange({ ...n, note: e.target.value })}
            />
          </Field>
        </>
      );
    case "book":
      return (
        <>
          <Field label="Message" count={`${chars(n.text)} of ${IG_LIMITS.buttonTextChars}`}>
            <textarea
              className={s.input}
              rows={3}
              value={n.text}
              onChange={(e) => onChange({ ...n, text: e.target.value })}
            />
          </Field>
          <Field label="The link people book on">
            <input
              className={s.input}
              inputMode="url"
              placeholder="https://"
              value={n.url}
              onChange={(e) => onChange({ ...n, url: e.target.value })}
            />
          </Field>
        </>
      );
    case "end":
      return <p className={s.hint}>The flow ends here. Nothing else is sent.</p>;
  }
}

/**
 * How long a Wait waits: the number as typed (it may be empty while typing) and the unit chosen, kept as they are, so
 * typing 120 in minutes stays 120 minutes (review 2026-11-24: it jumped to 2 hours).
 */
function WaitFor({ minutes, onChange }: { minutes: number; onChange: (minutes: number) => void }) {
  const [unit, setUnit] = useState(() => (minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1));
  const [draft, setDraft] = useState(() => String(minutes / unit));
  return (
    <div className={s.row}>
      <input
        className={s.input}
        type="number"
        min={1}
        aria-label="How long"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Math.round(Number(e.target.value));
          if (e.target.value !== "" && v >= 1) onChange(v * unit);
        }}
      />
      <select
        className={s.input}
        aria-label="Unit"
        value={unit}
        onChange={(e) => {
          const u = Number(e.target.value);
          setUnit(u);
          const v = Math.round(Number(draft));
          if (v >= 1) onChange(v * u);
        }}
      >
        {UNITS.map(([u, l]) => (
          <option key={u} value={u}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Instagram's limits for the message as it's written, in words (Meta's own rules). */
function Limits({ problems }: { problems: string[] }) {
  return (
    <div className={s.lim} aria-live="polite">
      {problems.length ? (
        problems.map((p) => <p key={p}>{p}</p>)
      ) : (
        <p data-ok>Within Instagram&apos;s limits.</p>
      )}
    </div>
  );
}

const RULE_ON: [GraphCondition["on"], string][] = [
  ["tag", "Tag"],
  ["field", "Lead field"],
  ["answer", "Answer in this flow"],
  ["stage", "Stage"],
  ["owner", "Owner"],
  ["source", "Where they came from"],
  ["time", "Time of day"],
];
const OPS: [GraphCondition["op"], string][] = [
  ["is", "is"],
  ["is_not", "is not"],
  ["contains", "contains"],
  ["empty", "is empty"],
  ["not_empty", "isn't empty"],
  ["gt", "is more than"],
  ["lt", "is less than"],
];

function Rule({
  rule: r,
  catalog,
  onChange,
  onRemove,
}: {
  rule: GraphCondition;
  catalog: Catalog;
  onChange: (r: GraphCondition) => void;
  onRemove: () => void;
}) {
  const stages = catalog.pipelines.flatMap((p) =>
    p.stages.map((st) => ({
      id: st.id,
      name: catalog.pipelines.length > 1 ? `${p.name}: ${st.name}` : st.name,
    })),
  );
  const span = /^(\d\d:\d\d)-(\d\d:\d\d)$/.exec(r.key);
  return (
    <div className={s.ruleBox}>
      <div className={s.row}>
        <select
          className={s.input}
          aria-label="What the rule looks at"
          value={r.on}
          onChange={(e) =>
            onChange({
              on: e.target.value as GraphCondition["on"],
              key: e.target.value === "time" ? "09:00-18:00" : "",
              op: e.target.value === "tag" ? "is" : "is",
            })
          }
        >
          {RULE_ON.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <Remove what="the rule" onClick={onRemove} />
      </div>
      {r.on === "tag" && (
        <div className={s.row}>
          <select
            className={s.input}
            aria-label="Has or hasn't"
            value={r.op === "is_not" ? "is_not" : "is"}
            onChange={(e) => onChange({ ...r, op: e.target.value as "is" | "is_not" })}
          >
            <option value="is">Has</option>
            <option value="is_not">Hasn&apos;t</option>
          </select>
          <select
            className={s.input}
            aria-label="Tag"
            value={r.key}
            onChange={(e) => onChange({ ...r, key: e.target.value })}
          >
            <option value="">Choose a tag</option>
            {catalog.tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {r.on === "time" && (
        <div className={s.row}>
          <span className={s.pathName}>From</span>
          <input
            className={s.input}
            type="time"
            aria-label="From"
            value={span?.[1] ?? "09:00"}
            onChange={(e) => onChange({ ...r, key: `${e.target.value}-${span?.[2] ?? "18:00"}` })}
          />
          <span className={s.pathName}>to</span>
          <input
            className={s.input}
            type="time"
            aria-label="To"
            value={span?.[2] ?? "18:00"}
            onChange={(e) => onChange({ ...r, key: `${span?.[1] ?? "09:00"}-${e.target.value}` })}
          />
        </div>
      )}
      {(r.on === "field" || r.on === "answer") && (
        <>
          {r.on === "field" ? (
            <select
              className={s.input}
              aria-label="Field"
              value={r.key}
              onChange={(e) => onChange({ ...r, key: e.target.value })}
            >
              <option value="">Choose a field</option>
              {catalog.fields
                .filter((f) => !f.archived)
                .map((f) => (
                  <option key={f.id} value={f.key}>
                    {f.label}
                  </option>
                ))}
            </select>
          ) : (
            <input
              className={s.input}
              aria-label="The answer's name"
              placeholder="The name a question saves to"
              value={r.key}
              onChange={(e) => onChange({ ...r, key: e.target.value })}
            />
          )}
          <div className={s.row}>
            <select
              className={s.input}
              aria-label="How it compares"
              value={r.op}
              onChange={(e) => onChange({ ...r, op: e.target.value as GraphCondition["op"] })}
            >
              {OPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {r.op !== "empty" && r.op !== "not_empty" && (
              <input
                className={s.input}
                aria-label="Value"
                value={r.value ?? ""}
                onChange={(e) => onChange({ ...r, value: e.target.value })}
              />
            )}
          </div>
        </>
      )}
      {(r.on === "stage" || r.on === "owner" || r.on === "source") && (
        <div className={s.row}>
          <select
            className={s.input}
            aria-label="Is or isn't"
            value={r.op === "is_not" ? "is_not" : "is"}
            onChange={(e) => onChange({ ...r, op: e.target.value as "is" | "is_not" })}
          >
            <option value="is">is</option>
            <option value="is_not">is not</option>
          </select>
          <select
            className={s.input}
            aria-label="Value"
            value={r.value ?? ""}
            onChange={(e) => onChange({ ...r, value: e.target.value })}
          >
            <option value="">Choose</option>
            {(r.on === "stage"
              ? stages
              : r.on === "owner"
                ? catalog.people.map((p) => ({ id: p.id, name: p.name }))
                : catalog.sources
            ).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

const ACTIONS: [string, string][] = [
  ["tag+", "Add a tag"],
  ["tag-", "Take a tag off"],
  ["field", "Set a field"],
  ["clear", "Clear a field"],
  ["stage", "Move to a stage"],
  ["assign", "Give the lead to"],
  ["task", "Make a follow-up"],
];
const actionKey = (a: UpdateAction) =>
  a.kind === "tag"
    ? a.add
      ? "tag+"
      : "tag-"
    : a.kind === "field"
      ? a.value === null
        ? "clear"
        : "field"
      : a.kind;

function Action({
  action: a,
  catalog,
  onChange,
  onRemove,
}: {
  action: UpdateAction;
  catalog: Catalog;
  onChange: (a: UpdateAction) => void;
  onRemove: () => void;
}) {
  const stages = catalog.pipelines.flatMap((p) =>
    p.stages.map((st) => ({
      id: st.id,
      name: catalog.pipelines.length > 1 ? `${p.name}: ${st.name}` : st.name,
    })),
  );
  const make = (k: string): UpdateAction =>
    k === "tag+"
      ? { kind: "tag", tagId: "", add: true }
      : k === "tag-"
        ? { kind: "tag", tagId: "", add: false }
        : k === "field"
          ? { kind: "field", field: "", value: "" }
          : k === "clear"
            ? { kind: "field", field: "", value: null }
            : k === "stage"
              ? { kind: "stage", stageId: "" }
              : k === "assign"
                ? { kind: "assign", to: { mode: "source" } }
                : { kind: "task", title: "Follow up", dueMinutes: 60 };
  return (
    <div className={s.ruleBox}>
      <div className={s.row}>
        <select
          className={s.input}
          aria-label="The change"
          value={actionKey(a)}
          onChange={(e) => onChange(make(e.target.value))}
        >
          {ACTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <Remove what="the change" onClick={onRemove} />
      </div>
      {a.kind === "tag" && (
        <select
          className={s.input}
          aria-label="Tag"
          value={a.tagId}
          onChange={(e) => onChange({ ...a, tagId: e.target.value })}
        >
          <option value="">Choose a tag</option>
          {catalog.tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      )}
      {a.kind === "field" && (
        <div className={s.row}>
          <select
            className={s.input}
            aria-label="Field"
            value={a.field}
            onChange={(e) => onChange({ ...a, field: e.target.value })}
          >
            <option value="">Choose a field</option>
            {catalog.fields
              .filter((f) => !f.archived && f.key !== "name")
              .map((f) => (
                <option key={f.id} value={f.key}>
                  {f.label}
                </option>
              ))}
          </select>
          {a.value !== null && (
            <input
              className={s.input}
              aria-label="Value"
              value={a.value}
              onChange={(e) => onChange({ ...a, value: e.target.value })}
            />
          )}
        </div>
      )}
      {a.kind === "stage" && (
        <select
          className={s.input}
          aria-label="Stage"
          value={a.stageId}
          onChange={(e) => onChange({ ...a, stageId: e.target.value })}
        >
          <option value="">Choose a stage</option>
          {stages.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </select>
      )}
      {a.kind === "assign" && (
        <select
          className={s.input}
          aria-label="Give the lead to"
          value={a.to.mode === "user" ? a.to.userId : a.to.mode}
          onChange={(e) =>
            onChange({
              ...a,
              to: e.target.value === "source" ? { mode: "source" } : { mode: "user", userId: e.target.value },
            })
          }
        >
          <option value="source">Whoever owns the Instagram account</option>
          {catalog.people
            .filter((p) => p.active)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      )}
      {a.kind === "task" && (
        <div className={s.row}>
          <input
            className={s.input}
            aria-label="Follow-up"
            maxLength={200}
            value={a.title}
            onChange={(e) => onChange({ ...a, title: e.target.value })}
          />
          <select
            className={s.input}
            aria-label="Due"
            value={a.dueMinutes}
            onChange={(e) => onChange({ ...a, dueMinutes: Number(e.target.value) })}
          >
            <option value={60}>In an hour</option>
            <option value={240}>In 4 hours</option>
            <option value={1440}>Tomorrow</option>
            <option value={4320}>In 3 days</option>
          </select>
        </div>
      )}
    </div>
  );
}
