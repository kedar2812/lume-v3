"use client";
import { useState } from "react";
import { describePreset, duePresetsSchema, type DuePresetDef } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import { api } from "@/lib/api";
import { ListEditor } from "./ListEditor";
import s from "./settings.module.css";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
type Rule = DuePresetDef["rule"];
type Kind = "in" | "at" | "weekday";
const kindOf = (r: Rule): Kind => ("in" in r ? "in" : "at" in r ? "at" : "weekday");

/** A choice's id from its name, unique among the others ("In 30 minutes" → in_30_minutes). */
function idFor(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 36) || "choice";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  return id;
}

/**
 * Settings → Follow-ups → Time choices (3C; report §10.2): the choices people pick from when they set a
 * follow-up, in the order they appear. Each change saves as it's made; a refusal puts it back and says why.
 * Follow-ups already set keep their time.
 */
export function DuePresetsEditor({ initial }: { initial: DuePresetDef[] }) {
  const [presets, setPresets] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async (next: DuePresetDef[]) => {
    const parsed = duePresetsSchema.safeParse(next);
    setSaved(false);
    if (!parsed.success) return setProblem(parsed.error.issues[0]?.message ?? "That change isn't possible.");
    const before = presets;
    setPresets(next);
    setProblem(null);
    const r = await api.put("/api/v1/settings/follow-ups", { duePresets: next });
    if (!r.ok) {
      setPresets(before);
      return setProblem(r.message || "That change couldn't be saved.");
    }
    setSaved(true);
  };
  const byId = (id: string) => presets.find((p) => p.id === id)!;

  return (
    <section className={s.panel} aria-labelledby="time-choices">
      <div className={s.panelHead}>
        <h2 id="time-choices" className={s.panelTitle}>
          Time choices
        </h2>
        <p className={s.muted}>
          What people pick from when they set a follow-up, in this order. Follow-ups already set keep their
          time.
        </p>
      </div>
      <div className={s.panelBody}>
        <ListEditor
          items={presets}
          listLabel="Time choices"
          itemLabel="Time choice"
          addLabel="Add a time choice"
          archiveVerb="Remove"
          archiveNote="Follow-ups already set keep their time."
          onAdd={(label) =>
            void save([
              ...presets,
              {
                id: idFor(label, new Set(presets.map((p) => p.id))),
                label,
                rule: { in: { n: 1, unit: "hour" } },
              },
            ])
          }
          onRename={(id, label) => void save(presets.map((p) => (p.id === id ? { ...p, label } : p)))}
          onReorder={(ids) => void save(ids.map(byId))}
          onArchive={(id) => void save(presets.filter((p) => p.id !== id))}
          renderExtra={(p) => (
            <Popover
              label={`When for ${p.label}`}
              size="form"
              align="end"
              triggerClassName={s.needsBtn}
              trigger={
                <>
                  <span aria-hidden>{describePreset(p)}</span>
                  <span className={s.srOnly}>When for {p.label}</span>
                </>
              }
            >
              {(close) => (
                <RuleForm
                  rule={p.rule}
                  onDone={(rule) => {
                    close();
                    void save(presets.map((x) => (x.id === p.id ? { ...x, rule } : x)));
                  }}
                />
              )}
            </Popover>
          )}
        />
        {problem ? (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        ) : (
          saved && (
            <p role="status" className={s.saved}>
              Saved
            </p>
          )
        )}
      </div>
    </section>
  );
}

/** When one choice lands: in N minutes/hours/days, on a day at a time, or next weekday at a time. */
function RuleForm({ rule, onDone }: { rule: Rule; onDone: (r: Rule) => void }) {
  const [kind, setKind] = useState<Kind>(kindOf(rule));
  const [n, setN] = useState("in" in rule ? String(rule.in.n) : "1");
  const [unit, setUnit] = useState<"minute" | "hour" | "day">("in" in rule ? rule.in.unit : "hour");
  const [days, setDays] = useState("at" in rule ? String(rule.at.days) : "1");
  const [day, setDay] = useState("weekday" in rule ? String(rule.weekday.day) : "1");
  const [time, setTime] = useState(
    "at" in rule ? rule.at.time : "weekday" in rule ? rule.weekday.time : "10:00",
  );
  const build = (): Rule =>
    kind === "in"
      ? { in: { n: Math.round(Number(n)), unit } }
      : kind === "at"
        ? { at: { days: Math.round(Number(days)), time } }
        : { weekday: { day: Number(day), time } };
  return (
    <form
      className={s.ruleForm}
      onSubmit={(e) => {
        e.preventDefault();
        onDone(build());
      }}
    >
      <label className={s.ruleField}>
        <span>Lands</span>
        <select aria-label="Lands" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="in">after a while</option>
          <option value="at">on a day, at a time</option>
          <option value="weekday">next weekday, at a time</option>
        </select>
      </label>
      {kind === "in" && (
        <div className={s.ruleRow}>
          <input
            aria-label="How many"
            type="number"
            inputMode="numeric"
            min={1}
            max={999}
            value={n}
            onChange={(e) => setN(e.target.value)}
          />
          <select
            aria-label="Minutes, hours or days"
            value={unit}
            onChange={(e) => setUnit(e.target.value as typeof unit)}
          >
            <option value="minute">minutes</option>
            <option value="hour">hours</option>
            <option value="day">days</option>
          </select>
        </div>
      )}
      {kind === "at" && (
        <div className={s.ruleRow}>
          <select aria-label="Which day" value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="0">today</option>
            <option value="1">tomorrow</option>
            {[2, 3, 4, 5, 6, 7].map((d) => (
              <option key={d} value={d}>
                in {d} days
              </option>
            ))}
          </select>
          <input aria-label="At" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      )}
      {kind === "weekday" && (
        <div className={s.ruleRow}>
          <select aria-label="Which day" value={day} onChange={(e) => setDay(e.target.value)}>
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                next {d}
              </option>
            ))}
          </select>
          <input aria-label="At" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      )}
      <Button type="submit" size="sm" variant="primary">
        Done
      </Button>
    </form>
  );
}
