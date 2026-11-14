"use client";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { tokenColor } from "@/lib/leads/colors";
import { formatMoney } from "@/lib/leads/format";
import type { LeadPage, Stage } from "@/lib/leads/types";
import s from "./board.module.css";

export const columnLabel = (stage: Stage, count: number) =>
  `${stage.name}, ${count} ${count === 1 ? "lead" : "leads"}`;

/** One stage: its colour, name and count, the cards, and more on request. */
export function BoardColumn({
  stage,
  page,
  count,
  total,
  currency,
  over,
  loadingMore,
  onMore,
  action,
  children,
}: {
  stage: Stage;
  page: LeadPage;
  count: number;
  /** The summed deal value of every lead in the stage (from the server), shown for a won stage. */
  total: number | null;
  currency: string;
  /** A card is being dragged (or keyboard-moved) over this column. */
  over: boolean;
  loadingMore: boolean;
  onMore: () => void;
  /** Something to do with the stage itself (a live sheet of it, 2026-11-14), at the end of its header. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      role="region"
      aria-label={columnLabel(stage, count)}
      data-stage-id={stage.id}
      data-over={over || undefined}
      className={s.column}
      style={{ ["--c" as string]: tokenColor(stage.color) }}
    >
      <header className={s.columnHead}>
        <i className={s.dot} aria-hidden />
        <span className={s.columnName} aria-hidden>
          {stage.name}
        </span>
        <b className={s.count} aria-hidden>
          {count}
        </b>
        {total ? (
          <span className={s.total} aria-hidden>
            {formatMoney(total, currency)}
          </span>
        ) : null}
        {action}
      </header>
      <div className={s.cards}>
        {children}
        {page.items.length === 0 && <p className={s.emptyColumn}>No leads</p>}
        {page.nextCursor && (
          <Button size="sm" variant="ghost" className={s.more} loading={loadingMore} onClick={onMore}>
            Show more
          </Button>
        )}
      </div>
    </section>
  );
}
