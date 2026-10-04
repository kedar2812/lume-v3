"use client";
import { AnimatePresence } from "motion/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { can, scopeOf } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/feedback/ToastProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { ImportSheet } from "@/components/imports/ImportSheet";
import { AttentionBanner } from "@/components/integrations/AttentionBanner";
import { RefreshButton } from "@/components/sheets/RefreshButton";
import { importsClient } from "@/lib/imports/client";
import { useAfter, useCountdown, useLoadingSignal } from "@/lib/loading";
import { sheetsClient } from "@/lib/sheets/client";
import type { SheetsStatus } from "@/lib/sheets/types";
import { leadsClient } from "@/lib/leads/client";
import { availableColumns, loadColumnChoice, resolveColumns, saveColumnChoice } from "@/lib/leads/columns";
import {
  activeFilterCount,
  apiQuery,
  filtersToParams,
  fromViewFilters,
  toViewFilters,
  type ListFilters,
  type Sort,
} from "@/lib/leads/filters";
import { tokenColor } from "@/lib/leads/colors";
import { viewsChanged, viewsClient, type ViewView } from "@/lib/views/client";
import { SaveView } from "@/components/views/SaveView";
import { StartRun } from "@/components/queue/StartRun";
import { suggestFor } from "@/lib/templates/order";
import type { Catalog, Lead, LeadPage } from "@/lib/leads/types";
import type { Session } from "@/server/session";
import { Island } from "./island/Island";
import { RunsDrawer } from "./runs/RunsDrawer";
import { selectionBody, type RunView } from "@/lib/leads/bulk-runs";
import { CatalogProvider } from "./CatalogProvider";
import { ColumnPicker } from "./ColumnPicker";
import { ExportSheet } from "./ExportSheet";
import { LeadDrawer } from "./drawer/LeadDrawer";
import { EditableCell } from "./EditableCell";
import { FilterBar } from "./FilterBar";
import { LeadsTable } from "./LeadsTable";
import { NewLeadSheet } from "./NewLeadSheet";
import { StageStrip } from "./StageStrip";
import { editable, useLeadEditor } from "./useLeadEditor";
import { useArrivals } from "./useArrivals";
import s from "./leads.module.css";

type Props = {
  session: Session;
  catalog: Catalog;
  contactsVisible: boolean;
  initialFilters: ListFilters;
  first: LeadPage | null;
  /** The lead open in the drawer when the page loaded (`?lead=`). */
  initialLeadId?: string | null;
  /** The saved view the page opened (`?view=`, 4B): its name above the filters, and Update view. */
  view?: ViewView | null;
};

/** Two sets of saved filters say the same thing (order and stale parts aside). */
const sameFilters = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * The list behind the table, fetched page by page. Every new set of filters starts a new "generation",
 * and an answer for an older one is dropped, so a slow response can never overwrite a newer one.
 */
function useLeadList(filters: ListFilters, first: LeadPage | null) {
  const [rows, setRows] = useState<Lead[]>(first?.items ?? []);
  const [cursor, setCursor] = useState<string | null>(first?.nextCursor ?? null);
  const [capped, setCapped] = useState(!!first?.searchCapped);
  const [loading, setLoading] = useState(false);
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState<"offline" | "busy" | "load" | null>(first === null ? "load" : null);
  const generation = useRef(0);
  const skipFirst = useRef(first !== null); // the server already sent page one for these filters

  const fetchPage = useCallback(
    async (after?: string) => {
      const gen = after ? generation.current : ++generation.current;
      setLoading(true);
      setAppending(!!after);
      setError(null);
      const r = await leadsClient.list(filters, after);
      if (gen !== generation.current) return;
      setLoading(false);
      setAppending(false);
      if (!r.ok)
        return setError(r.code === "OFFLINE" ? "offline" : r.code === "RATE_LIMITED" ? "busy" : "load");
      setRows((prev) =>
        after ? [...prev, ...r.data.items.filter((x) => !prev.some((p) => p.id === x.id))] : r.data.items,
      );
      setCursor(r.data.nextCursor);
      if (!after) setCapped(!!r.data.searchCapped);
    },
    [filters],
  );

  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const t = setTimeout(() => void fetchPage(), filters.q ? 250 : 0); // typing waits for a pause
    return () => clearTimeout(t);
  }, [fetchPage, filters]);

  const replace = useCallback(
    (lead: Lead) => setRows((prev) => prev.map((x) => (x.id === lead.id ? lead : x))),
    [],
  );

  return {
    rows,
    loading,
    appending,
    error,
    capped,
    hasMore: cursor !== null,
    loadMore: () => {
      if (cursor && !loading) void fetchPage(cursor);
    },
    reload: () => void fetchPage(),
    replace,
    removeRow: (id: string) => setRows((prev) => prev.filter((x) => x.id !== id)),
    prepend: (lead: Lead) => setRows((prev) => [lead, ...prev.filter((x) => x.id !== lead.id)]),
  };
}

/**
 * How many leads each stage holds under the other filters (not the stage filter itself, so the strip
 * never collapses to the stage you picked). Refetched when the filters change or a lead moves.
 */
function useStageCounts(filters: ListFilters, pipelineId: string | undefined, tick: number) {
  const [data, setData] = useState<{ counts: Record<string, number>; total: number } | null>(null);
  const key = JSON.stringify({ ...filters, stageIds: [], sort: undefined });
  useEffect(() => {
    if (!pipelineId) return;
    let live = true;
    const f = { ...(JSON.parse(key) as ListFilters), stageIds: [], sort: "newest" as Sort, pipelineId };
    const t = setTimeout(
      async () => {
        const r = await leadsClient.counts(f);
        if (live && r.ok) setData(r.data);
      },
      f.q ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, pipelineId, tick]);
  return data;
}

/** "since yesterday", "since this morning", "since Monday" — when the last visit was, in words. */
function sinceWords(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.floor(
    (new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000,
  );
  if (days <= 0) return d.getHours() < 12 ? "this morning" : "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return d.toLocaleDateString("en", { weekday: "long" });
  return d.toLocaleDateString("en", { day: "numeric", month: "short" });
}

const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "updated", label: "Last activity" },
  { value: "name", label: "Name" },
];

/** The leads table. The catalog is provided around it, so every part below can look things up. */
export function LeadsScreen(props: Props) {
  return (
    <CatalogProvider catalog={props.catalog}>
      <Screen {...props} />
    </CatalogProvider>
  );
}

function Screen({
  session,
  catalog,
  contactsVisible,
  initialFilters,
  first,
  initialLeadId = null,
  view = null,
}: Props) {
  const [filters, setFilters] = useState<ListFilters>(initialFilters);
  const [activeView, setActiveView] = useState<ViewView | null>(view);
  // Opened again from the sidebar (after Close view, or to start over): the page sends the view afresh,
  // and it opens as saved (4B review).
  useEffect(() => {
    if (!view) return;
    setActiveView(view);
    setFilters(initialFilters);
  }, [view]);
  // What the view says, read as this screen reads it, so a stale part never counts as "changed".
  const viewSays = activeView ? toViewFilters(fromViewFilters(activeView.filters, catalog)) : null;
  const viewChanged = !!viewSays && !sameFilters(viewSays, toViewFilters(filters));
  const { toast } = useToast();
  const updateView = async () => {
    if (!activeView) return;
    const r = await viewsClient.update(activeView.id, { filters: toViewFilters(filters) });
    if (!r.ok) return toast({ tone: "danger", title: "The view wasn’t updated", detail: r.message });
    setActiveView(r.data);
    viewsChanged();
  };
  const [openId, setOpenId] = useState<string | null>(initialLeadId);
  const [creating, setCreating] = useState(false);
  // With several pipelines the table shows one at a time, so its stages and counts match the rows.
  const multiPipeline = catalog.pipelines.length > 1;
  const shownPipeline =
    catalog.pipelines.find((p) => p.id === filters.pipelineId) ??
    catalog.pipelines.find((p) => p.isDefault) ??
    catalog.pipelines[0];
  const listFilters = useMemo(
    () => (multiPipeline && shownPipeline ? { ...filters, pipelineId: shownPipeline.id } : filters),
    [filters, multiPipeline, shownPipeline],
  );
  const list = useLeadList(listFilters, first);
  // Loading, said plainly (7C): the top bar's bar; stale rows dim, then turn to skeletons after 1.2 s; a word after
  // 3 s; offline, LUME tries again on its own every 5 s and says when.
  useLoadingSignal(list.loading);
  const staleLong = useAfter(list.loading && !list.appending && list.rows.length > 0, 1200);
  const slow = useAfter(list.loading, 3000);
  const retryIn = useCountdown(list.error === "offline", 5, list.reload);
  const available = useMemo(() => availableColumns(catalog, contactsVisible), [catalog, contactsVisible]);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const mayCreate = can(session.actor, "leads.create");
  const mayBulk = can(session.actor, "leads.bulk_edit");
  // 4C: a rep who may run a send queue selects leads to message them, even without bulk edits.
  const maySelect = mayBulk || can(session.actor, "messages.send_queue");
  const mayImport = can(session.actor, "leads.import");
  // 6B: export the current view, marked and traceable.
  const mayExport = can(session.actor, "leads.export");
  const [exporting, setExporting] = useState(false);
  // 7C: Recent bulk actions, from the toolbar.
  const [runsOpen, setRunsOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  // A finished import of yours not looked at yet: Import wears a dot, and opens its report first.
  const [unseenImport, setUnseenImport] = useState<string | null>(null);
  useEffect(() => {
    if (!mayImport) return;
    let live = true;
    void importsClient.list().then((r) => {
      if (!live || !r.ok) return;
      const waiting = r.data.imports.find(
        (i) => i.mine && ["done", "failed", "stopped_access"].includes(i.status) && !i.seenAt,
      );
      setUnseenImport(waiting?.id ?? null);
    });
    return () => {
      live = false;
    };
  }, [mayImport]);
  // 2B spec §8.1: Refresh shows once a sheet is connected; admins also hear which sheet needs them.
  const [sheets, setSheets] = useState<SheetsStatus | null>(null);
  useEffect(() => {
    let live = true;
    void sheetsClient.status().then((r) => {
      if (live && r.ok) setSheets(r.data);
    });
    return () => {
      live = false;
    };
  }, []);
  const personal = scopeOf(session.actor, "leads.view") !== "all";
  const arrivals = useArrivals();
  const [selected, setSelected] = useState<string[]>([]);
  // 7C: every lead that matches, minus the ones unticked (sent as the filter, never as ids).
  const [allMatching, setAllMatching] = useState(false);
  const [except, setExcept] = useState<string[]>([]);
  const [, setRun] = useState<RunView | null>(null);
  const anchor = useRef<string | null>(null);
  const editor = useLeadEditor(list.replace);
  const pipeline = shownPipeline;
  const [countsTick, recount] = useReducer((n: number) => n + 1, 0);
  const stageCounts = useStageCounts(filters, pipeline?.id, countsTick);

  // N starts a new lead from anywhere on the page that isn't a field or an open panel.
  useEffect(() => {
    if (!mayCreate || openId || creating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable], [role=dialog]"))
        return;
      e.preventDefault();
      setCreating(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mayCreate, openId, creating]);

  // The saved column choice lives in this browser, so it's read after mount (the server can't know it).
  useEffect(() => setChosen(loadColumnChoice(session.user.id)), [session.user.id]);
  const columns = resolveColumns(chosen, available);

  // The address bar mirrors the filters and the open lead, without a server round trip per keystroke.
  useEffect(() => {
    // An open view leads the address, so a reload or a shared link opens it again.
    const p = new URLSearchParams(activeView ? { view: activeView.id } : {});
    for (const [k, v] of filtersToParams(filters)) p.set(k, v);
    if (openId) p.set("lead", openId);
    const qs = p.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (url !== window.location.pathname + window.location.search) window.history.replaceState(null, "", url);
  }, [filters, openId, activeView]);

  // Selection survives paging and sorting, but a different set of filters starts afresh.
  const filterKey = JSON.stringify({ ...filters, sort: undefined });
  useEffect(() => {
    setSelected([]);
    setAllMatching(false);
    setExcept([]);
    anchor.current = null;
  }, [filterKey]);
  const toggle = (id: string, range: boolean) => {
    if (allMatching) {
      setExcept((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
      return;
    }
    const ids = list.rows.map((r) => r.id);
    const from = anchor.current;
    setSelected((prev) => {
      const on = !prev.includes(id);
      if (range && from && ids.includes(from)) {
        const [start, end] = [ids.indexOf(from), ids.indexOf(id)].sort((x, y) => x - y) as [number, number];
        const span = ids.slice(start, end + 1);
        return on ? [...new Set([...prev, ...span])] : prev.filter((x) => !span.includes(x));
      }
      return on ? [...prev, id] : prev.filter((x) => x !== id);
    });
    anchor.current = id;
  };
  const loadedIds = list.rows.map((r) => r.id);
  const allLoaded =
    loadedIds.length > 0 && (allMatching ? !except.length : loadedIds.every((id) => selected.includes(id)));
  const someLoaded = !allLoaded && (allMatching || loadedIds.some((id) => selected.includes(id)));
  // How many leads match the filters, as the stage strip counts them (the stage filter included).
  const matchTotal = stageCounts
    ? filters.stageIds.length
      ? filters.stageIds.reduce((a, id) => a + (stageCounts.counts[id] ?? 0), 0)
      : stageCounts.total
    : loadedIds.length;
  const selectedCount = allMatching ? Math.max(0, matchTotal - except.length) : selected.length;
  const isPicked = (id: string) => (allMatching ? !except.includes(id) : selected.includes(id));
  const clearSelection = () => {
    setSelected([]);
    setAllMatching(false);
    setExcept([]);
  };

  // Scrolling near the end loads the next page; the Load more button stays for keyboard and screen readers.
  const { hasMore, loadMore } = list;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && loadMore(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  const chooseColumns = (ids: string[]) => {
    setChosen(ids);
    saveColumnChoice(session.user.id, ids);
  };
  const clear = () => setFilters({ stageIds: [], sort: filters.sort });
  const filtered = activeFilterCount(filters) > 0;
  const boardHref = `/pipeline${(() => {
    const p = filtersToParams({ ...filters, stageIds: [] });
    return p.toString() ? `?${p}` : "";
  })()}`;

  const body = (() => {
    if (list.error)
      return (
        <ErrorState
          title="LUME can’t load leads right now"
          message={
            list.error === "offline"
              ? `It looks like you’re offline. LUME will try again in ${retryIn ?? 5} s.`
              : list.error === "busy"
                ? "Too many requests from this network right now. Wait a moment, then try again."
                : "Check your connection, then try again."
          }
          action={{ label: "Try again", onClick: list.reload }}
        />
      );
    if (!list.loading && list.rows.length === 0)
      return filtered ? (
        <EmptyState
          title="Nothing matches these filters"
          body="Try fewer filters, or clear them."
          action={<Button onClick={clear}>Clear filters</Button>}
        />
      ) : (
        <EmptyState
          title="No leads yet"
          body="New leads from your forms, or ones you add, will appear here."
          action={
            mayCreate ? (
              <Button variant="primary" title="New lead (N)" onClick={() => setCreating(true)}>
                New lead
              </Button>
            ) : undefined
          }
        />
      );
    return (
      <>
        {arrivals.count > 20 && arrivals.since && !filters.arrivedAfter && (
          <p className={s.arrivals}>
            {arrivals.count.toLocaleString("en")} new since {sinceWords(arrivals.since)} ·
            <button type="button" onClick={() => setFilters({ ...filters, arrivedAfter: arrivals.since! })}>
              Show only these
            </button>
          </p>
        )}
        {list.capped && (
          <p className={s.capped} role="note">
            <span className={s.horizon} aria-hidden>
              <i />
            </span>
            <span>
              <b>More than 10,000 leads match.</b> LUME lists the newest 10,000. Add another word, or a
              filter, to find the rest.
            </span>
          </p>
        )}
        {maySelect && (allMatching || (allLoaded && list.hasMore)) && (
          <p className={s.selectAll} role="status" data-all={allMatching || undefined}>
            {allMatching ? (
              <>
                All <b>{selectedCount.toLocaleString("en-US")}</b> that match are selected
                {except.length ? ` (${except.length} left out)` : ""}.
                <button type="button" onClick={clearSelection}>
                  Clear
                </button>
              </>
            ) : (
              <>
                All <b>{loadedIds.length}</b> on this page are selected.
                <button
                  type="button"
                  onClick={() => {
                    setAllMatching(true);
                    setExcept([]);
                  }}
                >
                  Select all {matchTotal.toLocaleString("en-US")} that match
                </button>
              </>
            )}
          </p>
        )}
        <LeadsTable
          glowing={arrivals.glowing}
          catalog={catalog}
          columns={columns}
          rows={list.rows}
          loading={list.loading}
          stale={staleLong}
          appending={list.appending}
          sort={filters.sort}
          onSort={(sort) => setFilters({ ...filters, sort })}
          openId={openId}
          onOpen={setOpenId}
          selection={
            maySelect
              ? {
                  header: (
                    <HeaderCheck
                      checked={allLoaded}
                      mixed={someLoaded}
                      onToggle={() =>
                        allMatching
                          ? clearSelection()
                          : setSelected((prev) =>
                              allLoaded
                                ? prev.filter((id) => !loadedIds.includes(id))
                                : [...new Set([...prev, ...loadedIds])],
                            )
                      }
                    />
                  ),
                  cell: (lead) => (
                    <input
                      type="checkbox"
                      className={s.checkbox}
                      aria-label={`Select ${lead.name ?? "lead"}`}
                      checked={isPicked(lead.id)}
                      onChange={() => undefined}
                      onClick={(e) => toggle(lead.id, e.shiftKey)}
                    />
                  ),
                }
              : undefined
          }
          renderCell={(lead, col, content) => {
            const def =
              col.fieldKey && col.id !== "name"
                ? catalog.fields.find((f) => f.key === col.fieldKey)
                : undefined;
            if (!def || !editable(lead, def)) return content;
            return (
              <EditableCell
                lead={lead}
                def={def}
                save={editor.save}
                error={
                  editor.error?.leadId === lead.id && editor.error.key === def.key
                    ? editor.error.message
                    : null
                }
                onDismissError={editor.clearError}
              >
                {content}
              </EditableCell>
            );
          }}
        />
        {slow && (
          <p className={s.slow} role="status">
            <span className={s.slowDot} aria-hidden />
            Taking longer than usual. LUME is still loading.
          </p>
        )}
        {list.hasMore && (
          <div className={s.loadMore} ref={sentinel}>
            <Button onClick={list.loadMore} loading={list.loading}>
              Load more
            </Button>
          </div>
        )}
      </>
    );
  })();

  return (
    <section className={s.screen}>
      {sheets && <AttentionBanner items={sheets.attention} />}
      <div className={s.toolbar} data-testid="leads-toolbar">
        {activeView && (
          <div className={s.viewHead}>
            <span className={s.viewDot} style={{ background: tokenColor(activeView.color) }} aria-hidden />
            <h2 className={s.viewName}>{activeView.name}</h2>
            {viewChanged && activeView.canEdit && (
              <Button size="sm" variant="secondary" onClick={() => void updateView()}>
                Update view
              </Button>
            )}
            {/* 4C: a run through the view's leads, as the view is saved (plan ruling R2). */}
            {can(session.actor, "messages.send_queue") && (
              <StartRun
                // Changes not saved yet: the run is what's shown (named "… (as shown)").
                source={
                  viewChanged
                    ? { viewId: activeView.id, filters: toViewFilters(filters) }
                    : { viewId: activeView.id }
                }
                suggest={suggestFor(
                  activeView.filters,
                  catalog.pipelines.flatMap((p) =>
                    p.stages.filter((st) => st.kind === "lost").map((st) => st.id),
                  ),
                )}
              />
            )}
            <button
              type="button"
              className={s.viewClose}
              aria-label="Close view"
              title="Close view (keeps the filters)"
              onClick={() => setActiveView(null)}
            >
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
                <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )}
        <div className={`${s.bar} ${s.stagesBar}`}>
          {multiPipeline && pipeline && (
            <label className={s.select}>
              <span className={s.srOnly}>Pipeline</span>
              <select
                aria-label="Pipeline"
                value={pipeline.id}
                onChange={(e) => setFilters({ ...filters, pipelineId: e.target.value, stageIds: [] })}
              >
                {catalog.pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <Caret />
            </label>
          )}
          {pipeline && (
            <StageStrip
              stages={[...pipeline.stages].sort((a, b) => a.position - b.position)}
              counts={stageCounts?.counts ?? null}
              total={stageCounts?.total ?? null}
              selected={filters.stageIds}
              onChange={(stageIds) => setFilters({ ...filters, stageIds })}
            />
          )}
          <div className={s.right}>
            <nav className={s.views} aria-label="View">
              <span aria-current="page">Table</span>
              <Link href={boardHref}>Board</Link>
            </nav>
            {sheets?.refresh && (
              <RefreshButton
                personal={personal}
                onArrived={(p) => {
                  list.reload();
                  recount();
                  arrivals.flash(p.leadIds);
                }}
              />
            )}
            {mayBulk && (
              <button
                type="button"
                className={s.historyBtn}
                aria-label="Recent bulk actions"
                title="Recent bulk actions"
                onClick={() => setRunsOpen(true)}
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M12 7v5l4 2" />
                </svg>
              </button>
            )}
            {mayImport && (
              <Button
                variant="secondary"
                aria-label={unseenImport ? "Import — a finished import to look at" : "Import"}
                onClick={() => setImporting(true)}
              >
                Import
                {unseenImport && <span className={s.dot} aria-hidden />}
              </Button>
            )}
            {mayCreate && (
              <Button variant="primary" title="New lead (N)" onClick={() => setCreating(true)}>
                New lead
              </Button>
            )}
          </div>
        </div>
        <div className={s.bar}>
          <FilterBar
            session={session}
            catalog={catalog}
            filters={filters}
            onChange={setFilters}
            contactsVisible={contactsVisible}
            hideStage
          />
          <div className={s.right}>
            {/* Save view (4B): beside the filters it saves, with the list's own controls. */}
            {activeFilterCount({ ...filters, stageIds: [] }) + filters.stageIds.length > 0 && (
              <SaveView
                filters={filters}
                catalog={catalog}
                canShare={can(session.actor, "views.manage")}
                onSaved={setActiveView}
              />
            )}
            <label className={s.select}>
              <span className={s.srOnly}>Sort</span>
              <select
                aria-label="Sort"
                value={filters.sort}
                onChange={(e) => setFilters({ ...filters, sort: e.target.value as Sort })}
              >
                {SORTS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <ColumnPicker available={available} chosen={columns.map((c) => c.id)} onChange={chooseColumns} />
            {mayExport && (
              <button type="button" className={s.tool} onClick={() => setExporting(true)}>
                Export
              </button>
            )}
          </div>
        </div>
      </div>
      {body}
      {exporting && (
        <ExportSheet
          label={activeView?.name ?? (activeFilterCount(listFilters) > 0 ? "Filtered leads" : "All leads")}
          count={
            stageCounts
              ? listFilters.stageIds.length
                ? listFilters.stageIds.reduce((sum, id) => sum + (stageCounts.counts[id] ?? 0), 0)
                : stageCounts.total
              : null
          }
          columns={columns.map((c) => c.id)}
          filters={Object.fromEntries(new URLSearchParams(apiQuery(listFilters)))}
          onClose={() => setExporting(false)}
        />
      )}
      <AnimatePresence>
        {maySelect && (
          <Island
            key="bulk"
            session={session}
            count={selectedCount}
            allMatching={allMatching}
            leadIds={allMatching ? [] : selected}
            selection={() =>
              selectionBody(
                { mode: allMatching ? "all" : "ids", ids: selected, except },
                listFilters,
                selectedCount,
              )
            }
            phoneFixable={list.rows.some(
              (r) => isPicked(r.id) && (r.phone?.status === "needs_country" || r.phone?.status === "invalid"),
            )}
            onRun={setRun}
            onClear={clearSelection}
            onFinished={() => {
              list.reload();
              recount();
            }}
          />
        )}
      </AnimatePresence>
      {runsOpen && (
        <RunsDrawer
          session={session}
          onClose={() => setRunsOpen(false)}
          onChanged={() => {
            list.reload();
            recount();
          }}
        />
      )}
      <ImportSheet
        open={importing}
        {...(unseenImport ? { importId: unseenImport } : {})}
        onClose={() => {
          setImporting(false);
          setUnseenImport(null);
          list.reload();
          recount();
        }}
      />
      {/* One drawer for the whole visit: J/K swap the lead inside it rather than remounting it. */}
      <AnimatePresence>
        {openId && (
          <LeadDrawer
            key="drawer"
            id={openId}
            session={session}
            neighbours={list.rows.map((r) => r.id)}
            onClose={() => setOpenId(null)}
            onStep={setOpenId}
            onChanged={(lead) => {
              list.replace(lead);
              recount();
            }}
            onGone={(id) => {
              list.removeRow(id);
              recount();
              setOpenId(null);
            }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {creating && (
          <NewLeadSheet
            key="new"
            session={session}
            onClose={() => setCreating(false)}
            onCreated={(lead) => {
              setCreating(false);
              list.prepend(lead);
              recount();
              setOpenId(lead.id);
              toast({ tone: "ok", title: "Lead added", detail: lead.name });
            }}
          />
        )}
      </AnimatePresence>
    </section>
  );
}

const Caret = () => (
  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden className={s.caret}>
    <path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/** "Select all loaded": checked, unchecked, or mixed when only some loaded rows are selected. */
function HeaderCheck({
  checked,
  mixed,
  onToggle,
}: {
  checked: boolean;
  mixed: boolean;
  onToggle: () => void;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={box}
      type="checkbox"
      className={s.checkbox}
      aria-label="Select all loaded"
      checked={checked}
      onChange={onToggle}
    />
  );
}
