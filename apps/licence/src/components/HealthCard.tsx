"use client";
import type { FleetHealth } from "@lume/core/shared";
import { ago, day } from "@/lib/format";
import { bytesText, STATUS_WORDS, uptimeText, type FleetStatus, type Problem } from "@/lib/fleet";

export type ClientHealth = {
  health: { status: FleetStatus; problems: Problem[]; health: FleetHealth | null; at: string } | null;
  healthTrend: { day: string; dbBytes: number; diskFreePct: number | null }[];
};

/** Bars for a 14-day line, tallest = the biggest value (the panel's check-in bar style). */
function Bars({ values, label, color }: { values: number[]; label: string; color: (v: number) => string }) {
  // From just under the fortnight's smallest, so a database that grew 10% shows it.
  const max = Math.max(1, ...values);
  const floor = Math.min(...values) * 0.85;
  const span = Math.max(1e-9, max - floor);
  return (
    <div className="fl-bars" role="img" aria-label={label}>
      {values.map((v, i) => (
        <i
          key={i}
          style={{
            height: `${Math.max(6, ((v - floor) / span) * 100)}%`,
            background: color(v),
            animationDelay: `${i * 0.02}s`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * A client's Health card (spec 2026-10-16 fleet §3.3): how its LUME says it is, the problems in words, and 14 days of
 * database size and disk free. On a LUME from before health: when it will arrive.
 */
export function HealthCard({ data, version }: { data: ClientHealth; version: string | null }) {
  const s = data.health;
  if (!s) return null;
  const h = s.health;
  const trend = data.healthTrend;
  return (
    <section className="card" aria-label="Health" style={{ animationDelay: ".03s" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <h2 className="h">Health</h2>
        <span className={`pill fl-${s.status}`}>
          <i />
          {STATUS_WORDS[s.status]}
        </span>
      </div>
      {s.status === "down" && (
        <p className="fl-prob fl-red">
          Its server may be off or offline. LUME keeps working there for 7 days, then turns read-only until it
          checks in again.
        </p>
      )}
      {!h && s.status !== "down" && (
        <p className="note" style={{ margin: 0, fontSize: 13.5, color: "var(--ink2)" }}>
          {version ? `This LUME runs ${version}. ` : ""}Health arrives once this LUME is updated. It last
          checked in {ago(s.at)}.
        </p>
      )}
      {s.problems.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {s.problems.map((p) => (
            <p key={p.key} className={`fl-prob fl-${p.severity}`}>
              {p.words}
            </p>
          ))}
        </div>
      )}
      {h && (
        <>
          <dl className="fl-facts">
            <div>
              <dt>Database</dt>
              <dd className="num">
                {bytesText(h.dbBytes)}
                {trend.length > 1 && (
                  <Bars
                    values={trend.map((p) => p.dbBytes)}
                    label={`Database size over ${trend.length} days, from ${bytesText(trend[0]!.dbBytes)} to ${bytesText(trend.at(-1)!.dbBytes)}`}
                    color={() => "var(--blue)"}
                  />
                )}
              </dd>
            </div>
            <div>
              <dt>Disk free</dt>
              <dd
                className="num"
                style={{
                  color:
                    h.diskFreePct !== null && h.diskFreePct < 5
                      ? "var(--redInk)"
                      : h.diskFreePct !== null && h.diskFreePct < 15
                        ? "var(--amberInk)"
                        : undefined,
                }}
              >
                {h.diskFreePct === null ? "—" : `${h.diskFreePct}%`}

                {trend.length > 1 && trend.every((p) => p.diskFreePct !== null) && (
                  <Bars
                    values={trend.map((p) => p.diskFreePct!)}
                    label={`Disk free over ${trend.length} days, from ${trend[0]!.diskFreePct}% to ${trend.at(-1)!.diskFreePct}%`}
                    color={(v) => (v < 5 ? "#e5484d" : v < 15 ? "#f2a20c" : "#18a566")}
                  />
                )}
              </dd>
            </div>
            <div>
              <dt>Up for</dt>
              <dd className="num">{uptimeText(h.uptimeS)}</dd>
            </div>
            <div>
              <dt>Errors, last 24 h</dt>
              <dd className="num">{h.errors24h}</dd>
            </div>
            <div>
              <dt>Background jobs</dt>
              <dd className="num">
                {h.queue.waiting} waiting{h.queue.failed24h ? ` · ${h.queue.failed24h} failed` : ""}
              </dd>
            </div>
            <div>
              <dt>Backup restore test</dt>
              <dd>
                {h.restoreTest
                  ? `${h.restoreTest.ok ? "Passed" : "Failed"}, ${day(h.restoreTest.at.slice(0, 10))}`
                  : "None yet"}
              </dd>
            </div>
          </dl>
          <span className="note">
            From its check-in {ago(s.at)}. Counts and sizes only: nothing about a lead leaves their server.
          </span>
        </>
      )}
    </section>
  );
}
