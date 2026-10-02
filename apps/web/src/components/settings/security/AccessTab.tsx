"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useRef, useState } from "react";
import type { WorkingHours } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { SPRINGS, toMotion } from "@/lib/motion";
import { DAY_NAMES, hoursInWords, weekFrom } from "@/lib/settings/hours";
import {
  isNetwork,
  networkHolds,
  type AccessView,
  type LoginHours,
  type RoleAccess,
} from "@/lib/settings/security";
import { zoneInWords } from "@/lib/timezones";
import s from "./security.module.css";

type Draft = {
  hours: "any" | "business" | "custom";
  days: number[];
  from: string;
  to: string;
  nets: "any" | "only";
  list: string[];
};

const TIMES = Array.from(
  { length: 48 },
  (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
);
const END_TIMES = [...TIMES.slice(1), "23:59"];
/** "9:00 am"; the last minute of the day reads as midnight. */
export function clockWords(t: string): string {
  if (t === "23:59") return "Midnight";
  const [h = 0, m = 0] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

function draftOf(role: RoleAccess, wh: WorkingHours): Draft {
  const h = role.loginHours;
  return {
    hours: !h ? "any" : h.business ? "business" : "custom",
    days: h && !h.business ? [...h.days] : [...wh.days],
    from: h && !h.business ? h.from : wh.start,
    to: h && !h.business ? h.to : wh.end,
    nets: role.ipAllowlist?.length ? "only" : "any",
    list: [...(role.ipAllowlist ?? [])],
  };
}
function bodyOf(d: Draft, wh: WorkingHours): { loginHours: LoginHours | null; ipAllowlist: string[] | null } {
  const loginHours: LoginHours | null =
    d.hours === "any"
      ? null
      : d.hours === "business"
        ? { business: true, days: [...wh.days], from: wh.start, to: wh.end }
        : { days: [...d.days].sort((a, b) => a - b), from: d.from, to: d.to };
  return { loginHours, ipAllowlist: d.nets === "only" ? d.list : null };
}

/**
 * Settings → Security → Access limits (6A, canvas [Access]): for each role, when its people may sign in and from
 * which networks. Edits one role at a time and saves together. LUME refuses limits that would sign the editor
 * out, and says how to fix it.
 */
export function AccessTab({ initial }: { initial: AccessView }) {
  const wh = initial.workingHours;
  const reduce = useReducedMotion();
  const [roles, setRoles] = useState(initial.roles);
  const [roleId, setRoleId] = useState(initial.roles[0]?.id ?? "");
  const role = roles.find((r) => r.id === roleId);
  const [draft, setDraft] = useState<Draft | null>(role ? draftOf(role, wh) : null);
  const [asking, setAsking] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ text: string; lockout: boolean } | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const addHere = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const askId = useId();

  if (!role || !draft) return <p className={s.sub}>There are no roles to limit yet.</p>;
  const dirty = JSON.stringify(bodyOf(draft, wh)) !== JSON.stringify(bodyOf(draftOf(role, wh), wh));
  const edit = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setProblem(null);
    setSaved(false);
  };
  const pick = (id: string) => {
    if (id === roleId) return;
    if (dirty) return setAsking(id);
    open(id);
  };
  const open = (id: string) => {
    const next = roles.find((r) => r.id === id)!;
    setRoleId(id);
    setDraft(draftOf(next, wh));
    setAsking(null);
    setProblem(null);
    setSaved(false);
    setTyped("");
  };
  const here = draft.list.some((n) => networkHolds(n, initial.yourIp));
  const typedOk = isNetwork(typed);
  const add = (n: string) => {
    if (!draft.list.includes(n)) edit({ list: [...draft.list, n] });
  };

  const save = async () => {
    if (draft.hours === "custom" && (!draft.days.length || draft.from >= draft.to))
      return setProblem({
        text: draft.days.length ? "The hours must end after they start." : "Pick at least one day.",
        lockout: false,
      });
    if (draft.nets === "only" && !draft.list.length)
      return setProblem({ text: "Add at least one network, or choose Anywhere.", lockout: false });
    setBusy(true);
    const r = await api.put<{ role: RoleAccess }>(`/api/v1/security/access/${role.id}`, bodyOf(draft, wh));
    setBusy(false);
    if (!r.ok) {
      const lockout = r.code === "WOULD_LOCK_YOU_OUT";
      setProblem({ text: r.message, lockout });
      if (lockout) queueMicrotask(() => (addHere.current ?? field.current)?.focus());
      return;
    }
    setRoles(roles.map((x) => (x.id === role.id ? r.data.role : x)));
    setDraft(draftOf(r.data.role, wh));
    setSaved(true);
  };

  const week = weekFrom(initial.weekStart);
  return (
    <div className={s.access}>
      <section className={`${s.panel} ${s.roles}`} role="group" aria-label="Roles">
        <div className={s.eyebrow}>Roles</div>
        {roles.map((r) => (
          <button
            key={r.id}
            type="button"
            className={s.role}
            aria-pressed={r.id === roleId}
            onClick={() => pick(r.id)}
          >
            <b>{r.name}</b> <span>{r.people === 1 ? "1 person" : `${r.people} people`}</span>
          </button>
        ))}
        <p className={s.safe}>The owner is never limited.</p>
      </section>

      <div className={s.stack}>
        <AnimatePresence initial={false}>
          {asking && (
            <motion.div
              role="alertdialog"
              aria-labelledby={askId}
              className={s.ask}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={toMotion(SPRINGS.default)}
            >
              <p id={askId}>Discard changes to {role.name}?</p>
              <div className={s.askActions}>
                <Button size="sm" variant="ghost" onClick={() => setAsking(null)} autoFocus>
                  Keep editing
                </Button>
                <Button size="sm" variant="danger" onClick={() => open(asking)}>
                  Discard
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <section className={`${s.panel} ${s.q}`}>
          <h2 className={s.h3}>When can {role.name} sign in?</h2>
          <Cards
            label={`When can ${role.name} sign in?`}
            value={draft.hours}
            onChange={(hours) => edit({ hours })}
            options={[
              { value: "any", title: "Any time", detail: "No limit" },
              { value: "business", title: "Business hours", detail: hoursInWords(wh, initial.weekStart) },
              { value: "custom", title: "Custom", detail: "Pick the days and hours" },
            ]}
          />
          <div className={s.reveal} data-open={draft.hours === "custom"} inert={draft.hours !== "custom"}>
            <div>
              <div className={s.days}>
                {week.map((d) => {
                  const on = draft.days.includes(d);
                  const span = `${clockWords(draft.from)} – ${clockWords(draft.to)}`;
                  return (
                    <button
                      key={d}
                      type="button"
                      className={s.day}
                      aria-pressed={on}
                      aria-label={`${DAY_NAMES[d]}, ${on ? span : "off"}`}
                      onClick={() =>
                        edit({ days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d] })
                      }
                    >
                      <b>{DAY_NAMES[d]!.slice(0, 3)}</b>
                      <span>
                        {on
                          ? `${clockWords(draft.from).replace(":00", "")}–${clockWords(draft.to).replace(":00", "")}`
                          : "Off"}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className={s.times}>
                <label>
                  From
                  <select value={draft.from} onChange={(e) => edit({ from: e.target.value })}>
                    {TIMES.map((t) => (
                      <option key={t} value={t}>
                        {clockWords(t)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  To
                  <select value={draft.to} onChange={(e) => edit({ to: e.target.value })}>
                    {END_TIMES.map((t) => (
                      <option key={t} value={t}>
                        {clockWords(t)}
                      </option>
                    ))}
                  </select>
                </label>
                <span className={s.cap}>business time ({zoneInWords(initial.timezone)})</span>
              </div>
            </div>
          </div>
          <p className={s.safe}>
            Outside these hours they can’t sign in, and anyone still signed in is signed out.
          </p>
        </section>

        <section className={`${s.panel} ${s.q}`}>
          <h2 className={s.h3}>Where can {role.name} sign in from?</h2>
          <Cards
            label={`Where can ${role.name} sign in from?`}
            value={draft.nets}
            onChange={(nets) => edit({ nets })}
            options={[
              { value: "any", title: "Anywhere", detail: "Office, home, phone" },
              { value: "only", title: "Only these networks", detail: "Such as your office Wi-Fi" },
            ]}
          />
          <div className={s.reveal} data-open={draft.nets === "only"} inert={draft.nets !== "only"}>
            <div className={s.nets}>
              {draft.list.map((n) => (
                <div key={n} className={s.net}>
                  <code>{n}</code>
                  {networkHolds(n, initial.yourIp) ? (
                    <span className={s.hereChip}>Where you are now</span>
                  ) : (
                    <span />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => edit({ list: draft.list.filter((x) => x !== n) })}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <form
                className={s.addNet}
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!typedOk) return;
                  add(typed.trim());
                  setTyped("");
                }}
              >
                <label className={s.srOnly} htmlFor={`${askId}-net`}>
                  Network address
                </label>
                <input
                  id={`${askId}-net`}
                  ref={field}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="94.200.12.0/24"
                  spellCheck={false}
                  autoComplete="off"
                  inputMode="decimal"
                  aria-invalid={typed !== "" && !typedOk}
                />
                <Button size="sm" type="submit" disabled={!typedOk}>
                  Add
                </Button>
                {typed !== "" && !typedOk && (
                  <span className={s.fieldProblem}>That isn’t a network address</span>
                )}
              </form>
              {!here && (
                <div className={s.here}>
                  <span>
                    You’re on <code>{initial.yourIp}</code> right now.
                  </span>
                  <Button size="sm" ref={addHere} onClick={() => add(initial.yourIp)}>
                    Add this network
                  </Button>
                </div>
              )}
            </div>
          </div>
        </section>

        {problem && (
          <p role="alert" className={problem.lockout ? s.warning : s.problem}>
            {problem.text}
          </p>
        )}
        {saved && (
          <p role="status" className={s.saved}>
            Saved. {role.name}’s limits apply from their next request.
          </p>
        )}
        <AnimatePresence>
          {dirty && (
            <motion.div
              className={s.saveBar}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
              transition={toMotion(SPRINGS.drawer)}
            >
              <span>Changes to {role.name}</span>
              <Button variant="ghost" onClick={() => open(role.id)}>
                Discard
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void save()}>
                Save changes
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Option cards that are real radios (arrow keys move between them; each reads its title and detail). */
function Cards<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; title: string; detail: string }[];
  onChange: (v: T) => void;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={s.cards}>
      {options.map((o) => (
        <label key={o.value} className={[s.opt, value === o.value && s.optOn].filter(Boolean).join(" ")}>
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className={s.radioInput}
          />
          <span className={s.radio} aria-hidden />
          <span>
            <b>{o.title}</b> <span className={s.detail}>{o.detail}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
