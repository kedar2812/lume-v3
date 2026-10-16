"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type KeyboardEvent } from "react";
import { api, CHANGED } from "@/lib/client";
import { bytesText, STATUS_WORDS, type FleetStatus, type Problem } from "@/lib/fleet";
import { ago, day } from "@/lib/format";
import { AnnouncementSheet } from "./AnnouncementSheet";
import { Bell } from "./Bell";
import { Head } from "./Shell";

export type FleetRow = {
  id: string;
  name: string;
  status: FleetStatus;
  problems: Problem[];
  lastCheckInAt: string;
  version: string;
  behind: boolean;
  people: number;
  leads: number;
  dbBytes: number | null;
  diskFreePct: number | null;
  acceptsAnnouncements: boolean;
};
type Fleet = {
  rows: FleetRow[];
  latestVersion: string | null;
  counts: { total: number; online: number; look: number; down: number; none: number; behind: number };
};
export type Announcement = {
  id: string;
  title: string;
  body: string;
  kind: "update" | "maintenance";
  windowStart: string | null;
  windowEnd: string | null;
  audienceText: string;
  startsAt: string;
  endsAt: string;
  withdrawnAt: string | null;
  state: "live" | "scheduled" | "ended" | "withdrawn";
  reach: { audience: number; reached: number; cannot: number; waiting: number; seenBy: number };
  clients: { id: string; name: string; reach: "reached" | "older" | "waiting" }[];
};
type Filter = "all" | "look" | "down" | "none";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["look", "Need a look"],
  ["down", "Down"],
  ["none", "No health yet"],
];
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const when = (iso: string) => {
  const d = new Date(iso);
  return `${day(iso.slice(0, 10))}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase()}`;
};

/** Fleet (spec 2026-10-16 fleet §3): every client's LUME worst first, and announcements to them. */
export function FleetScreen({ initialTab }: { initialTab?: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<"health" | "announcements">(
    initialTab === "announcements" ? "announcements" : "health",
  );
  const [data, setData] = useState<Fleet | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  useEffect(() => {
    let live = true;
    const load = () => void api.get<Fleet>("/api/fleet").then((r) => live && r.ok && setData(r.data));
    load();
    window.addEventListener(CHANGED, load);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, load);
    };
  }, []);
  const pick = (t: "health" | "announcements") => {
    setTab(t);
    router.replace(t === "health" ? "/fleet" : "/fleet?tab=announcements", { scroll: false });
  };
  const move = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = tab === "health" ? "announcements" : "health";
    pick(next);
    (e.currentTarget.querySelector(`[data-t="${next}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <>
      <Head
        title="Fleet"
        sub={
          tab === "health"
            ? "Every client’s LUME, worst first: what each server says about itself at its check-in, every 6 hours."
            : "Tell every client’s team something at once: a new release, planned maintenance."
        }
      >
        <Bell />
      </Head>
      <div className="body">
        <div className="fb-bar">
          <div className="seg" role="tablist" aria-label="Fleet" onKeyDown={move}>
            {(
              [
                ["health", "Health"],
                ["announcements", "Announcements"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                type="button"
                role="tab"
                data-t={t}
                aria-selected={tab === t}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => pick(t)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {tab === "health" ? (
          <Health data={data} filter={filter} setFilter={setFilter} q={q} setQ={setQ} />
        ) : (
          <Announcements clients={(data?.rows ?? []).map((r) => ({ id: r.id, name: r.name }))} />
        )}
      </div>
    </>
  );
}

function Health({
  data,
  filter,
  setFilter,
  q,
  setQ,
}: {
  data: Fleet | null;
  filter: Filter;
  setFilter: (f: Filter) => void;
  q: string;
  setQ: (s: string) => void;
}) {
  const c = data?.counts;
  const rows = (data?.rows ?? []).filter(
    (r) => (filter === "all" || r.status === filter) && r.name.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const count = (f: Filter) => (f === "all" ? (c?.total ?? 0) : (c?.[f] ?? 0));
  const tile = (f: Filter | null, label: string, n: string, sub: string, tone?: string) => (
    <button
      type="button"
      className="tile"
      aria-pressed={f !== null && filter === f && f !== "all"}
      onClick={() => f && setFilter(filter === f ? "all" : f)}
      disabled={f === null}
      style={f === null ? { cursor: "default" } : undefined}
    >
      <span className="lab">{label}</span>
      <span className="n" style={tone ? { color: tone } : undefined}>
        {n}
      </span>
      <span className="note">{sub}</span>
    </button>
  );
  return (
    <>
      <div className="tiles fl-tiles">
        {tile(null, "Online", c ? `${c.online} of ${c.total}` : "—", "Checked in within 24 hours")}
        {tile(
          "look",
          "Need a look",
          c ? String(c.look) : "—",
          "Problems their LUME reported",
          "var(--amberInk)",
        )}
        {tile("down", "Down", c ? String(c.down) : "—", "Not heard from in over a day", "var(--redInk)")}
        {tile(
          null,
          "Behind",
          c ? String(c.behind) : "—",
          data?.latestVersion
            ? `Not on ${data.latestVersion}, the latest`
            : "Set the latest version in Settings",
        )}
      </div>
      <div className="fb-bar">
        <div className="seg" role="group" aria-label="Status">
          {FILTERS.map(([f, label]) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label} <b className="fb-count">{data ? count(f) : ""}</b>
            </button>
          ))}
        </div>
        <input
          className="fb-search"
          type="search"
          aria-label="Search clients"
          placeholder="Search clients"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <section className="card fl-list" aria-busy={!data} aria-label="Every client's LUME">
        {!data && <div className="fb-loading" aria-hidden />}
        <div className="fl-scroll">
          <div className="fl-row fl-head" aria-hidden>
            <span>Status</span>
            <span>Client</span>
            <span>Last heard</span>
            <span>Version</span>
            <span className="r">People</span>
            <span className="r">Leads</span>
            <span className="r">Database</span>
            <span className="r">Disk free</span>
            <span>Problems</span>
          </div>
          {!data &&
            [0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="fl-row fb-skel" aria-hidden>
                <span />
                <span />
                <span />
                <span />
              </div>
            ))}
          {data && rows.length === 0 && (
            <p className="note fb-empty">
              {data.rows.length === 0
                ? "No client’s LUME has checked in yet. Each one shows here after its first check-in."
                : q.trim() || filter === "all"
                  ? "No client by that name."
                  : `None ${filter === "down" ? "down" : filter === "look" ? "need a look" : "without health"} right now.`}
            </p>
          )}
          {rows.map((r, i) => (
            <Link
              key={r.id}
              href={`/clients/${r.id}`}
              className="fl-row"
              style={{ animationDelay: `${Math.min(i, 12) * 0.02}s` }}
            >
              <span className={`pill fl-${r.status}`}>
                <i />
                {STATUS_WORDS[r.status]}
              </span>
              <span className="fl-name">{r.name}</span>
              <span className={r.status === "down" ? "fl-down-text" : "fl-dim"}>{ago(r.lastCheckInAt)}</span>
              <span className="fl-ver">
                <span className="num">{r.version}</span>
                {r.behind && <span className="pill grace fl-update">update</span>}
              </span>
              <span className="num r">{r.people.toLocaleString("en-IN")}</span>
              <span className="num r">{r.leads.toLocaleString("en-IN")}</span>
              <span className="num r fl-dim">{bytesText(r.dbBytes)}</span>
              <span
                className={`num r fl-disk${
                  r.diskFreePct === null
                    ? " fl-dim"
                    : r.diskFreePct < 5
                      ? " fl-red-text"
                      : r.diskFreePct < 15
                        ? " fl-amber-text"
                        : ""
                }`}
              >
                {r.diskFreePct === null ? "—" : `${r.diskFreePct}%`}
              </span>
              <span className="fl-chips">
                {r.problems.map((p) => (
                  <span key={p.key} className={`fl-chip fl-${p.severity}`}>
                    {p.short}
                  </span>
                ))}
                {!r.problems.length && (
                  <span className="fl-dim">
                    {r.status === "none"
                      ? "Health arrives once it’s updated"
                      : r.status === "down"
                        ? `Not heard from since ${when(r.lastCheckInAt)}`
                        : "—"}
                  </span>
                )}
              </span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}

const STATE_WORDS: Record<Announcement["state"], string> = {
  live: "Live",
  scheduled: "Scheduled",
  ended: "Ended",
  withdrawn: "Ended",
};

function Announcements({ clients }: { clients: { id: string; name: string }[] }) {
  const [list, setList] = useState<Announcement[] | null>(null);
  const [composing, setComposing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const load = () =>
    void api
      .get<{ announcements: Announcement[] }>("/api/announcements")
      .then((r) => r.ok && setList(r.data.announcements));
  useEffect(load, []);
  const withdraw = async (id: string) => {
    const r = await api.post(`/api/announcements/${id}/withdraw`);
    setConfirm(null);
    if (r.ok) load();
  };
  const groups = (["live", "scheduled", "ended"] as const).map((g) => ({
    g,
    items: (list ?? []).filter((a) =>
      g === "ended" ? a.state === "ended" || a.state === "withdrawn" : a.state === g,
    ),
  }));
  return (
    <>
      <div className="fl-actions">
        <button type="button" className="btn primary" onClick={() => setComposing(true)}>
          New announcement
        </button>
      </div>
      <section className="card fl-ann" aria-busy={!list} aria-label="Announcements">
        {!list && <div className="fb-loading" aria-hidden />}
        {list && list.length === 0 && (
          <p className="note fb-empty">
            Nothing announced yet. An announcement shows in each chosen LUME as “From LUME’s team”.
          </p>
        )}
        {groups
          .filter((x) => x.items.length)
          .map(({ g, items }) => (
            <div key={g}>
              <h2 className="h fl-group">{STATE_WORDS[g]}</h2>
              {items.map((a) => {
                const pct = (n: number) => (a.reach.audience ? `${(n / a.reach.audience) * 100}%` : "0%");
                const expanded = open === a.id;
                return (
                  <div
                    key={a.id}
                    className={`fl-an${a.state === "withdrawn" || a.state === "ended" ? " fl-past" : ""}`}
                  >
                    <button
                      type="button"
                      className="fl-an-head"
                      aria-expanded={expanded}
                      onClick={() => setOpen(expanded ? null : a.id)}
                    >
                      <span className="fl-an-main">
                        <span className="fl-an-title">
                          <span
                            className={`pill ${a.state === "withdrawn" ? "fl-none" : a.kind === "maintenance" ? "grace" : "fl-update-pill"}`}
                          >
                            {a.state === "withdrawn"
                              ? "Withdrawn"
                              : a.kind === "maintenance"
                                ? "Maintenance"
                                : "Update"}
                          </span>
                          <b>{a.title}</b>
                        </span>
                        <span className="note">
                          {a.audienceText}
                          {a.windowStart && a.windowEnd
                            ? ` · ${when(a.windowStart)} – ${when(a.windowEnd).split(", ").pop()}`
                            : ""}
                          {a.state === "scheduled"
                            ? ` · starts ${when(a.startsAt)}`
                            : ` · until ${day(a.endsAt.slice(0, 10))}`}
                        </span>
                      </span>
                      {a.state === "scheduled" ? (
                        <span className="note">Not started</span>
                      ) : (
                        <span className="fl-reach">
                          <span
                            className="fl-reach-bar"
                            role="img"
                            aria-label={`Reached ${a.reach.reached} of ${a.reach.audience}`}
                          >
                            <i style={{ width: pct(a.reach.reached), background: "var(--blue)" }} />
                            <i style={{ width: pct(a.reach.cannot), background: "var(--line2)" }} />
                          </span>
                          <span className="note">
                            Reached {a.reach.reached} of {a.reach.audience}
                            {a.reach.cannot ? ` · ${a.reach.cannot} on an older LUME` : ""}
                            {a.reach.seenBy ? ` · seen by ${plural(a.reach.seenBy, "person", "people")}` : ""}
                          </span>
                        </span>
                      )}
                    </button>
                    {expanded && (
                      <div className="fl-an-detail">
                        <p className="fl-an-body">{a.body}</p>
                        <div className="fl-an-clients">
                          {a.clients.map((x) => (
                            <span key={x.id} className="fl-an-client">
                              <i className={`fl-reach-dot fl-r-${x.reach}`} aria-hidden />
                              {x.name}
                              <span className="note">
                                {x.reach === "reached"
                                  ? "Reached"
                                  : x.reach === "older"
                                    ? "Older LUME"
                                    : "Waiting for its check-in"}
                              </span>
                            </span>
                          ))}
                        </div>
                        {(a.state === "live" || a.state === "scheduled") &&
                          (confirm === a.id ? (
                            <div className="fl-confirm" role="group" aria-label="Withdraw this announcement?">
                              <span>It leaves each LUME at its next check-in, within 6 hours.</span>
                              <button
                                type="button"
                                className="btn second small"
                                onClick={() => setConfirm(null)}
                              >
                                Keep it
                              </button>
                              <button
                                type="button"
                                className="btn danger small"
                                onClick={() => void withdraw(a.id)}
                              >
                                Withdraw
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="btn second small"
                              onClick={() => setConfirm(a.id)}
                            >
                              Withdraw…
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
      </section>
      {composing && (
        <AnnouncementSheet
          clients={clients}
          onClose={() => setComposing(false)}
          onPublished={() => {
            setComposing(false);
            load();
          }}
        />
      )}
    </>
  );
}
