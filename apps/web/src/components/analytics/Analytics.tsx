"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MetricId, RangePreset } from "@lume/core/shared";
import {
  analyticsClient,
  type AnalyticsParams,
  type Funnel,
  type Goals,
  type Insights,
  type Lost,
  type Overview as OverviewData,
  type Quality,
  type Sources,
  type Team,
  type Templates,
  type Timing,
} from "@/lib/analytics/client";
import type { Catalog } from "@/lib/leads/types";
import { useLoadingSignal } from "@/lib/loading";
import { FunnelBoard, LostBoard, QualityBoard, SourcesBoard, TeamBoard, TimingBoard } from "./Boards";
import { DrillSheet } from "./DrillSheet";
import { Overview } from "./Overview";
import { Ico } from "./parts";
import s from "./analytics.module.css";

export type Tab = "overview" | "funnel" | "team" | "revenue" | "lost" | "timing" | "quality";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "funnel", label: "Funnel" },
  { id: "team", label: "Team" },
  { id: "revenue", label: "Revenue & sources" },
  { id: "lost", label: "Lost" },
  { id: "timing", label: "Timing" },
  { id: "quality", label: "Templates & data" },
];
const RANGES: { id: RangePreset; label: string; words: string }[] = [
  { id: "today", label: "Today", words: "today" },
  { id: "yesterday", label: "Yesterday", words: "yesterday" },
  { id: "7d", label: "Last 7 days", words: "in the last 7 days" },
  { id: "30d", label: "Last 30 days", words: "in the last 30 days" },
  { id: "this_month", label: "This month", words: "this month" },
  { id: "last_month", label: "Last month", words: "last month" },
  { id: "90d", label: "Last 90 days", words: "in the last 90 days" },
  { id: "this_quarter", label: "This quarter", words: "this quarter" },
];

type Data = {
  overview: OverviewData | null;
  funnel: Funnel | null;
  team: Team | null;
  sources: Sources | null;
  lost: Lost | null;
  timing: Timing | null;
  quality: Quality | null;
  templates: Templates | null;
  insights: Insights | null;
  goals: Goals | null;
};
const EMPTY: Data = {
  overview: null,
  funnel: null,
  team: null,
  sources: null,
  lost: null,
  timing: null,
  quality: null,
  templates: null,
  insights: null,
  goals: null,
};
/** What each module reads. */
const NEEDS: Record<Tab, (keyof Data)[]> = {
  overview: ["overview", "funnel", "timing", "quality", "insights", "goals"],
  funnel: ["funnel"],
  team: ["team"],
  revenue: ["sources"],
  lost: ["lost"],
  timing: ["timing"],
  quality: ["quality", "templates"],
};

/**
 * Analytics (8C, canvas 6X1u5VivMqy438qemCsPRH): one bar to pick the module, the range and whether to compare; each
 * module reads its numbers at the viewer's reach, and every number with leads behind it opens them.
 */
export function Analytics({
  catalog,
  showTeam,
  timezone,
}: {
  catalog: Catalog;
  /** The leaderboard is for those who see more than themselves. */
  showTeam: boolean;
  timezone: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const tab = (TABS.some((t) => t.id === search.get("m")) ? search.get("m") : "overview") as Tab;
  const range = (
    RANGES.some((r) => r.id === search.get("range")) ? search.get("range") : "30d"
  ) as RangePreset;
  const compare = search.get("compare") !== "0";
  const params: AnalyticsParams = { range, compare };
  const key = `${range}|${compare}`;
  const [data, setData] = useState<Data>(EMPTY);
  const [forKey, setForKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [drill, setDrill] = useState<{ token: string; title: string } | null>(null);
  const tabs = TABS.filter((t) => t.id !== "team" || showTeam);

  const set = (next: Partial<{ m: Tab; range: RangePreset; compare: boolean }>) => {
    const q = new URLSearchParams(search.toString());
    if (next.m) q.set("m", next.m);
    if (next.range) q.set("range", next.range);
    if (next.compare !== undefined) q.set("compare", next.compare ? "1" : "0");
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  };

  // A new range or compare starts afresh; each module fetches what it needs, once.
  useEffect(() => {
    if (forKey !== key) {
      setData(EMPTY);
      setForKey(key);
    }
  }, [key, forKey]);
  const loading = forKey === key ? NEEDS[tab].filter((k) => data[k] === null) : NEEDS[tab];
  useLoadingSignal(loading.length > 0);
  useEffect(() => {
    if (forKey !== key) return;
    let live = true;
    const start = `${new Date().toLocaleDateString("en-CA", { timeZone: timezone }).slice(0, 7)}-01`;
    const fetchers: Record<keyof Data, () => Promise<{ ok: boolean; data?: unknown; message?: string }>> = {
      overview: () => analyticsClient.overview(params),
      funnel: () => analyticsClient.funnel(params),
      team: () => analyticsClient.team(params),
      sources: () => analyticsClient.sources(params),
      lost: () => analyticsClient.lost(params),
      timing: () => analyticsClient.timing(params),
      quality: () => analyticsClient.quality(params),
      templates: () => analyticsClient.templates(params),
      insights: () => analyticsClient.insights(params),
      goals: () => analyticsClient.goals(start),
    };
    for (const k of NEEDS[tab].filter((x) => data[x] === null))
      void fetchers[k]().then((r) => {
        if (!live) return;
        if (r.ok) setData((d) => ({ ...d, [k]: r.data }));
        else setError(r.message ?? "LUME couldn’t count these numbers right now.");
      });
    return () => {
      live = false;
    };
    // Each module's numbers, once per range; `data` is read only to skip what's already here.
  }, [tab, key, forKey]);

  // The tab pill slides under the chosen tab.
  const tabsRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
  }, [tab, tabs.length]);

  const r = RANGES.find((x) => x.id === range)!;
  const label = data.overview?.range.label ?? data.funnel?.range.label ?? data.team?.range.label ?? r.label;
  const monthName = new Date().toLocaleDateString("en-US", { month: "long", timeZone: timezone });
  const openDrill = (id: MetricId, title: string) => {
    const token = data.overview?.drill[id];
    if (token) setDrill({ token, title });
  };

  return (
    <div className={s.screen}>
      <div className={s.bar}>
        <div className={s.tabs} role="tablist" aria-label="Analytics" ref={tabsRef}>
          {pill && <span className={s.pill} style={{ left: pill.left, width: pill.width }} aria-hidden />}
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              data-tab={t.id}
              aria-selected={tab === t.id}
              className={s.tab}
              onClick={() => set({ m: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className={s.spacer} />
        <div style={{ position: "relative" }}>
          <button
            type="button"
            className={s.rbtn}
            aria-haspopup="menu"
            aria-expanded={rangeOpen}
            onClick={() => setRangeOpen((o) => !o)}
          >
            {Ico.calendar}
            {r.label}
            <span className={s.vs}>· {label}</span>
          </button>
          {rangeOpen && (
            <div
              className={s.menu}
              role="menu"
              aria-label="Range"
              onKeyDown={(e) => e.key === "Escape" && setRangeOpen(false)}
            >
              {RANGES.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={x.id === range}
                  onClick={() => {
                    setRangeOpen(false);
                    set({ range: x.id });
                  }}
                >
                  {x.label}
                </button>
              ))}
              <div className={s.menuSep} />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={compare}
                onClick={() => set({ compare: !compare })}
              >
                Compare with the period before
                <span aria-hidden>{compare ? "On" : "Off"}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className={s.empty} style={{ color: "var(--danger-ink)" }}>
          {error}
        </p>
      )}

      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label}>
        {tab === "overview" && (
          <Overview
            data={data.overview}
            funnel={data.funnel}
            timing={data.timing}
            quality={data.quality}
            insights={data.insights}
            goals={data.goals}
            currency={catalog.currency}
            compare={compare}
            rangeWords={r.words}
            monthName={monthName}
            period={
              range === "today" || range === "yesterday"
                ? "day"
                : range === "7d"
                  ? "week"
                  : range === "90d" || range === "this_quarter"
                    ? "quarter"
                    : "month"
            }
            onDrill={openDrill}
            onTab={(t) => set({ m: t })}
          />
        )}
        {tab === "funnel" && <FunnelBoard funnel={data.funnel} rangeWords={r.words} />}
        {tab === "team" && <TeamBoard team={data.team} currency={catalog.currency} />}
        {tab === "revenue" && <SourcesBoard sources={data.sources} currency={catalog.currency} />}
        {tab === "lost" && <LostBoard lost={data.lost} currency={catalog.currency} />}
        {tab === "timing" && <TimingBoard timing={data.timing} />}
        {tab === "quality" && <QualityBoard quality={data.quality} templates={data.templates} />}
      </div>

      {drill && (
        <DrillSheet
          token={drill.token}
          title={drill.title}
          facts={[r.label, label]}
          catalog={catalog}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
