"use client";
import { useState } from "react";
import { api } from "@/lib/client";

type Module = "googleSheets" | "webhooks" | "googleCalendar" | "calendly" | "ai" | "whatsapp";
export type Plan = {
  places: number | null;
  modules: Record<Module, boolean>;
  aiReadsHourly: number | null;
  aiReadsWeekly: number | null;
};
/** `knowsAi`: their LUME accepts plan2, so it keeps LUME AI, WhatsApp and the AI limits (spec 2026-10-18 §2.2). */
export type Usage = { people: number; modulesOn: string[]; knows: boolean; knowsAi: boolean };

const MODULES: { key: Module; name: string; mark: string | null }[] = [
  { key: "googleSheets", name: "Google Sheets", mark: "/brand/google-sheets.png" },
  { key: "webhooks", name: "Webhooks", mark: null },
  { key: "googleCalendar", name: "Google Calendar", mark: "/brand/google-calendar.png" },
  { key: "calendly", name: "Calendly", mark: "/brand/calendly.svg" },
  { key: "ai", name: "LUME AI", mark: null },
  { key: "whatsapp", name: "WhatsApp", mark: "/brand/whatsapp.svg" },
];
const AI_LIMITS = [
  { key: "aiReadsHourly", label: "AI reads an hour", most: 100_000 },
  { key: "aiReadsWeekly", label: "AI reads a week", most: 1_000_000 },
] as const;
/** What's typed in an AI limit: empty is no limit; a whole number from 1 to its most; anything else is invalid. */
const limitOf = (typed: string, most: number): number | null | "invalid" => {
  const t = typed.trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return "invalid";
  const n = Number(t);
  return n >= 1 && n <= most ? n : "invalid";
};
const DEFAULT_PLACES = 5;

/**
 * Plan limits (spec 2026-10-17 control §3.3): how many places a client's LUME has, and which modules are in its
 * plan. Kept by their LUME from its next check-in; nothing there is ever removed.
 */
export function PlanLimits({
  clientId,
  clientName,
  version,
  plan,
  usage,
  onSaved,
}: {
  clientId: string;
  clientName: string;
  version: string | null;
  plan: Plan;
  usage: Usage;
  onSaved: (data: unknown) => void;
}) {
  const [unlimited, setUnlimited] = useState(plan.places === null);
  const [places, setPlaces] = useState(plan.places ?? Math.max(DEFAULT_PLACES, usage.people + 1));
  const [modules, setModules] = useState(plan.modules);
  const [typed, setTyped] = useState({
    aiReadsHourly: plan.aiReadsHourly === null ? "" : String(plan.aiReadsHourly),
    aiReadsWeekly: plan.aiReadsWeekly === null ? "" : String(plan.aiReadsWeekly),
  });
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const hourly = limitOf(typed.aiReadsHourly, 100_000);
  const weekly = limitOf(typed.aiReadsWeekly, 1_000_000);
  const invalid = hourly === "invalid" || weekly === "invalid";
  const now = {
    places: unlimited ? null : places,
    modules,
    aiReadsHourly: hourly === "invalid" ? null : hourly,
    aiReadsWeekly: weekly === "invalid" ? null : weekly,
  };
  const dirty =
    now.places !== plan.places ||
    MODULES.some((m) => modules[m.key] !== plan.modules[m.key]) ||
    now.aiReadsHourly !== plan.aiReadsHourly ||
    now.aiReadsWeekly !== plan.aiReadsWeekly;
  const change = (f: () => void) => {
    f();
    setSaved(false);
  };
  const free = places - usage.people;
  const peopleLine = unlimited
    ? `${usage.people} ${usage.people === 1 ? "person uses" : "people use"} it now.`
    : free < 0
      ? `${usage.people} people use it now: nobody loses access, but no one new can be added until there’s room.`
      : `${usage.people} ${usage.people === 1 ? "person uses" : "people use"} it now: ${free} ${free === 1 ? "place" : "places"} free.`;

  const save = async () => {
    setBusy(true);
    setProblem(null);
    const r = await api.patch(`/api/clients/${clientId}/plan`, now);
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    setSaved(true);
    onSaved(r.data);
  };

  return (
    <section className="card" aria-label="Plan limits" style={{ animationDelay: ".04s" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <h2 className="h">Plan limits</h2>
        <span className="note">Kept by their LUME</span>
      </div>
      {!usage.knows && (
        <p className="note" style={{ margin: 0, fontSize: 13, color: "var(--ink2)" }}>
          Their LUME{version ? ` (${version})` : ""} can’t keep a plan yet; it will once it’s updated. What
          you set here waits for it.
        </p>
      )}
      <div className="pl-group">
        <span className="pl-label">Places</span>
        <div className="pl-row">
          <div className="chips" role="radiogroup" aria-label="Places">
            <button
              type="button"
              className="chip"
              role="radio"
              aria-checked={unlimited}
              onClick={() => change(() => setUnlimited(true))}
            >
              No limit
            </button>
            <button
              type="button"
              className="chip"
              role="radio"
              aria-checked={!unlimited}
              onClick={() => change(() => setUnlimited(false))}
            >
              A number
            </button>
          </div>
          {!unlimited && (
            <div className="pl-step" role="group" aria-label="How many places">
              <button
                type="button"
                aria-label="One fewer"
                disabled={places <= 1}
                onClick={() => change(() => setPlaces((n) => Math.max(1, n - 1)))}
              >
                −
              </button>
              <span className="num" aria-live="polite">
                {places}
              </span>
              <button
                type="button"
                aria-label="One more"
                disabled={places >= 10_000}
                onClick={() => change(() => setPlaces((n) => Math.min(10_000, n + 1)))}
              >
                +
              </button>
            </div>
          )}
        </div>
        <span className={`note${!unlimited && free < 0 ? " pl-warn" : ""}`}>{peopleLine}</span>
      </div>
      <div className="pl-group">
        <span className="pl-label">Modules</span>
        {MODULES.map((m) => {
          const on = modules[m.key];
          const onNow = usage.modulesOn.includes(m.key);
          const warn = !on && onNow;
          return (
            <div key={m.key} className="pl-mod">
              <span className="pl-mark" aria-hidden>
                {m.mark ? (
                  <img src={m.mark} alt="" width={20} height={20} />
                ) : m.key === "ai" ? (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 3.5 13.8 9a2 2 0 0 0 1.2 1.2l5.5 1.8-5.5 1.8a2 2 0 0 0-1.2 1.2L12 20.5 10.2 15A2 2 0 0 0 9 13.8L3.5 12 9 10.2A2 2 0 0 0 10.2 9z" />
                  </svg>
                ) : (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
                    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
                  </svg>
                )}
              </span>
              <span className="pl-mod-words">
                <b>{m.name}</b>
                <span className={warn ? "pl-warn" : "note"}>
                  {warn
                    ? `On at ${clientName} now — switching it off stops it at their next check-in.`
                    : on
                      ? onNow
                        ? "In their plan · on now"
                        : "In their plan"
                      : "Not in their plan"}
                </span>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`${m.name} in their plan`}
                className="pl-switch"
                onClick={() => change(() => setModules((x) => ({ ...x, [m.key]: !x[m.key] })))}
              >
                <span className="pl-track" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="pl-group">
        <span className="pl-label">LUME AI limits</span>
        {usage.knows && !usage.knowsAi && (
          <span className="note">
            Their LUME{version ? ` (${version})` : ""} can’t keep LUME AI and WhatsApp settings yet; it will once
            it’s updated.
          </span>
        )}
        <div className="pl-row">
          {AI_LIMITS.map((l) => {
            const bad = limitOf(typed[l.key], l.most) === "invalid";
            return (
              <label key={l.key} className="field pl-limit">
                <span>{l.label}</span>
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={l.most}
                  step={1}
                  placeholder="No limit"
                  value={typed[l.key]}
                  aria-invalid={bad || undefined}
                  aria-describedby={bad ? `${l.key}-problem` : undefined}
                  onChange={(e) => change(() => setTyped((x) => ({ ...x, [l.key]: e.target.value })))}
                />
                {bad && (
                  <span id={`${l.key}-problem`} className="pl-warn">
                    A whole number from 1, or empty for no limit.
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </div>
      {problem && (
        <p role="alert" className="fl-prob fl-red">
          {problem}
        </p>
      )}
      <div className="pl-row">
        <button type="button" className="btn primary" disabled={!dirty || busy || invalid} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && (
          <span className="pl-saved" role="status">
            Saved. Their LUME keeps it from its next check-in, within 6 hours.
          </span>
        )}
      </div>
    </section>
  );
}
