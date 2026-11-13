"use client";
import { useState } from "react";
import { api } from "@/lib/client";

export type TopUpsView = {
  requests: { month: string; askedAt: string; askedBy: string; askedByEmail: string; note: string }[];
  /** In AI leads (2026-11-12); a top-up added before them has its calls. */
  added: { month: string; leads?: number; calls?: number; note: string; addedAt: string }[];
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
/** A pack is this many AI leads; this many packs at most in one top-up. */
const PACK = 100;
const MOST_PACKS = 1000;
const n = (x: number) => x.toLocaleString("en-IN");

/**
 * LUME AI top-ups (Autopilot spec 2026-10-19 §4; AI leads 2026-11-12): what a client's admins asked for, and Add a
 * top-up in packs of 100 AI leads, for their month now only (the month they asked for, else this one), with no
 * rollover. It reaches their LUME at its next check-in, where leads waiting for AI leads start by themselves.
 */
export function TopUps({
  clientId,
  leads,
  topUps,
  onSaved,
}: {
  clientId: string;
  /** Their AI leads a month, for scale beside the top-up (null: no limit; undefined: not set in AI leads). */
  leads: number | null | undefined;
  topUps: TopUpsView;
  onSaved: (data: unknown) => void;
}) {
  const asked = topUps.requests[0] ?? null;
  const month = asked?.month ?? thisMonth();
  const [packs, setPacks] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const k = /^\d+$/.test(packs.trim()) ? Number(packs.trim()) : NaN;
  const ok = Number.isInteger(k) && k >= 1 && k <= MOST_PACKS;

  const add = async () => {
    setBusy(true);
    setProblem(null);
    const r = await api.post(`/api/clients/${clientId}/topup`, { month, packs: k, note: note.trim() });
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    setPacks("");
    setNote("");
    onSaved(r.data);
  };

  return (
    <section className="card" aria-label="LUME AI top-ups" style={{ animationDelay: ".06s" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <h2 className="h">LUME AI top-ups</h2>
        <span className="note">
          {leads === null || leads === undefined ? "No AI leads limit" : `${n(leads)} AI leads a month`}
        </span>
      </div>
      {topUps.requests.map((r) => (
        <div key={r.month} className="fl-prob" style={{ display: "grid", gap: 4 }}>
          <b>
            {r.askedBy} asked for {monthWords(r.month)}
          </b>
          {r.note && <span>{r.note}</span>}
          <span className="note">{r.askedByEmail} · new leads wait for LUME AI until it’s added</span>
        </div>
      ))}
      <div className="pl-row" style={{ alignItems: "flex-end" }}>
        <label className="field pl-limit">
          <span>Packs of 100 AI leads</span>
          <input
            className="input"
            type="number"
            inputMode="numeric"
            min={1}
            max={MOST_PACKS}
            step={1}
            placeholder="1"
            value={packs}
            aria-describedby="topup-for"
            onChange={(e) => setPacks(e.target.value)}
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
      <span id="topup-for" className="note">
        {ok
          ? `${n(k * PACK)} AI leads for ${monthWords(month)} only: they don’t carry into the next month.`
          : `For ${monthWords(month)} only: a top-up doesn’t carry into the next month.`}
      </span>
      {problem && (
        <p role="alert" className="fl-prob fl-red">
          {problem}
        </p>
      )}
      {topUps.added.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 2 }}>
          {topUps.added.map((a) => (
            <li key={a.addedAt} className="note">
              {a.leads !== undefined ? `${n(a.leads)} AI leads` : `${n(a.calls ?? 0)} calls`} for{" "}
              {monthWords(a.month)}
              {a.note ? ` · ${a.note}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
