"use client";
import {
  AUTOPILOT_PRESETS,
  presetOf,
  type Allow,
  type AutopilotAction,
  type AutopilotPreset,
} from "@lume/core/shared";
import Link from "next/link";
import { useId } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { Available } from "@/lib/autopilot/types";
import s from "./permissions.module.css";

type Permissions = Record<AutopilotAction, Allow>;
type Stage = { id: string; name: string; pipeline: string };

const PRESET_WORDS: { key: AutopilotPreset; label: string; sub: string }[] = [
  { key: "careful", label: "Careful", sub: "Asks before anything that changes a lead" },
  { key: "balanced", label: "Balanced", sub: "Talks and books, asks about the rest" },
  { key: "hands_off", label: "Hands-off", sub: "Does all of it; you step in when you want" },
];
const ALLOW: readonly { value: Allow; label: string }[] = [
  { value: "go", label: "Go ahead" },
  { value: "ask", label: "Ask me" },
  { value: "never", label: "Never" },
];
/** The words on a row's link to set it up. */
const FIX_WORDS: Partial<Record<AutopilotAction, string>> = {
  send_files: "Choose files",
  answer_prices: "Set up prices",
  mark_lost: "Add lost reasons",
  first_messages: "Set up templates",
};
const dayList = (ds: number[]) =>
  ds.length === 1
    ? `Day ${ds[0]}, then stops`
    : `Day ${ds.slice(0, -1).join(", day ")} and day ${ds.at(-1)}, then stops`;
const path = (stages: Stage[]) => {
  const names = stages.map((x) => x.name);
  return names.length > 4 ? `${names.slice(0, 3).join(" → ")} → …` : names.join(" → ");
};

/** The rows of §1.3, grouped as the owner approved them, each named from the business's own setup where it can be. */
function groups(
  followUpDays: number[],
  stages: Stage[],
): { name: string; rows: { key: AutopilotAction; title: string; sub: string }[] }[] {
  return [
    {
      name: "Messages",
      rows: [
        { key: "first_messages", title: "Send first messages", sub: "With your approved WhatsApp templates" },
        { key: "follow_ups", title: "Follow up when there's no reply", sub: dayList(followUpDays) },
        {
          key: "replies",
          title: "Reply and keep the conversation going",
          sub: "In your voice, from what LUME AI knows",
        },
        { key: "send_files", title: "Send files", sub: "The files chosen in Settings → LUME AI, from Media" },
      ],
    },
    {
      name: "Pipeline",
      rows: [
        { key: "book_meetings", title: "Book meetings", sub: "On free slots in your calendar" },
        { key: "move_stages", title: "Move leads along your pipeline", sub: path(stages) || "Your stages" },
        { key: "set_follow_ups", title: "Set follow-up reminders", sub: "For the speaker or the lead's rep" },
        { key: "fill_fields", title: "Fill in lead details", sub: "Your lead fields" },
      ],
    },
    {
      name: "Careful",
      rows: [
        { key: "answer_prices", title: "Answer price questions", sub: "Only from your price list" },
        { key: "mark_lost", title: "Mark a lead lost", sub: "With one of your lost reasons" },
        { key: "hand_to_rep", title: "Hand a lead to a rep", sub: "By your assignment rules" },
      ],
    },
  ];
}

/**
 * What LUME AI may do (Autopilot spec 2026-10-19 §1.3), for Settings → LUME AI and the start sheet alike: the presets
 * (pressed only while every row matches one), and each action's three-way choice. An action the business can't use yet
 * shows off at Never with why and a link to set it up; the choice underneath is kept for when it is. On a phone the
 * three-way controls sit full width under each action (§2.3).
 */
export function PermissionRows({
  value,
  onChange,
  followUpDays,
  stages,
  available,
}: {
  value: Permissions;
  onChange(v: Permissions): void;
  followUpDays: number[];
  stages: Stage[];
  available?: Record<AutopilotAction, Available>;
}) {
  const pressed = presetOf(value);
  const id = useId();
  return (
    <div className={s.root}>
      <div className={s.presets}>
        {PRESET_WORDS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={s.preset}
            aria-pressed={pressed === p.key}
            onClick={() => onChange({ ...AUTOPILOT_PRESETS[p.key] })}
          >
            <b>{p.label}</b>
            <span>{p.sub}</span>
          </button>
        ))}
      </div>
      {groups(followUpDays, stages).map((g) => (
        <div key={g.name} role="group" aria-label={g.name} className={s.group}>
          <p className={s.groupName} aria-hidden>
            {g.name}
          </p>
          {g.rows.map((r) => {
            const a = available?.[r.key];
            const off = a && !a.ok ? a : null;
            const why = `${id}-${r.key}`;
            return (
              <div key={r.key} className={s.row} data-off={off ? "" : undefined}>
                <div className={s.words}>
                  <b>{r.title}</b>
                  {off ? (
                    <span id={why} className={s.why}>
                      {off.why}
                      {off.fixHref && (
                        <>
                          {" "}
                          <Link href={off.fixHref} className={s.fix}>
                            {FIX_WORDS[r.key] ?? "Set it up"}
                          </Link>
                        </>
                      )}
                    </span>
                  ) : (
                    <span>{r.sub}</span>
                  )}
                </div>
                <SegmentedControl
                  size="sm"
                  label={r.title}
                  value={off ? "never" : value[r.key]}
                  options={ALLOW}
                  disabled={!!off}
                  {...(off ? { describedBy: why } : {})}
                  onChange={(v) => onChange({ ...value, [r.key]: v })}
                />
              </div>
            );
          })}
        </div>
      ))}
      <ul className={s.always}>
        <li>
          <b>Always on.</b> &ldquo;Stop&rdquo; means stop: LUME AI says sorry once and marks them do not
          contact.
        </li>
        <li>It never invents a price, discount or promise you didn&apos;t give it.</li>
      </ul>
    </div>
  );
}
