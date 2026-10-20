"use client";
import { useState } from "react";
import { api } from "@/lib/client";

export type TopUpsView = {
  requests: { month: string; askedAt: string; askedBy: string; askedByEmail: string; note: string }[];
  added: { month: string; calls: number; note: string; addedAt: string }[];
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** "October 2026" */
export const monthWords = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const thisMonth = () => new Date().toISOString().slice(0, 7);
const MOST = 10_000_000;

/**
 * LUME AI top-ups (Autopilot spec 2026-10-19 §4): what a client's admins asked for, and Add a top-up. It reaches their
 * LUME at its next check-in, where a run paused at the month's allowance carries on by itself.
 */
export function TopUps({
  clientId,
  monthly,
  topUps,
  onSaved,
}: {
  clientId: string;
  /** Their LUME AI a month, for scale beside the top-up. */
  monthly: number | null;
  topUps: TopUpsView;
  onSaved: (data: unknown) => void;
}) {
  const asked = topUps.requests[0] ?? null;
  const [month, setMonth] = useState(asked?.month ?? thisMonth());
  const [calls, setCalls] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const n = /^\d+$/.test(calls.trim()) ? Number(calls.trim()) : NaN;
  const ok = Number.isInteger(n) && n >= 1 && n <= MOST && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

  const add = async () => {
    setBusy(true);
    setProblem(null);
    const r = await api.post(`/api/clients/${clientId}/topup`, { month, calls: n, note: note.trim() });
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    setCalls("");
    setNote("");
    onSaved(r.data);
  };

  return (
    <section className="card" aria-label="LUME AI top-ups" style={{ animationDelay: ".06s" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <h2 className="h">LUME AI top-ups</h2>
        <span className="note">
          {monthly === null ? "No monthly limit" : `${monthly.toLocaleString("en-IN")} calls a month`}
        </span>
      </div>
      {topUps.requests.map((r) => (
        <div key={r.month} className="fl-prob" style={{ display: "grid", gap: 4 }}>
          <b>
            {r.askedBy} asked for {monthWords(r.month)}
          </b>
          {r.note && <span>{r.note}</span>}
          <span className="note">{r.askedByEmail} · their LUME AI waits until it’s added</span>
        </div>
      ))}
      <div className="pl-row" style={{ alignItems: "flex-end" }}>
        <label className="field pl-limit">
          <span>Month</span>
          <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <label className="field pl-limit">
          <span>AI calls to add</span>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={MOST}
            step={1}
            placeholder="1,500"
            value={calls}
            onChange={(e) => setCalls(e.target.value)}
          />
        </label>
        <label className="field" style={{ flex: 1, minWidth: 160 }}>
          <span>Note (only you see it)</span>
          <input className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="button" className="btn primary" disabled={!ok || busy} onClick={() => void add()}>
          {busy ? "Adding…" : "Add a top-up"}
        </button>
      </div>
      {problem && (
        <p role="alert" className="fl-prob fl-red">
          {problem}
        </p>
      )}
      {topUps.added.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
          {topUps.added.map((a) => (
            <li key={a.addedAt} className="note">
              {a.calls.toLocaleString("en-IN")} calls for {monthWords(a.month)}
              {a.note ? ` · ${a.note}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
