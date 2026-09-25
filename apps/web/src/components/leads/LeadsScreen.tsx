"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { can } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { leadsClient } from "@/lib/leads/client";
import { availableColumns, loadColumnChoice, resolveColumns, saveColumnChoice } from "@/lib/leads/columns";
import { activeFilterCount, filtersToParams, type ListFilters, type Sort } from "@/lib/leads/filters";
import type { Catalog, Lead, LeadPage } from "@/lib/leads/types";
import type { Session } from "@/server/session";
import { CatalogProvider } from "./CatalogProvider";
import { ColumnPicker } from "./ColumnPicker";
import { FilterBar } from "./FilterBar";
import { LeadsTable } from "./LeadsTable";
import s from "./leads.module.css";

type Props = {
  session: Session;
  catalog: Catalog;
  contactsVisible: boolean;
  initialFilters: ListFilters;
  first: LeadPage | null;
  /** The lead open in the drawer when the page loaded (`?lead=`). */
  initialLeadId?: string | null;
};

/**
 * The list behind the table, fetched page by page. Every new set of filters starts a new "generation",
 * and an answer for an older one is dropped, so a slow response can never overwrite a newer one.
 */
function useLeadList(filters: ListFilters, first: LeadPage | null) {
  const [rows, setRows] = useState<Lead[]>(first?.items ?? []);
  const [cursor, setCursor] = useState<string | null>(first?.nextCursor ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<"offline" | "load" | null>(first === null ? "load" : null);
  const generation = useRef(0);
  const skipFirst = useRef(first !== null); // the server already sent page one for these filters

  const fetchPage = useCallback(
    async (after?: string) => {
      const gen = after ? generation.current : ++generation.current;
      setLoading(true);
      setError(null);
      const r = await leadsClient.list(filters, after);
      if (gen !== generation.current) return;
      setLoading(false);
      if (!r.ok) return setError(r.code === "OFFLINE" ? "offline" : "load");
      setRows((prev) =>
        after ? [...prev, ...r.data.items.filter((x) => !prev.some((p) => p.id === x.id))] : r.data.items,
      );
      setCursor(r.data.nextCursor);
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

  return {
    rows,
    loading,
    error,
    hasMore: cursor !== null,
    loadMore: () => {
      if (cursor && !loading) void fetchPage(cursor);
    },
    reload: () => void fetchPage(),
    replace: (lead: Lead) => setRows((prev) => prev.map((x) => (x.id === lead.id ? lead : x))),
    removeRow: (id: string) => setRows((prev) => prev.filter((x) => x.id !== id)),
    prepend: (lead: Lead) => setRows((prev) => [lead, ...prev.filter((x) => x.id !== lead.id)]),
  };
}

const SORTS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "updated", label: "Last activity" },
  { value: "name", label: "Name" },
];

export function LeadsScreen({
  session,
  catalog,
  contactsVisible,
  initialFilters,
  first,
  initialLeadId = null,
}: Props) {
  const [filters, setFilters] = useState<ListFilters>(initialFilters);
  const [openId, setOpenId] = useState<string | null>(initialLeadId);
  const list = useLeadList(filters, first);
  const available = useMemo(() => availableColumns(catalog, contactsVisible), [catalog, contactsVisible]);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const mayCreate = can(session.actor, "leads.create");

  // The saved column choice lives in this browser, so it's read after mount (the server can't know it).
  useEffect(() => setChosen(loadColumnChoice(session.user.id)), [session.user.id]);
  const columns = resolveColumns(chosen, available);

  // The address bar mirrors the filters and the open lead, without a server round trip per keystroke.
  useEffect(() => {
    const p = filtersToParams(filters);
    if (openId) p.set("lead", openId);
    const qs = p.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (url !== window.location.pathname + window.location.search) window.history.replaceState(null, "", url);
  }, [filters, openId]);

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
              ? "It looks like you’re offline. Check your connection, then try again."
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
          action={mayCreate ? <Button variant="primary">New lead</Button> : undefined}
        />
      );
    return (
      <>
        <LeadsTable
          catalog={catalog}
          columns={columns}
          rows={list.rows}
          loading={list.loading}
          sort={filters.sort}
          onSort={(sort) => setFilters({ ...filters, sort })}
          openId={openId}
          onOpen={setOpenId}
        />
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
    <CatalogProvider catalog={catalog}>
      <section className={s.screen}>
        <div className={s.toolbar}>
          <FilterBar
            session={session}
            catalog={catalog}
            filters={filters}
            onChange={setFilters}
            contactsVisible={contactsVisible}
          />
          <div className={s.right}>
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
            <nav className={s.views} aria-label="View">
              <span aria-current="page">Table</span>
              <Link href={boardHref}>Board</Link>
            </nav>
            {mayCreate && <Button variant="primary">New lead</Button>}
          </div>
        </div>
        {body}
      </section>
    </CatalogProvider>
  );
}
