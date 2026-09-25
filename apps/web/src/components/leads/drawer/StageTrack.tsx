"use client";
import { tokenColor } from "@/lib/leads/colors";
import { formatMoney } from "@/lib/leads/format";
import type { Catalog, Lead, Stage } from "@/lib/leads/types";
import s from "./drawer.module.css";

const DAY = 86_400_000;

/** "In Call booked for 3 days", "Won · AED 4,500", "Lost · Price". */
function trackNote(lead: Lead, stage: Stage | undefined, catalog: Catalog): string {
  if (!stage) return "";
  if (stage.kind === "won")
    return `Won${lead.value ? ` · ${formatMoney(lead.value, catalog.currency)}` : ""}`;
  if (stage.kind === "lost") {
    const reason = catalog.lostReasons.find((r) => r.id === lead.lostReasonId)?.label;
    return `Lost${reason ? ` · ${reason}` : ""}`;
  }
  const days = lead.stageEnteredAt
    ? Math.floor((Date.now() - new Date(lead.stageEnteredAt).getTime()) / DAY)
    : 0;
  return `In ${stage.name} ${days <= 0 ? "since today" : `for ${days} ${days === 1 ? "day" : "days"}`}`;
}

/**
 * The approved stage track: one segment per open stage, filled up to where the lead is. Clicking a
 * segment moves the lead there (through the same rules as everywhere else).
 */
export function StageTrack({
  lead,
  catalog,
  canMove,
  onMove,
}: {
  lead: Lead;
  catalog: Catalog;
  canMove: boolean;
  onMove: (stage: Stage) => void;
}) {
  const pipeline = catalog.pipelines.find((p) => p.id === lead.pipelineId);
  if (!pipeline) return null;
  const current = pipeline.stages.find((st) => st.id === lead.stageId);
  const open = pipeline.stages.filter((st) => st.kind === "open");
  const reached = current?.kind === "open" ? current.position : Infinity;
  const won = current?.kind === "won";
  const lost = current?.kind === "lost";

  return (
    <div className={s.trackWrap}>
      <div className={s.track} data-lost={lost || undefined}>
        {open.map((st) => {
          const done = won || lost || st.position <= reached;
          const isCurrent = st.id === current?.id;
          return (
            <button
              key={st.id}
              type="button"
              className={s.tk}
              data-done={done || undefined}
              aria-current={isCurrent ? "step" : undefined}
              disabled={!canMove || isCurrent}
              style={{ ["--c" as string]: won ? "var(--ok)" : tokenColor(st.color) }}
              onClick={() => onMove(st)}
            >
              <span className={s.bar}>
                <i />
              </span>
              <span className={s.lb}>{st.name}</span>
            </button>
          );
        })}
      </div>
      <p className={s.trackNote} data-tone={won ? "ok" : lost ? "danger" : undefined} data-volatile>
        {trackNote(lead, current, catalog)}
      </p>
    </div>
  );
}
