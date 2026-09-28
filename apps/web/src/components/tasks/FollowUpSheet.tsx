"use client";
import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Popover } from "@/components/ui/Popover";
import type { Person } from "@/lib/leads/types";
import { tasksClient } from "@/lib/tasks/client";
import { localInputToIso } from "@/lib/tasks/format";
import type { DuePreset, Recurrence, TaskView } from "@/lib/tasks/types";
import s from "./tasks.module.css";

const DUE: { id: DuePreset | "pick"; label: string }[] = [
  { id: "in_1h", label: "In 1 hour" },
  { id: "in_3h", label: "In 3 hours" },
  { id: "tomorrow_10", label: "Tomorrow 10:00" },
  { id: "in_2d", label: "In 2 days" },
  { id: "next_monday", label: "Next Monday" },
  { id: "pick", label: "Pick a time" },
];
const REMIND = [
  { minutes: 0, label: "At the time" },
  { minutes: 15, label: "15 min before" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 1440, label: "1 day before" },
];
const REPEAT: { label: string; r: Pick<Recurrence, "every" | "unit"> | null }[] = [
  { label: "Doesn't repeat", r: null },
  { label: "Every day", r: { every: 1, unit: "day" } },
  { label: "Every 3 days", r: { every: 3, unit: "day" } },
  { label: "Every week", r: { every: 1, unit: "week" } },
];
/** A repeat ends on its own once the lead replies, is won or is lost (Phase 3 spec §3 Recurrence). */
const STOP_ON: Recurrence["stopOn"] = ["won", "lost", "reply_logged"];

/**
 * "Follow-up" (Phase 3 spec §6): two taps set one — when, and (optionally) a reminder before it. It opens
 * from its button in the drawer and closes on save; F opens it from the keyboard.
 */
export function FollowUpSheet({
  lead,
  tz,
  meId,
  canAssign,
  people,
  onSaved,
}: {
  lead: { id: string; name: string };
  tz: string;
  meId: string;
  canAssign: boolean;
  people: Person[];
  onSaved(t: TaskView): void;
}) {
  const first = lead.name.split(" ")[0] || "this lead";
  return (
    <Popover label={`Follow up with ${first}`} trigger="Follow-up" triggerClassName={s.trigger} align="start">
      {(close) => (
        <Form
          lead={lead}
          first={first}
          tz={tz}
          meId={meId}
          canAssign={canAssign}
          people={people}
          onSaved={(t) => {
            close();
            onSaved(t);
          }}
        />
      )}
    </Popover>
  );
}

function Form({
  lead,
  first,
  tz,
  meId,
  canAssign,
  people,
  onSaved,
}: {
  lead: { id: string; name: string };
  first: string;
  tz: string;
  meId: string;
  canAssign: boolean;
  people: Person[];
  onSaved(t: TaskView): void;
}) {
  const id = useId();
  const [title, setTitle] = useState("Follow up");
  const [due, setDue] = useState<DuePreset | "pick">("tomorrow_10");
  const [picked, setPicked] = useState("");
  const [remind, setRemind] = useState<Set<number>>(new Set([0]));
  const [repeat, setRepeat] = useState(0);
  const [assignee, setAssignee] = useState(meId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    const at = due === "pick" ? localInputToIso(picked, tz) : null;
    if (due === "pick" && !at) return setProblem("Pick a date and time.");
    const r = REPEAT[repeat]!.r;
    setBusy(true);
    setProblem(null);
    const res = await tasksClient.create(lead.id, {
      title: title.trim() || "Follow up",
      due: at ? { at } : { preset: due as DuePreset },
      remindMinutes: [...remind].sort((a, b) => a - b),
      recurrence: r ? { ...r, until: null, stopOn: STOP_ON } : null,
      ...(assignee !== meId ? { assigneeId: assignee } : {}),
    });
    setBusy(false);
    if (!res.ok) return setProblem(res.message);
    onSaved(res.data);
  };
  const toggle = (m: number) =>
    setRemind((cur) => {
      const next = new Set(cur);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });

  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className={s.formTitle}>Follow up with {first}</p>
      <label className={s.field}>
        <span className={s.label}>What</span>
        <input className={s.input} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <fieldset className={s.group}>
        <legend className={s.label}>When</legend>
        <div className={s.chips}>
          {DUE.map((d) => (
            <label key={d.id} className={s.chip} data-on={due === d.id || undefined}>
              <input type="radio" name={`${id}-due`} checked={due === d.id} onChange={() => setDue(d.id)} />
              {d.label}
            </label>
          ))}
        </div>
        {due === "pick" && (
          <label className={s.field}>
            <span className={s.srOnly}>Date and time</span>
            <input
              className={s.input}
              type="datetime-local"
              aria-label="Date and time"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
            />
          </label>
        )}
      </fieldset>
      <fieldset className={s.group}>
        <legend className={s.label}>Remind me</legend>
        <div className={s.chips}>
          {REMIND.map((r) => (
            <label key={r.minutes} className={s.chip} data-on={remind.has(r.minutes) || undefined}>
              <input type="checkbox" checked={remind.has(r.minutes)} onChange={() => toggle(r.minutes)} />
              {r.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className={s.pair}>
        <label className={s.field}>
          <span className={s.label}>Repeat</span>
          <select
            className={s.input}
            aria-label="Repeat"
            value={repeat}
            onChange={(e) => setRepeat(Number(e.target.value))}
          >
            {REPEAT.map((r, i) => (
              <option key={r.label} value={i}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {canAssign && (
          <label className={s.field}>
            <span className={s.label}>For</span>
            <select
              className={s.input}
              aria-label="For"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
            >
              {people
                .filter((p) => p.active)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === meId ? `${p.name} (you)` : p.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
      {repeat > 0 && <p className={s.hint}>It stops on its own once {first} replies, is won or is lost.</p>}
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      <Button type="submit" variant="primary" loading={busy} className={s.save}>
        Set follow-up
      </Button>
    </form>
  );
}
