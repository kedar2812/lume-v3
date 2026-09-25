"use client";
import { Avatar } from "@/components/ui/Avatar";
import { tokenColor } from "@/lib/leads/colors";
import { formatMoney, personName, relativeTime, shortDate, stageOf } from "@/lib/leads/format";
import type { Catalog, ContactView, Lead } from "@/lib/leads/types";
import s from "./leads.module.css";

/** The stage as a pill: its colour dot and name (the prototype's `.stg`). */
export function StagePill({ catalog, stageId }: { catalog: Catalog; stageId: string | undefined }) {
  const stage = stageOf(catalog, stageId);
  if (!stage) return <span className={s.muted}>—</span>;
  return (
    <span className={s.stage}>
      <i style={{ background: tokenColor(stage.color) }} aria-hidden />
      {stage.name}
    </span>
  );
}

export function OwnerCell({ catalog, ownerId }: { catalog: Catalog; ownerId: string | null | undefined }) {
  if (!ownerId) return <span className={s.muted}>Unassigned</span>;
  const name = personName(catalog, ownerId);
  return (
    <span className={s.owner}>
      <Avatar name={name} size={22} />
      <span>{name}</span>
    </span>
  );
}

export function ContactCell({ value }: { value: ContactView | null | undefined }) {
  if (!value) return <span className={s.muted}>—</span>;
  return (
    <span className={s.contact} title={value.masked ? "Masked for your role" : undefined}>
      {value.display}
      {value.masked && (
        <svg viewBox="0 0 12 12" width="11" height="11" aria-label="masked" role="img" className={s.lock}>
          <rect x="2.5" y="5.5" width="7" height="5" rx="1.2" fill="currentColor" />
          <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )}
    </span>
  );
}

export function TagsCell({ catalog, tagIds }: { catalog: Catalog; tagIds: string[] }) {
  const tags = tagIds.map((id) => catalog.tags.find((t) => t.id === id)).filter((t) => !!t);
  if (!tags.length) return <span className={s.muted}>—</span>;
  return (
    <span className={s.tags}>
      {tags.slice(0, 2).map((t) => (
        <span key={t.id} className={s.tag}>
          <i style={{ background: tokenColor(t.color) }} aria-hidden />
          {t.label}
        </span>
      ))}
      {tags.length > 2 && <span className={s.moreTags}>+{tags.length - 2}</span>}
    </span>
  );
}

export const ValueCell = ({ lead, catalog }: { lead: Lead; catalog: Catalog }) =>
  lead.value === null || lead.value === undefined ? (
    <span className={s.muted}>—</span>
  ) : (
    <span className={s.num}>{formatMoney(lead.value, lead.currency ?? catalog.currency)}</span>
  );

/** "3h ago" and the like. Marked volatile: it changes with the clock, so screenshots mask it. */
export function WhenCell({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className={s.muted}>—</span>;
  return (
    <time dateTime={iso} title={new Date(iso).toUTCString()} data-volatile className={s.when}>
      {relativeTime(iso)}
    </time>
  );
}

export const DateCell = ({ iso }: { iso: string | null | undefined }) =>
  iso ? (
    <span className={s.when}>{shortDate(new Date(`${iso.slice(0, 10)}T00:00:00Z`), true)}</span>
  ) : (
    <span className={s.muted}>—</span>
  );
