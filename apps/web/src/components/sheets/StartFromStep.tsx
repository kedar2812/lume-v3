"use client";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import s from "@/components/imports/imports.module.css";
import k from "./sheets.module.css";

const EVERY = [
  { v: 60, label: "Every minute" },
  { v: 120, label: "Every 2 minutes" },
  { v: 300, label: "Every 5 minutes" },
  { v: 900, label: "Every 15 minutes" },
  { v: 1800, label: "Every 30 minutes" },
  { v: 3600, label: "Every hour" },
];

/** Step 5 (spec §7.2): name it, say how often to look, and whether the rows already there come in too. */
export function StartFromStep({
  defaultName,
  rowCount,
  moreRows,
  editing,
  saving,
  error,
  onSave,
}: {
  defaultName: string;
  rowCount: number;
  moreRows: boolean;
  editing: boolean;
  saving: boolean;
  error: string | null;
  onSave(o: { name: string; pollSeconds: number; startFrom: "all" | "new" }): void;
}) {
  const [name, setName] = useState(defaultName);
  const [pollSeconds, setPoll] = useState(120);
  const [startFrom, setStartFrom] = useState<"all" | "new">("all");
  const count = `${rowCount.toLocaleString("en")}${moreRows ? "+" : ""}`;
  return (
    <>
      <section className={s.body}>
        <h3 className={s.stepTitle}>{editing ? "Save changes" : "Start"}</h3>
        <label className={k.field}>
          <span>Name</span>
          <input className={s.input} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={k.field}>
          <span>Check for new rows</span>
          <select className={s.select} value={pollSeconds} onChange={(e) => setPoll(Number(e.target.value))}>
            {EVERY.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {!editing && (
          <fieldset className={k.choices}>
            <legend>Which rows come in</legend>
            <label className={k.choice}>
              <input
                type="radio"
                name="from"
                checked={startFrom === "all"}
                onChange={() => setStartFrom("all")}
              />
              <span>
                Every row already in the sheet ({count})<small>Then every new one.</small>
              </span>
            </label>
            <label className={k.choice}>
              <input
                type="radio"
                name="from"
                checked={startFrom === "new"}
                onChange={() => setStartFrom("new")}
              />
              <span>
                Only rows added from now on<small>The {count} already there stay in the sheet.</small>
              </span>
            </label>
          </fieldset>
        )}
        {error && (
          <p role="alert" className={`${s.note} ${s.problem}`}>
            {error}
          </p>
        )}
      </section>
      <footer className={s.foot}>
        <p className={s.footNote}>LUME never writes to your sheet.</p>
        <Button
          variant="primary"
          loading={saving}
          disabled={!name.trim()}
          onClick={() => onSave({ name: name.trim(), pollSeconds, startFrom: editing ? "all" : startFrom })}
        >
          {editing ? "Save changes" : "Connect sheet"}
        </Button>
      </footer>
    </>
  );
}
