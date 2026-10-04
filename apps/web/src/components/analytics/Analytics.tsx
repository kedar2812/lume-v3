"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MetricId } from "@lume/core/shared";
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
import { AnalyticsRefresh } from "./AnalyticsRefresh";
import { RangePicker } from "./RangePicker";
import { RANGE_CHOICES, apiRange, dayIn, rangeWords, type RangeChoice } from "@/lib/analytics/range";
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
/** How a sentence on a board says the range ("3 leads came in the last 30 days"). */
const RANGE_WORDS: Record<RangeChoice, string> = {
  today: "today",
  "7d": "in the last 7 days",
  "30d": "in the last 30 days",
  this_month: "this month",
  last_month: "last month",
  this_quarter: "this quarter",
  "12m": "in the last 12 months",
  custom: "in these days",
};
const CHOICES = new Set<string>([...RANGE_CHOICES.map((c) => c.id), "custom"]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

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
  // The range (canvas Main's popover): a choice, or the days of a custom one; today in the business's timezone.
  const today = dayIn(new Date(), timezone);
  const fromQ = search.get("from");
  const toQ = search.get("to");
  const custom =
    fromQ && toQ && ISO_DAY.test(fromQ) && ISO_DAY.test(toQ) ? { from: fromQ, to: toQ } : undefined;
  const asked = search.get("range") ?? "30d";
  const choice = (CHOICES.has(asked) && (asked !== "custom" || custom) ? asked : "30d") as RangeChoice;
  const compare = search.get("compare") !== "0";
  const params: AnalyticsParams = { ...apiRange(choice, today, custom), compare };
  const key = `${choice}|${custom?.from ?? ""}|${custom?.to ?? ""}|${compare}`;
  const [data, setData] = useState<Data>(EMPTY);
  const [forKey, setForKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<{ token: string; title: string } | null>(null);
  const tabs = TABS.filter((t) => t.id !== "team" || showTeam);

  const set = (
    next: Partial<{ m: Tab; choice: RangeChoice; custom: { from: string; to: string }; compare: boolean }>,
  ) => {
    const q = new URLSearchParams(search.toString());
    if (next.m) q.set("m", next.m);
    if (next.choice) {
      q.set("range", next.choice);
      if (next.choice === "custom" && next.custom) {
        q.set("from", next.custom.from);
        q.set("to", next.custom.to);
      } else {
        q.delete("from");
        q.delete("to");
      }
    }
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

  const r = { words: RANGE_WORDS[choice] };
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
        {/* Recount now, then every board reads its numbers again (owner, 2026-10-05). */}
        <AnalyticsRefresh
          onRecounted={() => {
            setData(EMPTY);
            setForKey(null);
          }}
        />
        <RangePicker
          choice={choice}
          {...(custom ? { custom } : {})}
          compare={compare}
          today={today}
          tz={timezone}
          onChange={(n) => set(n)}
        />
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
              choice === "today"
                ? "day"
                : choice === "7d"
                  ? "week"
                  : choice === "this_quarter" || choice === "12m"
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
          facts={[
            ...new Set([rangeWords(choice, today, custom).label, data.overview?.range.label ?? ""]),
          ].filter(Boolean)}
          catalog={catalog}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}
