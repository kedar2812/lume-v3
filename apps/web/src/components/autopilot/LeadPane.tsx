"use client";
import { useState } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { nearDay, timeOf } from "@/lib/dates";
import type { RunAsk, RunLead } from "@/lib/autopilot/types";
import { leadLine, leadsIn, whenWords, type LeadFilter } from "@/lib/autopilot/words";
import s from "./pane.module.css";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";
const fmt = (n: number) => n.toLocaleString("en-US");
const EMPTY: Record<LeadFilter, string> = {
  needs: "Nobody needs you right now.",
  ready: "No one is ready for you yet.",
  all: "No one in this run LUME AI can message.",
};

/**
 * The leads of a run (plan 2026-10-28, artboards 1–3), as Mail lists messages: one filter (Needs you, Ready, All, each
 * with how many), and each lead in one row: initials on a neutral circle, the name, when it last changed, and one line
 * of what's happening, with a dot only where it matters. The lead LUME AI is on says so to a screen reader; the one
 * shown on the right is pressed. The skipped fold away under All, each with why.
 */
export function LeadPane({
  leads,
  asks,
  filter,
  onFilter,
  currentId,
  selectedId,
  onSelect,
  tz,
  now,
}: {
  leads: RunLead[];
  asks: RunAsk[];
  filter: LeadFilter;
  onFilter(f: LeadFilter): void;
  /** The lead LUME AI is on. */
  currentId: string | null;
  /** The lead shown in the conversation. */
  selectedId: string | null;
  onSelect(leadId: string): void;
  tz: string;
  now: Date;
}) {
  const [showSkipped, setShowSkipped] = useState(false);
  const shown = leadsIn(leads, filter);
  const skipped = leads.filter((l) => l.state === "skipped");
  const when = (iso: string) => whenWords(iso, tz, now);
  // The row's corner: a time today, else the day.
  const corner = (iso: string) => {
    const d = new Date(iso);
    const day = nearDay(d, tz, now);
    return day === "Today" ? timeOf(d, tz) : day.split(",")[0]!;
  };
  return (
    <section className={s.pane} aria-label="Leads">
      <div className={s.filter}>
        <SegmentedControl
          label="Show"
          value={filter}
          options={[
            { value: "needs", label: `Needs you ${fmt(leadsIn(leads, "needs").length)}` },
            { value: "ready", label: `Ready ${fmt(leadsIn(leads, "ready").length)}` },
            { value: "all", label: `All ${fmt(leadsIn(leads, "all").length)}` },
          ]}
          onChange={onFilter}
        />
      </div>
      {shown.length === 0 ? (
        <p className={s.empty}>{EMPTY[filter]}</p>
      ) : (
        <ul className={s.rows} aria-label="Leads in this run">
          {shown.map((l) => {
            const ask = asks.find((a) => a.leadId === l.leadId) ?? null;
            const line = leadLine(l, ask, when);
            const current = l.leadId === currentId;
            return (
              <li key={l.leadId}>
                <button
                  type="button"
                  className={s.row}
                  aria-pressed={l.leadId === selectedId}
                  aria-label={`${l.name}, ${line.text}${current ? ", LUME AI is on this lead" : ""}`}
                  onClick={() => onSelect(l.leadId)}
                >
                  <span className={s.avatar} aria-hidden>
                    {initials(l.name)}
                  </span>
                  <span className={s.rowMain} aria-hidden>
                    <span className={s.rowTop}>
                      <b>{l.name}</b>
                      <span className={s.corner}>{corner(l.updatedAt)}</span>
                    </span>
                    <span className={s.line}>
                      {line.dot && <i className={s.dot} data-dot={line.dot} />}
                      <span>{line.text}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {filter === "all" && skipped.length > 0 && (
        <div className={s.skipped}>
          <button
            type="button"
            className={s.skippedToggle}
            aria-expanded={showSkipped}
            onClick={() => setShowSkipped((x) => !x)}
          >
            {fmt(skipped.length)} skipped
          </button>
          {showSkipped && (
            <ul className={s.skippedList}>
              {skipped.map((l) => (
                <li key={l.leadId}>
                  <b>{l.name}</b>
                  <span>{l.reason ?? "Skipped"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
