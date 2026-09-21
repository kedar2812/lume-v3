import type { ReactNode } from "react";
import s from "./Chip.module.css";

export type Tone = "neutral" | "accent" | "danger" | "warn" | "meet" | "ok";
const TONE_VAR: Record<Tone, string> = {
  neutral: "var(--text-3)",
  accent: "var(--accent)",
  danger: "var(--danger)",
  warn: "var(--warn)",
  meet: "var(--meet)",
  ok: "var(--ok)",
};

export function Chip({
  tone = "neutral",
  selected = false,
  dot = false,
  children,
}: {
  tone?: Tone;
  selected?: boolean;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={[s.chip, selected && s.selected].filter(Boolean).join(" ")} data-tone={tone}>
      {dot && <i className={s.dot} style={{ background: TONE_VAR[tone] }} />}
      {children}
    </span>
  );
}
