"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MetricId } from "@lume/core/shared";
import {
  analyticsClient,
  query,
  type AnalyticsParams,
  type Funnel,
  type Goals,
  type Insights,
  type Lost,
  type Overview as OverviewData,
  type Me,
  type Quality,
  type Revenue,
  type Sources,
  type Team,
  type Templates,
  type Timing,
} from "@/lib/analytics/client";
import type { Catalog } from "@/lib/leads/types";
import { useLoadingSignal } from "@/lib/loading";
import { QualityBoard } from "./QualityBoard";
import { TimingBoard } from "./TimingBoard";
import { LostBoard } from "./LostBoard";
import { RevenueBoard } from "./RevenueBoard";
import { RepNumbers } from "./RepNumbers";
import { TeamBoard } from "./TeamBoard";
import { FunnelBoard } from "./FunnelBoard";
import { DrillSheet } from "./DrillSheet";
import { Overview } from "./Overview";
import { AnalyticsRefresh } from "./AnalyticsRefresh";
import { RangePicker } from "./RangePicker";
import { FilterChips, FiltersButton, filterCount, type AnalyticsFilters } from "./Filters";
import {
  RANGE_CHOICES,
  apiRange,
  dayIn,
  daysBetween,
  daysOf,
  rangeWords,
  type RangeChoice,
} from "@/lib/analytics/range";
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
/** Someone who sees only their own leads gets their own three (canvas Rep). */
const REP_TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "My numbers" },
  { id: "funnel", label: "My funnel" },
  { id: "timing", label: "My timing" },
];
const UUID_LIST = /^[0-9a-f-]{36}(,[0-9a-f-]{36})*$/i;
/** The Filters panel's choices, read back from the address (a bad value is simply left out). */
function readFilters(search: URLSearchParams): AnalyticsFilters {
  const list = (k: string) => {
    const v = search.get(k);
    return v && UUID_LIST.test(v) ? v.split(",") : undefined;
  };
  const one = (k: string) => list(k)?.[0];
  // `fields` is {"key": ["option id", …]}; anything else (a hand-edited link) is dropped, never trusted.
  let fields: Record<string, string[]> | undefined;
  try {
    const raw: unknown = JSON.parse(search.get("fields") ?? "null");
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const ok = Object.entries(raw).filter(
        (e): e is [string, string[]] =>
          Array.isArray(e[1]) && e[1].length > 0 && e[1].every((v) => typeof v === "string"),
      );
      if (ok.length) fields = Object.fromEntries(ok);
    }
  } catch {
    fields = undefined;
  }
  const out: AnalyticsFilters = {};
  if (one("pipeline")) out.pipeline = one("pipeline");
  if (list("owner")) out.owners = list("owner");
  if (one("team")) out.team = one("team");
  if (list("source")) out.sources = list("source");
  if (list("tag")) out.tags = list("tag");
  if (fields && Object.keys(fields).length) out.fields = fields;
  return out;
}
/** Each tab's board, as its CSV export is named (the API's CSV_MODULES). */
const CSV_BOARD: Partial<Record<Tab, string>> = {
  overview: "overview",
  funnel: "funnel",
  team: "team",
  revenue: "sources",
  lost: "lost",
  timing: "timing",
  quality: "quality",
};

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
  revenue: Revenue | null;
  lost: Lost | null;
  timing: Timing | null;
  quality: Quality | null;
  templates: Templates | null;
  insights: Insights | null;
  goals: Goals | null;
  me: Me | null;
};
const EMPTY: Data = {
  overview: null,
  funnel: null,
  team: null,
  sources: null,
  revenue: null,
  lost: null,
  timing: null,
  quality: null,
  templates: null,
  insights: null,
  goals: null,
  me: null,
};
/** What each module reads. */
const NEEDS: Record<Tab, (keyof Data)[]> = {
  overview: ["overview", "funnel", "timing", "quality", "insights", "goals"],
  funnel: ["funnel"],
  team: ["team", "insights"],
  revenue: ["sources", "revenue"],
  lost: ["lost", "insights"],
  timing: ["timing", "insights"],
  quality: ["quality", "templates"],
};

/**
 * Analytics (8C, canvas 6X1u5VivMqy438qemCsPRH): one bar to pick the module, the range and whether to compare; each
 * module reads its numbers at the viewer's reach, and every number with leads behind it opens them.
 */
export function Analytics({
  catalog,
  showTeam,
  reach = "all",
  timezone,
  canExport = false,
  seesMoney = false,
  canEditSpend = false,
  canManageSources = false,
  meId,
}: {
  catalog: Catalog;
  /** The leaderboard is for those who see more than themselves. */
  showTeam: boolean;
  /** The viewer's analytics reach. */
  reach?: "all" | "team" | "own";
  timezone: string;
  /** Export these numbers (CSV), for someone who may export. */
  canExport?: boolean;
  /** analytics.revenue: the money boards and figures. */
  seesMoney?: boolean;
  /** Settings → Spend, for an admin who sets what each source costs. */
  canEditSpend?: boolean;
  /** integrations.manage: Templates & data links to the sources that need a look. */
  canManageSources?: boolean;
  /** The viewer, so the Filters panel can offer them among their team. */
  meId?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const own = !showTeam;
  const tabs = own ? REP_TABS : TABS;
  const tab = (tabs.some((t) => t.id === search.get("m")) ? search.get("m") : "overview") as Tab;
  // What this tab reads: a rep's numbers come from their own endpoint; revenue only with the money permission.
  const needs = (t: Tab): (keyof Data)[] =>
    own && t === "overview" ? ["me"] : NEEDS[t].filter((x) => x !== "revenue" || seesMoney);
  // The range (canvas Main's popover): a choice, or the days of a custom one; today in the business's timezone.
  const today = dayIn(new Date(), timezone);
  const fromQ = search.get("from");
  const toQ = search.get("to");
  const custom =
    fromQ && toQ && ISO_DAY.test(fromQ) && ISO_DAY.test(toQ) ? { from: fromQ, to: toQ } : undefined;
  const asked = search.get("range") ?? "30d";
  const choice = (CHOICES.has(asked) && (asked !== "custom" || custom) ? asked : "30d") as RangeChoice;
  const compare = search.get("compare") !== "0";
  // What narrows every board (the Filters panel), from the address.
  const filters = readFilters(search);
  const params: AnalyticsParams = {
    ...apiRange(choice, today, custom),
    compare,
    ...(filters.pipeline ? { pipeline: filters.pipeline } : {}),
    ...(filters.owners?.length ? { owners: filters.owners } : {}),
    ...(filters.team ? { team: filters.team } : {}),
    ...(filters.sources?.length ? { sources: filters.sources } : {}),
    ...(filters.tags?.length ? { tags: filters.tags } : {}),
    ...(filters.fields ? { fields: filters.fields } : {}),
  };
  const key = `${choice}|${custom?.from ?? ""}|${custom?.to ?? ""}|${compare}|${JSON.stringify(filters)}`;
  const rangeDays = daysBetween(...daysOf(choice, today, custom));
  // "These numbers cover N of M leads": new leads in the range with the filters, and with none, read only while one
  // is on — whichever board is open (the Overview board's own count is reused when it has one).
  const [coverage, setCoverage] = useState<{ key: string; shown: number | null; all: number | null } | null>(
    null,
  );
  const [teamName, setTeamName] = useState<string | null>(null);
  useEffect(() => {
    if (!filterCount(filters) || coverage?.key === key) return;
    let live = true;
    const newLeads = (r: Awaited<ReturnType<typeof analyticsClient.overview>>) =>
      r.ok ? (r.data.tiles.find((t) => t.id === "new_leads")?.value ?? null) : null;
    void Promise.all([
      analyticsClient.overview({ ...params, compare: false }),
      analyticsClient.overview({ ...apiRange(choice, today, custom), compare: false }),
    ]).then(([shown, all]) => {
      if (live) setCoverage({ key, shown: newLeads(shown), all: newLeads(all) });
    });
    return () => {
      live = false;
    };
  }, [key]);
  useEffect(() => {
    if (!filters.team) return setTeamName(null);
    void analyticsClient
      .teams()
      .then((r) => r.ok && setTeamName(r.data.teams.find((t) => t.id === filters.team)?.name ?? null));
  }, [filters.team]);
  const setFilters = (next: AnalyticsFilters) => {
    const q = new URLSearchParams(search.toString());
    for (const k of ["pipeline", "owner", "team", "source", "tag", "fields"]) q.delete(k);
    if (next.pipeline) q.set("pipeline", next.pipeline);
    if (next.owners?.length) q.set("owner", next.owners.join(","));
    if (next.team) q.set("team", next.team);
    if (next.sources?.length) q.set("source", next.sources.join(","));
    if (next.tags?.length) q.set("tag", next.tags.join(","));
    if (next.fields && Object.keys(next.fields).length) q.set("fields", JSON.stringify(next.fields));
    const qs = q.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const [data, setData] = useState<Data>(EMPTY);
  const [forKey, setForKey] = useState<string | null>(null);
  // A board that couldn't be counted, with what LUME was told; cleared with the range, and by Try again.
  const [failed, setFailed] = useState<Partial<Record<keyof Data, string>>>({});
  const [attempt, setAttempt] = useState(0);
  const [drill, setDrill] = useState<{ token: string; title: string } | null>(null);

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
      setFailed({});
      setForKey(key);
    }
  }, [key, forKey]);
  const loading = forKey === key ? needs(tab).filter((k) => data[k] === null && !failed[k]) : needs(tab);
  const error =
    needs(tab)
      .map((k) => failed[k])
      .find(Boolean) ?? null;
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
      revenue: () => analyticsClient.revenue(params),
      me: () => analyticsClient.me(params),
      templates: () => analyticsClient.templates(params),
      insights: () => analyticsClient.insights(params),
      goals: () => analyticsClient.goals(start),
    };
    // Revenue is money only: someone without analytics.revenue never asks for it.
    for (const k of needs(tab).filter((x) => data[x] === null && !failed[x]))
      void fetchers[k]().then((r) => {
        if (!live) return;
        if (r.ok) setData((d) => ({ ...d, [k]: r.data }));
        else setFailed((f) => ({ ...f, [k]: r.message ?? "LUME couldn’t count these numbers right now." }));
      });
    return () => {
      live = false;
    };
    // Each module's numbers, once per range; `data` is read only to skip what's already here.
  }, [tab, key, forKey, attempt]);

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
        <div className={s.controls}>
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
          <FiltersButton
            filters={filters}
            catalog={catalog}
            rangeDays={rangeDays}
            coverage={
              coverage?.key === key
                ? { shown: coverage.shown, all: coverage.all }
                : { shown: null, all: null }
            }
            onChange={setFilters}
            reach={own ? "own" : reach}
            {...(meId ? { meId } : {})}
          />
          {/* This board's numbers as a spreadsheet, for someone who may export (8D spec §5). */}
          {canExport && CSV_BOARD[tab] && (
            <a
              className={s.exportBtn}
              href={`/api/v1/analytics/${CSV_BOARD[tab]}/csv?${query(params)}`}
              download
              aria-label="Export these numbers (CSV)"
              title="Export these numbers (CSV)"
            >
              <svg viewBox="0 0 24 24" aria-hidden>
                <path d="M12 3v12" />
                <path d="m7 10 5 5 5-5" />
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              </svg>
            </a>
          )}
        </div>
      </div>
      <FilterChips filters={filters} catalog={catalog} teamName={teamName} onChange={setFilters} />

      {error && (
        <div role="alert" className={s.failed}>
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              setFailed({});
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}

      <div role="tabpanel" aria-label={tabs.find((t) => t.id === tab)!.label}>
        {tab === "overview" && own && (
          <RepNumbers
            me={data.me}
            currency={catalog.currency}
            timezone={timezone}
            compare={compare}
            rangeWords={r.words}
          />
        )}
        {tab === "overview" && !own && (
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
        {tab === "funnel" && (
          <FunnelBoard
            funnel={data.funnel}
            params={params}
            rangeWords={r.words}
            currency={catalog.currency}
            onDrill={(token, title) => setDrill({ token, title })}
          />
        )}
        {tab === "team" && (
          <TeamBoard
            team={data.team}
            insights={data.insights}
            catalog={catalog}
            compare={compare}
            rangeWords={r.words}
            onDrill={(token, title) => setDrill({ token, title })}
          />
        )}
        {tab === "revenue" && (
          <RevenueBoard
            revenue={seesMoney ? data.revenue : undefined}
            sources={data.sources}
            catalog={catalog}
            compare={compare}
            rangeWords={r.words}
            canEditSpend={canEditSpend}
            onDrill={(token, title) => setDrill({ token, title })}
          />
        )}
        {tab === "lost" && (
          <LostBoard
            lost={data.lost}
            insights={data.insights}
            params={params}
            rangeWords={r.words}
            rangeDays={rangeDays}
            currency={catalog.currency}
            compare={compare}
            onDrill={(token, title) => setDrill({ token, title })}
          />
        )}
        {tab === "timing" && (
          <TimingBoard
            timing={data.timing}
            insights={data.insights}
            catalog={catalog}
            timezone={timezone}
            compare={compare}
            rangeWords={r.words}
            onDrill={(token, title) => setDrill({ token, title })}
          />
        )}
        {tab === "quality" && (
          <QualityBoard
            quality={data.quality}
            templates={data.templates}
            rangeWords={r.words}
            canManageSources={canManageSources}
            onDrill={(token, title) => setDrill({ token, title })}
          />
        )}
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
