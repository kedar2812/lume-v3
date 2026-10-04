"use client";
import { useRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { ScrollRail } from "@/components/ui/ScrollRail";
import { Avatar } from "@/components/ui/Avatar";
import { Skeleton } from "@/components/ui/Skeleton";
import type { ColumnDef } from "@/lib/leads/columns";
import type { Sort } from "@/lib/leads/filters";
import { fieldText } from "@/lib/leads/format";
import type { Catalog, ContactView, Lead } from "@/lib/leads/types";
import { ContactCell, DateCell, OwnerCell, StagePill, TagsCell, ValueCell, WhenCell } from "./cells";
import s from "./leads.module.css";

type Props = {
  catalog: Catalog;
  columns: ColumnDef[];
  rows: Lead[];
  loading: boolean;
  /** A refetch that has run a while: the old rows give way to skeletons (7C). */
  stale?: boolean;
  /** The next page is on its way: skeleton rows wait under the loaded ones (7C). */
  appending?: boolean;
  sort: Sort;
  onSort: (sort: Sort) => void;
  openId: string | null;
  onOpen: (id: string) => void;
  /** Renders a cell's contents; lets the screen swap in inline editors (Task 4) and selection (Task 8). */
  renderCell?: (lead: Lead, col: ColumnDef, fallback: ReactNode) => ReactNode;
  /** Leads that just arrived (2B §8.3): each glows, staggered by its index. */
  glowing?: Map<string, number>;
  /** A leading checkbox column for bulk selection (Task 8). */
  selection?: { header: ReactNode; cell: (lead: Lead) => ReactNode };
};

/** The value a cell shows, before any editing is layered on. */
export function cellContent(lead: Lead, col: ColumnDef, catalog: Catalog): ReactNode {
  switch (col.id) {
    case "name":
      return lead.name ?? "—";
    case "stage":
      return <StagePill catalog={catalog} stageId={lead.stageId} />;
    case "owner":
      return <OwnerCell catalog={catalog} ownerId={lead.ownerId} />;
    case "phone":
    case "email":
    case "instagram":
      return <ContactCell value={lead[col.id] as ContactView | null | undefined} />;
    case "value":
      return <ValueCell lead={lead} catalog={catalog} />;
    case "tags":
      return <TagsCell catalog={catalog} tagIds={lead.tagIds} />;
    case "created":
      return <DateCell iso={lead.leadCreatedAt ?? lead.createdAt} />;
    case "updated":
      return <WhenCell iso={lead.lastActivityAt ?? lead.updatedAt} />;
    default: {
      const def = catalog.fields.find((f) => f.key === col.fieldKey);
      const text = def ? fieldText(lead.custom[def.key], def, catalog) : "";
      return text || <span className={s.muted}>—</span>;
    }
  }
}

const SORT_NEXT: Record<"name" | "updated", Sort> = { name: "name", updated: "updated" };

export function LeadsTable({
  catalog,
  columns,
  rows,
  loading,
  stale = false,
  appending = false,
  sort,
  onSort,
  openId,
  onOpen,
  renderCell,
  selection,
  glowing,
}: Props) {
  const skeleton = (loading && rows.length === 0) || stale;
  const skeletonRow = (key: number) => (
    <tr key={`sk${key}`} className={s.row} aria-hidden data-skeleton>
      {selection && <td />}
      {columns.map((c) => (
        <td key={c.id}>
          <Skeleton width={c.id === "name" ? "70%" : "55%"} height={10} />
        </td>
      ))}
    </tr>
  );
  const wrap = useRef<HTMLDivElement>(null);
  // A click anywhere on the row opens it, unless it landed on something interactive inside the row.
  const rowClick = (e: MouseEvent, id: string) => {
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, label")) return;
    onOpen(id);
  };

  return (
    <>
      {/* With more columns than fit, the table scrolls across: its rail sits on top, where it can be reached
        without going to the bottom of thousands of rows. */}
      <ScrollRail target={wrap} label="Scroll across the columns" className={s.tableRail} />
      <div className={s.tableWrap} data-scroll ref={wrap}>
        <table className={s.table} aria-busy={loading || undefined} aria-rowcount={rows.length || undefined}>
          <colgroup>
            {selection && <col style={{ width: 44 }} />}
            {columns.map((c) => (
              <col key={c.id} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {selection && (
                <th scope="col" className={s.check}>
                  {selection.header}
                </th>
              )}
              {columns.map((c) => {
                const sorted = c.sortable && sort === SORT_NEXT[c.sortable];
                return (
                  <th
                    key={c.id}
                    scope="col"
                    data-align={c.align}
                    className={c.id === "name" ? s.sticky : undefined}
                    aria-sort={sorted ? (c.sortable === "name" ? "ascending" : "descending") : undefined}
                  >
                    {c.sortable ? (
                      <button
                        type="button"
                        className={s.sortBtn}
                        onClick={() => onSort(SORT_NEXT[c.sortable!])}
                      >
                        {c.label}
                        {sorted && <span aria-hidden>{c.sortable === "name" ? " ↑" : " ↓"}</span>}
                      </button>
                    ) : (
                      c.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className={s.body} data-dim={loading && !appending && !skeleton ? true : undefined}>
            {skeleton
              ? Array.from({ length: 8 }, (_, i) => skeletonRow(i))
              : rows.map((l) => (
                  <tr
                    key={l.id}
                    className={s.row}
                    data-testid="lead-row"
                    data-lead-id={l.id}
                    data-open={l.id === openId || undefined}
                    data-arrived={glowing?.has(l.id) || undefined}
                    style={
                      glowing?.has(l.id)
                        ? ({ ["--d" as string]: `${glowing.get(l.id)! * 70}ms` } as CSSProperties)
                        : undefined
                    }
                    onClick={(e) => rowClick(e, l.id)}
                  >
                    {selection && <td className={s.check}>{selection.cell(l)}</td>}
                    {columns.map((c) => {
                      const content =
                        c.id === "name" ? (
                          <button
                            type="button"
                            className={s.open}
                            aria-label={`Open ${l.name ?? "lead"}`}
                            onClick={() => onOpen(l.id)}
                          >
                            <Avatar name={l.name ?? "?"} size={26} />
                            <span>{l.name ?? "—"}</span>
                            {glowing?.has(l.id) && (
                              <span className={s.newTag} aria-hidden>
                                NEW
                              </span>
                            )}
                          </button>
                        ) : (
                          cellContent(l, c, catalog)
                        );
                      return (
                        <td
                          key={c.id}
                          data-align={c.align}
                          className={c.id === "name" ? s.sticky : undefined}
                        >
                          {renderCell ? renderCell(l, c, content) : content}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            {appending && !skeleton && [0, 1, 2].map(skeletonRow)}
          </tbody>
        </table>
      </div>
    </>
  );
}
