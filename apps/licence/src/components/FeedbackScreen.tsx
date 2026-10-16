"use client";
import Link from "next/link";
import { useEffect, useState, type KeyboardEvent } from "react";
import { api, CHANGED } from "@/lib/client";
import { KIND_COLOR, KIND_WORDS, statusText, type FeedbackStatus, type Kind } from "@/lib/feedback";
import { ago, day } from "@/lib/format";
import { Bell } from "./Bell";
import { Head } from "./Shell";

type Tab = "new" | "fixing" | "fixed" | "all";
export type FeedbackItem = {
  id: string;
  receivedAt: string;
  kind: Kind;
  firstLine: string;
  client: { id: string; name: string };
  reporter: { name: string; role: string };
  page: string;
  status: FeedbackStatus;
  fixedIn: string | null;
  imageCount: number;
};
type List = { items: FeedbackItem[]; next: string | null; counts: Record<Tab, number> };
const TABS: [Tab, string][] = [
  ["new", "New"],
  ["fixing", "Fixing"],
  ["fixed", "Fixed"],
  ["all", "All"],
];
const EMPTY: Record<Tab, string> = {
  new: "No new feedback.",
  fixing: "Nothing being fixed.",
  fixed: "Nothing fixed yet.",
  all: "No feedback yet. It arrives here from your clients' LUME.",
};

/** Under two days: "12 min ago"; then the day. */
export const received = (iso: string) =>
  Date.now() - Date.parse(iso) < 48 * 3_600_000 ? ago(iso) : day(iso.slice(0, 10));

export function FeedbackPill({ status, fixedIn }: { status: FeedbackStatus; fixedIn: string | null }) {
  return <span className={`pill fb-${status}`}>{statusText(status, fixedIn)}</span>;
}
export const KindDot = ({ kind }: { kind: Kind }) => (
  <span
    className="fb-dot"
    style={{ background: KIND_COLOR[kind] }}
    role="img"
    aria-label={KIND_WORDS[kind]}
  />
);

/** Feedback (spec 2026-10-16 §3.2): what clients' teams told LUME, a tab at a time, newest first. */
export function FeedbackScreen({
  initial,
}: {
  initial: { client?: string; fixedIn?: string; tab?: string };
}) {
  const scoped = !!(initial.client || initial.fixedIn);
  const asked = TABS.find(([t]) => t === initial.tab)?.[0];
  const [tab, setTab] = useState<Tab>(asked ?? (scoped ? "all" : "new"));
  const [kind, setKind] = useState<Kind | "">("");
  const [q, setQ] = useState("");
  const [list, setList] = useState<List | null>(null);
  const [more, setMore] = useState(false);

  const query = (before?: string) => {
    const p = new URLSearchParams({ tab });
    if (kind) p.set("kind", kind);
    if (initial.client) p.set("client", initial.client);
    if (initial.fixedIn) p.set("fixedIn", initial.fixedIn);
    if (q.trim()) p.set("q", q.trim());
    if (before) p.set("before", before);
    return `/api/feedback?${p}`;
  };
  useEffect(() => {
    let live = true;
    const load = () =>
      void api.get<List>(query()).then((r) => {
        if (!live || !r.ok) return;
        setList(r.data);
        // Nothing new: start where the work is.
        if (tab === "new" && !asked && !scoped && r.data.counts.new === 0 && r.data.counts.fixing > 0)
          setTab("fixing");
      });
    const t = setTimeout(load, q ? 250 : 0);
    window.addEventListener(CHANGED, load);
    return () => {
      live = false;
      clearTimeout(t);
      window.removeEventListener(CHANGED, load);
    };
  }, [tab, kind, q]);

  const loadMore = async () => {
    if (!list?.next) return;
    setMore(true);
    const r = await api.get<List>(query(list.next));
    setMore(false);
    if (r.ok) setList({ ...r.data, items: [...list.items, ...r.data.items] });
  };
  const move = (e: KeyboardEvent) => {
    const i = TABS.findIndex(([t]) => t === tab);
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(i + step + TABS.length) % TABS.length]![0];
    setTab(next);
    (e.currentTarget.querySelector(`[data-t="${next}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <>
      <Head
        title="Feedback"
        sub="What your clients' teams tell LUME: what broke, what confused them, what they wish it did."
      >
        <Bell />
      </Head>
      <div className="body">
        <div className="fb-bar">
          <div className="seg" role="tablist" aria-label="Status" onKeyDown={move}>
            {TABS.map(([t, label]) => (
              <button
                key={t}
                type="button"
                role="tab"
                data-t={t}
                aria-selected={tab === t}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
              >
                {label} <b className="fb-count">{list?.counts[t] ?? ""}</b>
              </button>
            ))}
          </div>
          <label className="fb-kind">
            <span className="sr">Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind | "")}>
              <option value="">Kind: all</option>
              {(Object.keys(KIND_WORDS) as Kind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_WORDS[k]}
                </option>
              ))}
            </select>
          </label>
          <input
            className="fb-search"
            type="search"
            aria-label="Search feedback"
            placeholder="Search text or reporter"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {scoped && list && (
          <p className="note" style={{ margin: 0 }}>
            {initial.fixedIn
              ? `Fixed in ${initial.fixedIn}`
              : `From ${list.items[0]?.client.name ?? "this client"}`}{" "}
            · <Link href="/feedback">All feedback</Link>
          </p>
        )}
        <section className="card fb-list" aria-busy={!list}>
          {!list && <div className="fb-loading" aria-hidden />}
          {!list &&
            [0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="fb-row fb-skel" aria-hidden>
                <span />
                <span />
              </div>
            ))}
          {list && list.items.length === 0 && <p className="note fb-empty">{EMPTY[tab]}</p>}
          {list?.items.map((f) => (
            <Link
              key={f.id}
              href={`/feedback/${f.id}`}
              className={`fb-row${f.status === "new" ? " fb-new" : ""}`}
            >
              <KindDot kind={f.kind} />
              <span className="fb-main">
                <span className="fb-line">{f.firstLine}</span>
                <span className="fb-sub">
                  <span>{f.page}</span>
                  {f.imageCount > 0 && (
                    <span
                      className="fb-shots"
                      role="img"
                      aria-label={`${f.imageCount} screenshot${f.imageCount === 1 ? "" : "s"}`}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden
                      >
                        <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
                        <circle cx="9" cy="10" r="1.6" />
                        <path d="m20.5 16-5-5-8 8" />
                      </svg>
                      {f.imageCount}
                    </span>
                  )}
                </span>
              </span>
              <span className="fb-client">{f.client.name}</span>
              <span className="fb-who">
                <span>{f.reporter.name}</span>
                <span className="fb-sub">{f.reporter.role}</span>
              </span>
              <FeedbackPill status={f.status} fixedIn={f.fixedIn} />
              <span className="fb-when">{received(f.receivedAt)}</span>
            </Link>
          ))}
          {list?.next && (
            <button
              type="button"
              className="btn second"
              onClick={() => void loadMore()}
              disabled={more}
              style={{ margin: 8 }}
            >
              {more ? "Loading…" : "Show 50 more"}
            </button>
          )}
        </section>
      </div>
    </>
  );
}
