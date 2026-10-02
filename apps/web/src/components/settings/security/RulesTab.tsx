"use client";
import { useEffect, useId, useRef, useState } from "react";
import {
  RULES,
  RULE_IDS,
  type AnomalySettings,
  type RuleAction,
  type RuleId,
  type WatermarkMode,
} from "@lume/core/shared";
import { Watermark, watermarkText } from "@/components/security/Watermark";
import { Switch } from "@/components/ui/Switch";
import { api } from "@/lib/api";
import { ruleSentence, type SecuritySettings } from "@/lib/settings/security";
import s from "./security.module.css";

type Viewer = { name: string; email: string; today: string };

const SUMMARY: Record<RuleAction, string> = {
  off: "Off",
  alert: "LUME tells you",
  suspend: "LUME tells you, ends their sessions and pauses sign-in",
};
const UNIT: Record<RuleId, string> = {
  reveals: "contacts an hour",
  leadsOpened: "different leads an hour",
  queueRuns: "runs a day",
};
const WATERMARK: { mode: WatermarkMode; title: string; detail: string }[] = [
  {
    mode: "masked_roles",
    title: "People who can’t see every contact",
    detail: "Recommended. Sales see it; admins don’t.",
  },
  { mode: "everyone", title: "Everyone", detail: "Admins too." },
  { mode: "off", title: "Nobody", detail: "No watermark on lead screens." },
];
/** A limit's changes are saved once the stepping stops, so ten taps make one change in the audit log. */
const STEP_SAVE_MS = 700;

/**
 * Settings → Security → Rules (6A, canvas [Rules]): what LUME watches for, at what limit, and what it does then;
 * and who carries the on-screen watermark. Every change saves at once and is put back if the save fails.
 */
export function RulesTab({ initial, viewer }: { initial: SecuritySettings; viewer: Viewer }) {
  const [draft, setDraft] = useState(initial);
  const [open, setOpen] = useState<RuleId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<{ key: string; n: number } | null>(null);
  const saved = useRef(initial);
  // The action a rule had before it was switched off, so switching it on again brings it back.
  const lastAction = useRef<Record<RuleId, Exclude<RuleAction, "off">>>(
    Object.fromEntries(
      RULE_IDS.map((id) => {
        const a = initial.anomaly[id].action;
        return [id, a === "off" ? (RULES[id].default.action as Exclude<RuleAction, "off">) : a];
      }),
    ) as Record<RuleId, Exclude<RuleAction, "off">>,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const save = async (next: SecuritySettings, key: string) => {
    const r = await api.put<SecuritySettings>("/api/v1/security/settings", next);
    if (!r.ok) {
      setDraft(saved.current);
      setProblem(r.message);
      return;
    }
    saved.current = next;
    setProblem(null);
    setSavedAt((p) => ({ key, n: (p?.n ?? 0) + 1 }));
  };
  const change = (next: SecuritySettings, key: string, later = false) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    if (later) timer.current = setTimeout(() => void save(next, key), STEP_SAVE_MS);
    else void save(next, key);
  };
  const setRule = (id: RuleId, patch: Partial<AnomalySettings[RuleId]>, later = false) =>
    change({ ...draft, anomaly: { ...draft.anomaly, [id]: { ...draft.anomaly[id], ...patch } } }, id, later);

  return (
    <div className={s.stack}>
      <div>
        <h2 className={s.h3}>Tell me when someone…</h2>
        <p className={s.who}>
          Applies to everyone who can’t see every contact. Never to you. Counted over the last 60 minutes, so
          a burst across the hour still counts.
        </p>
      </div>
      {problem && (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      )}
      <p role="status" className={s.srOnly}>
        {savedAt ? "Saved" : ""}
      </p>
      <div className={s.rules}>
        {RULE_IDS.map((id) => (
          <RuleRow
            key={id}
            id={id}
            value={draft.anomaly[id]}
            open={open === id}
            savedTick={savedAt?.key === id ? savedAt.n : 0}
            onToggle={() => setOpen((o) => (o === id ? null : id))}
            onSwitch={(on) => {
              if (!on) {
                const a = draft.anomaly[id].action;
                if (a !== "off") lastAction.current[id] = a;
              }
              setRule(id, { action: on ? lastAction.current[id] : "off" });
            }}
            onThreshold={(n) => setRule(id, { threshold: n }, true)}
            onAction={(a) => {
              lastAction.current[id] = a;
              setRule(id, { action: a });
            }}
          />
        ))}
      </div>

      <div>
        <h2 className={s.h3}>On-screen watermark</h2>
        <p className={s.sub}>
          A faint name and email across lead screens. It can’t stop a screenshot, but it shows whose it was.
        </p>
      </div>
      <section className={`${s.panel} ${s.wm}`}>
        <Choices
          name="watermark"
          label="Who sees the watermark"
          value={draft.watermark}
          options={WATERMARK.map((w) => ({ value: w.mode, title: w.title, detail: w.detail }))}
          onChange={(m) => change({ ...draft, watermark: m }, "watermark")}
        />
        <div className={s.preview} data-testid="watermark-preview" data-mode={draft.watermark} aria-hidden>
          {[78, 62, 88, 54, 70].map((w, i) => (
            <span key={i} className={s.line} style={{ width: `${w}%` }} />
          ))}
          <div className={draft.watermark === "off" ? `${s.markWrap} ${s.markOff}` : s.markWrap}>
            <Watermark text={watermarkText(viewer)} scale={0.72} />
          </div>
        </div>
      </section>
    </div>
  );
}

function RuleRow({
  id,
  value,
  open,
  savedTick,
  onToggle,
  onSwitch,
  onThreshold,
  onAction,
}: {
  id: RuleId;
  value: AnomalySettings[RuleId];
  open: boolean;
  savedTick: number;
  onToggle: () => void;
  onSwitch: (on: boolean) => void;
  onThreshold: (n: number) => void;
  onAction: (a: Exclude<RuleAction, "off">) => void;
}) {
  const def = RULES[id];
  const titleId = useId();
  const bodyId = useId();
  const on = value.action !== "off";
  const sentence = ruleSentence(id, value.threshold);
  const actions = def.actions.filter((a): a is Exclude<RuleAction, "off"> => a !== "off");
  const step = (dir: 1 | -1) =>
    onThreshold(Math.min(def.max, Math.max(def.min, value.threshold + dir * def.step)));

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={[s.rule, open && s.ruleOpen, !on && s.ruleOff].filter(Boolean).join(" ")}
    >
      <div className={s.ruleHead}>
        <button
          type="button"
          className={s.ruleHit}
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          tabIndex={-1}
        >
          <span className={s.ruleTitle}>
            <span id={titleId}>{sentence}</span>
            {savedTick > 0 && (
              <span key={savedTick} className={s.tick} aria-hidden>
                Saved
              </span>
            )}
          </span>
          <span className={s.ruleSum}>{SUMMARY[value.action]}</span>
        </button>
        <button
          type="button"
          className={s.edit}
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          {open ? "Done" : "Edit"}
        </button>
        <Switch checked={on} onChange={onSwitch} label={sentence} labelHidden />
      </div>
      <div id={bodyId} className={s.ruleBody} inert={!open}>
        <div>
          <div className={s.form}>
            <div className={s.row}>
              <span className={s.lbl}>Limit</span>
              <span className={s.stepper}>
                <button
                  type="button"
                  aria-label="Lower limit"
                  disabled={value.threshold <= def.min}
                  onClick={() => step(-1)}
                >
                  −
                </button>
                <output className={s.num} aria-live="polite">
                  {value.threshold}
                </output>
                <button
                  type="button"
                  aria-label="Higher limit"
                  disabled={value.threshold >= def.max}
                  onClick={() => step(1)}
                >
                  +
                </button>
              </span>
              <span className={s.sub}>{UNIT[id]}</span>
            </div>
            <div className={s.row}>
              <span className={s.lbl}>Then LUME</span>
              <Choices
                name={`${id}-action`}
                label="Then LUME"
                value={on ? (value.action as Exclude<RuleAction, "off">) : null}
                options={actions.map((a) =>
                  a === "alert"
                    ? {
                        value: a,
                        title: "Tells you",
                        detail: "An alert for you and other admins. Nothing changes for them.",
                      }
                    : {
                        value: a,
                        title: "Tells you and pauses their access",
                        detail: "Their sessions end and they can’t sign in until an admin restores them.",
                      },
                )}
                onChange={onAction}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Option cards that are real radios: arrow keys move between them, and each reads its title and detail. */
function Choices<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
}: {
  name: string;
  label: string;
  value: T | null;
  options: { value: T; title: string; detail: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={s.choices}>
      {options.map((o) => (
        <label key={o.value} className={[s.opt, value === o.value && s.optOn].filter(Boolean).join(" ")}>
          <input
            type="radio"
            name={name}
            value={o.value}
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
