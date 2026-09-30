"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientView } from "@/server/clients";
import { compareVersions } from "@/lib/alerts";
import { api, CHANGED } from "@/lib/client";
import { ago, day, dayShort, planOf } from "@/lib/format";
import { inr } from "@/lib/money";
import { countryName, INDIA_STATES } from "@/lib/places";
import { daysBetween, utcDay } from "@/lib/state";
import { trend } from "@/lib/trend";
import { Bell } from "./Bell";
import { Delta, Flag, StatePill, Toast, useToast } from "./bits";
import { NewLicence } from "./NewLicence";
import { Head } from "./Shell";

export type ClientsList = {
  clients: ClientView[];
  totals: { mrr: number; mrrBefore: number };
  rates: { day: string | null; ageDays: number | null; rates: Record<string, number> };
  latestVersion: string | null;
  listPriceInr: number;
};
type Filter = "all" | "active" | "grace" | "read_only" | "suspended";
const TILES: { k: Filter; label: string; color: string }[] = [
  { k: "all", label: "All clients", color: "#2a5bff" },
  { k: "active", label: "Active", color: "#18a566" },
  { k: "grace", label: "Grace", color: "#f2a20c" },
  { k: "read_only", label: "Read-only", color: "#5b82ff" },
  { k: "suspended", label: "Suspended", color: "#e5484d" },
];

/** Where a client is: "Pune, Maharashtra · brightpath", or its country when there's no city. */
export function whereOf(c: Pick<ClientView, "city" | "region" | "country" | "slug">): string {
  const region = c.region ? (INDIA_STATES[c.region] ?? c.region) : null;
  const place = c.city ? `${c.city}${region ? `, ${region}` : ""}` : (region ?? countryName(c.country));
  return `${place} · ${c.slug}`;
}

/** The Paid until cell: the date, and how it stands (late in red). */
export function paidOf(c: ClientView, today: string): { main: string; note: string; late: boolean } {
  if (c.state === "suspended")
    return {
      main: "—",
      note: c.suspendedAt ? `paused ${dayShort(c.suspendedAt.slice(0, 10))}` : "paused",
      late: false,
    };
  if (c.type === "perpetual") return { main: "Never expires", note: "", late: false };
  if (c.type === "trial") {
    if (!c.trialEnds) return { main: "Trial", note: "", late: false };
    const left = daysBetween(today, c.trialEnds);
    return {
      main: `Trial ends ${dayShort(c.trialEnds)}`,
      note: left < 0 ? "trial over" : "",
      late: left < 0,
    };
  }
  if (!c.paidUntil) return { main: "—", note: "", late: false };
  const d = daysBetween(c.paidUntil, today);
  if (d > 0) return { main: day(c.paidUntil), note: `${d} ${d === 1 ? "day" : "days"} overdue`, late: true };
  if (d === 0) return { main: day(c.paidUntil), note: "due today", late: false };
  return {
    main: day(c.paidUntil),
    note: -d <= 10 ? `due in ${-d} ${-d === 1 ? "day" : "days"}` : "",
    late: false,
  };
}

/** Clients (canvas: AdminClients): the state tiles, the month's revenue, search, and every LUME licensed. */
export function ClientsScreen() {
  const [data, setData] = useState<ClientsList | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sheet, setSheet] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [toast, say] = useToast();

  const load = useCallback(async () => {
    const r = await api.get<ClientsList>("/api/clients");
    if (r.ok) setData(r.data);
  }, []);
  useEffect(() => {
    void load();
    const again = () => void load();
    window.addEventListener(CHANGED, again);
    return () => window.removeEventListener(CHANGED, again);
  }, [load]);

  const today = utcDay(new Date());
  const clients = useMemo(() => data?.clients ?? [], [data]);
  const count = (k: Filter) => (k === "all" ? clients.length : clients.filter((c) => c.state === k).length);
  const tiles = TILES.filter((t) => t.k !== "read_only" || count("read_only") > 0);
  const needle = q.trim().toLowerCase();
  const shown = clients.filter(
    (c) =>
      (filter === "all" || c.state === filter) &&
      (!needle ||
        `${c.name} ${c.city ?? ""} ${c.region ? (INDIA_STATES[c.region] ?? "") : ""} ${countryName(c.country)} ${c.slug}`
          .toLowerCase()
          .includes(needle)),
  );

  return (
    <>
      <Head
        title="Clients"
        sub="Every LUME you've licensed, what each pays, and how each is doing right now."
      >
        <label className="search">
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="var(--ink3)"
            strokeWidth="1.5"
            aria-hidden
          >
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.5 10.5l3 3" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            aria-label="Search clients"
            placeholder="Search clients"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <Bell />
        <button type="button" className="btn primary" onClick={() => setSheet(true)}>
          New licence
        </button>
      </Head>

      <div
        className="tiles"
        style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr)) minmax(0, 1.35fr)` }}
      >
        {tiles.map((t) => (
          <button
            key={t.k}
            type="button"
            className="tile"
            aria-pressed={filter === t.k}
            onClick={() => setFilter(t.k)}
          >
            <span className="lab">
              <i style={{ background: t.color }} aria-hidden />
              {t.label}
            </span>
            <span className="n">{data ? count(t.k) : "–"}</span>
          </button>
        ))}
        <Link className="tile money on-blue" href="/analytics">
          <span className="lab">
            Monthly revenue
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              Analytics
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M4.5 2.5L8 6l-3.5 3.5" />
              </svg>
            </span>
          </span>
          <span style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span className="n">{data ? inr(data.totals.mrr) : "–"}</span>
            {data && <Delta t={trend(data.totals.mrr, data.totals.mrrBefore)} size={12} />}
          </span>
        </Link>
      </div>

      <div role="table" aria-label="Clients" aria-rowcount={shown.length + 1}>
        <div role="row" className="row headrow">
          {["Client", "Plan and price", "State", "Paid until", "Last check-in", "Version"].map((h) => (
            <span key={h} role="columnheader">
              {h}
            </span>
          ))}
        </div>
        {shown.map((c, i) => {
          const plan = planOf(c, data?.rates.rates ?? {});
          const paid = paidOf(c, today);
          const heard = c.lastCheckIn ? Date.now() - Date.parse(c.lastCheckIn.at) < 24 * 3_600_000 : false;
          const behind =
            !!data?.latestVersion &&
            !!c.lastCheckIn &&
            c.state !== "suspended" &&
            compareVersions(c.lastCheckIn.version, data.latestVersion) < 0;
          return (
            <Link
              key={c.id}
              href={`/clients/${c.id}`}
              role="row"
              aria-label={c.name}
              className={`row${fresh === c.id ? " fresh" : ""}`}
              style={{ animationDelay: `${Math.min(i, 12) * 0.035}s` }}
            >
              <span role="cell" style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                <Flag country={c.country} />
                <span className="stack">
                  <span className="t">{c.name}</span>
                  <span className="s">{whereOf(c)}</span>
                </span>
              </span>
              <span role="cell" className="stack">
                <span className="t num">{plan.main}</span>
                <span className="s num">{plan.sub}</span>
              </span>
              <span role="cell">
                <StatePill state={c.state} />
              </span>
              <span role="cell" className="stack">
                <span>{paid.main}</span>
                <span className="s" style={paid.late ? { color: "var(--redInk)" } : undefined}>
                  {paid.note}
                </span>
              </span>
              <span role="cell" style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span
                  className={`dot${heard ? " ping" : ""}`}
                  style={{
                    background: heard
                      ? "#18a566"
                      : c.state === "suspended" || !c.lastCheckIn
                        ? "#9297a0"
                        : "#f2a20c",
                  }}
                  aria-hidden
                />
                {c.lastCheckIn ? ago(c.lastCheckIn.at) : "Not yet"}
              </span>
              <span role="cell" className="num" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {c.lastCheckIn?.version ?? "—"}
                {behind && <span className="badge-soft">update</span>}
              </span>
            </Link>
          );
        })}
      </div>
      {data && shown.length === 0 && (
        <p className="empty">
          {clients.length ? "No client matches that." : "No clients yet. New licence makes the first."}
        </p>
      )}

      {sheet && data && (
        <NewLicence
          rates={data.rates.rates}
          listPriceInr={data.listPriceInr}
          onClose={() => setSheet(false)}
          onCreated={(c) => {
            setFresh(c.id);
            setFilter("all");
            setQ("");
            say(`Licence created for ${c.name}`);
          }}
        />
      )}
      <Toast msg={toast} />
    </>
  );
}
