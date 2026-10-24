"use client";
import type { AiProfile } from "@lume/core/shared";
import { useState } from "react";
import { PermissionRows } from "@/components/autopilot/PermissionRows";
import { Field } from "@/components/ui/Field";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import s from "./ai.module.css";

type Standing = AiProfile["standing"];
type Stage = { id: string; name: string; pipeline: string };

/**
 * Settings → LUME AI, Standing choices (Autopilot spec 2026-10-19 §1.1–1.3, §3): what a new run starts with. Presets set
 * every row at once; a row changed by hand leaves them unpressed. On a phone the three-way controls sit full width under
 * each action (§2.3).
 */
export function StandingSection({
  value: v,
  stages,
  speakers,
  onChange,
}: {
  value: Standing;
  stages: Stage[];
  speakers: { id: string; name: string }[];
  onChange(v: Standing): void;
}) {
  const set = (patch: Partial<Standing>) => onChange({ ...v, ...patch });
  const [capText, setCapText] = useState(v.dailyCap === null ? "" : String(v.dailyCap));
  const manyPipelines = new Set(stages.map((x) => x.pipeline)).size > 1;

  return (
    <div className={s.standing}>
      <div role="group" aria-label="Goal stages" className={s.block}>
        <h3 className={s.blockTitle}>Goal stages</h3>
        <p className={s.blockLede}>Ready-made goals for a run, from your pipeline. Up to five.</p>
        <div className={s.chips}>
          {stages.map((x) => {
            const on = v.goalStages.includes(x.id);
            return (
              <button
                key={x.id}
                type="button"
                className={s.chip}
                aria-pressed={on}
                disabled={!on && v.goalStages.length >= 5}
                onClick={() =>
                  set({ goalStages: on ? v.goalStages.filter((g) => g !== x.id) : [...v.goalStages, x.id] })
                }
              >
                {manyPipelines && <small>{x.pipeline} · </small>}
                {x.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className={s.block}>
        <h3 className={s.blockTitle}>What can LUME AI do for you?</h3>
        <PermissionRows
          value={v.permissions}
          onChange={(permissions) => set({ permissions })}
          followUpDays={v.followUpDays}
          stages={stages}
        />
      </div>

      <div className={s.block}>
        <div className={s.pair}>
          <Field label="Speaks as" hint="Their name goes in the messages.">
            {(c) => (
              <select
                {...c}
                value={v.speaker ?? ""}
                onChange={(e) => set({ speaker: e.target.value || null })}
              >
                <option value="">Whoever starts the run</option>
                {speakers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div role="group" aria-label="Follow up after" className={s.days}>
            <span className={s.label}>Follow up after</span>
            <div className={s.chips}>
              {v.followUpDays.map((d) => (
                <span key={d} className={s.day}>
                  Day {d}
                  <button
                    type="button"
                    aria-label={`Remove day ${d}`}
                    disabled={v.followUpDays.length === 1}
                    onClick={() => set({ followUpDays: v.followUpDays.filter((x) => x !== d) })}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      aria-hidden
                    >
                      <path d="M7 7l10 10M17 7L7 17" />
                    </svg>
                  </button>
                </span>
              ))}
              {v.followUpDays.length < 4 && (
                <select
                  className={s.addDay}
                  aria-label="Add a follow-up day"
                  value=""
                  onChange={(e) =>
                    e.target.value &&
                    set({ followUpDays: [...v.followUpDays, Number(e.target.value)].sort((a, b) => a - b) })
                  }
                >
                  <option value="">+ Day</option>
                  {Array.from({ length: 30 }, (_, i) => i + 1)
                    .filter((d) => !v.followUpDays.includes(d))
                    .map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                </select>
              )}
            </div>
          </div>
        </div>

        <div className={s.capRow}>
          <Switch
            checked={v.dailyCap !== null}
            label="Set my own daily cap"
            onChange={(on) => {
              setCapText(on ? "40" : "");
              set({ dailyCap: on ? 40 : null });
            }}
          />
          {v.dailyCap === null ? (
            <span className={s.capNote}>Follows your number&apos;s WhatsApp messaging tier.</span>
          ) : (
            <label className={s.capNote}>
              <input
                type="number"
                min={1}
                max={10_000}
                inputMode="numeric"
                className={`${s.input} ${s.capInput}`}
                aria-label="Messages a day, at most"
                value={capText}
                onChange={(e) => {
                  setCapText(e.target.value);
                  const n = Number(e.target.value);
                  if (Number.isInteger(n) && n >= 1) set({ dailyCap: n });
                }}
              />
              a day, at most
            </label>
          )}
        </div>

        <div className={s.choice}>
          <span className={s.label}>If someone asks whether they&apos;re talking to a bot</span>
          <SegmentedControl
            size="sm"
            label="If someone asks whether they're talking to a bot"
            value={v.botQuestion}
            options={[
              { value: "say_so", label: "Say so honestly" },
              { value: "hand_over", label: "Hand over to a person" },
            ]}
            onChange={(botQuestion) => set({ botQuestion })}
          />
        </div>
        <div className={s.choice}>
          <span className={s.label}>Replies outside working hours</span>
          <SegmentedControl
            size="sm"
            label="Replies outside working hours"
            value={v.outsideHours}
            options={[
              { value: "reply_any_time", label: "Reply any time" },
              { value: "wait", label: "Wait for working hours" },
            ]}
            onChange={(outsideHours) => set({ outsideHours })}
          />
        </div>
      </div>
    </div>
  );
}
