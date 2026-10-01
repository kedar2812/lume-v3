"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { scopeOf, type PhoneStatus } from "@lume/core/shared";
import { Popover } from "@/components/ui/Popover";
import { tokenColor } from "@/lib/leads/colors";
import {
  CREATED_DAYS,
  LOST_DAYS,
  NO_REPLY_DAYS,
  activeFilterCount,
  filterableFields,
  moreFilterCount,
  type ListFilters,
} from "@/lib/leads/filters";
import type { Catalog, FieldDefView } from "@/lib/leads/types";
import type { Session } from "@/server/session";
import s from "./leads.module.css";

const PHONE_LABEL: Record<PhoneStatus, string> = {
  valid: "Valid phone",
  needs_country: "Needs code",
  invalid: "Invalid phone",
  missing: "No phone",
};

const Caret = () => (
  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden className={s.caret}>
    <path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

/**
 * Narrowing the list. Every control is labelled; controls that can't apply to this person (owners for
 * someone who only sees their own leads, contact search for a masked role) simply aren't there.
 */
export function FilterBar({
  session,
  catalog,
  filters,
  onChange,
  contactsVisible,
  hideStage = false,
  trailing,
}: {
  session: Session;
  catalog: Catalog;
  filters: ListFilters;
  onChange: (f: ListFilters) => void;
  contactsVisible: boolean;
  hideStage?: boolean;
  /** At the end of the bar, after the chips it acts on (4B: Save view). */
  trailing?: ReactNode;
}) {
  const search = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<ListFilters>) => onChange({ ...filters, ...patch });
  const viewScope = scopeOf(session.actor, "leads.view");
  const pipeline =
    catalog.pipelines.find((p) => p.id === filters.pipelineId) ??
    catalog.pipelines.find((p) => p.isDefault) ??
    catalog.pipelines[0];
  const phoneVisible = catalog.fields.find((f) => f.key === "phone")?.access !== "hidden";
  const extra = filterableFields(catalog);
  const count = activeFilterCount(hideStage ? { ...filters, stageIds: [] } : filters);

  // "/" jumps to search from anywhere that isn't already a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key !== "/" || t.closest("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={s.filters} role="search">
      <label className={s.search}>
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
          <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={search}
          type="search"
          aria-label="Search leads"
          placeholder={contactsVisible ? "Search name, phone, email" : "Search by name"}
          maxLength={100}
          value={filters.q ?? ""}
          onChange={(e) => set({ q: e.target.value || undefined })}
        />
      </label>

      {!hideStage && pipeline && (
        <Popover
          label="Stage"
          triggerClassName={s.tool}
          active={filters.stageIds.length > 0}
          trigger={
            <>
              Stage{filters.stageIds.length ? ` · ${filters.stageIds.length}` : ""}
              <Caret />
            </>
          }
        >
          <ul className={s.pick}>
            {pipeline.stages.map((st) => (
              <li key={st.id} className={s.pickRow}>
                <label>
                  <input
                    type="checkbox"
                    checked={filters.stageIds.includes(st.id)}
                    onChange={(e) =>
                      set({
                        stageIds: e.target.checked
                          ? [...filters.stageIds, st.id]
                          : filters.stageIds.filter((x) => x !== st.id),
                      })
                    }
                  />
                  <i className={s.dot} style={{ background: tokenColor(st.color) }} aria-hidden />
                  {st.name}
                </label>
              </li>
            ))}
          </ul>
        </Popover>
      )}

      {viewScope && viewScope !== "own" && (
        <Select label="Owner" value={filters.owner ?? ""} onChange={(v) => set({ owner: v || undefined })}>
          <option value="">Any owner</option>
          <option value="me">My leads</option>
          {viewScope === "all" && <option value="none">Unassigned</option>}
          {catalog.people
            .filter((p) => p.active && p.id !== session.user.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </Select>
      )}

      {catalog.tags.length > 0 && (
        <Select label="Tag" value={filters.tagId ?? ""} onChange={(v) => set({ tagId: v || undefined })}>
          <option value="">Any tag</option>
          {catalog.tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </Select>
      )}

      {phoneVisible && (
        <Select
          label="Phone status"
          value={filters.phoneStatus ?? ""}
          onChange={(v) => set({ phoneStatus: (v || undefined) as PhoneStatus | undefined })}
        >
          <option value="">Any phone</option>
          {(Object.keys(PHONE_LABEL) as PhoneStatus[]).map((k) => (
            <option key={k} value={k}>
              {PHONE_LABEL[k]}
            </option>
          ))}
        </Select>
      )}

      <Popover
        label="Enquiry date"
        triggerClassName={s.tool}
        active={!!(filters.from || filters.to)}
        trigger={
          <>
            Date
            <Caret />
          </>
        }
      >
        <div className={s.dates}>
          <label>
            From
            <input
              type="date"
              value={filters.from ?? ""}
              max={filters.to}
              onChange={(e) => set({ from: e.target.value || undefined })}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={filters.to ?? ""}
              min={filters.from}
              onChange={(e) => set({ to: e.target.value || undefined })}
            />
          </label>
        </div>
      </Popover>

      <Popover
        label="More filters"
        size="form"
        triggerClassName={s.tool}
        active={moreFilterCount(filters) > 0}
        trigger={
          <>
            More filters{moreFilterCount(filters) ? ` · ${moreFilterCount(filters)}` : ""}
            <Caret />
          </>
        }
      >
        <div className={s.more}>
          {/* 4B: what's gone quiet — the filters saved views are made of. */}
          <p className={s.moreHead}>Follow-ups and replies</p>
          <label className={s.switchRow}>
            <span>Overdue follow-up</span>
            <input
              type="checkbox"
              role="switch"
              aria-label="Overdue follow-up"
              checked={!!filters.followUpOverdue}
              onChange={(e) => set({ followUpOverdue: e.target.checked || undefined })}
            />
          </label>
          <label>
            No reply for
            <select
              aria-label="No reply for"
              value={filters.noReplyDays ?? ""}
              onChange={(e) => set({ noReplyDays: Number(e.target.value) || undefined })}
            >
              <option value="">Any</option>
              {withCurrent(NO_REPLY_DAYS, filters.noReplyDays).map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? "1 day" : `${d} days`}
                </option>
              ))}
            </select>
          </label>
          <label>
            Lost
            <select
              aria-label="Lost"
              value={filters.lostDaysAgo ?? ""}
              onChange={(e) => {
                const d = Number(e.target.value) || undefined;
                set({ lostDaysAgo: d, ...(d ? {} : { lostReasonId: undefined }) });
              }}
            >
              <option value="">Any</option>
              {withCurrent(LOST_DAYS, filters.lostDaysAgo).map((d) => (
                <option key={d} value={d}>
                  {`${d}+ days ago`}
                </option>
              ))}
            </select>
          </label>
          {filters.lostDaysAgo && catalog.lostReasons.length > 0 && (
            <label>
              Reason
              <select
                aria-label="Reason"
                value={filters.lostReasonId ?? ""}
                onChange={(e) => set({ lostReasonId: e.target.value || undefined })}
              >
                <option value="">Any reason</option>
                {catalog.lostReasons.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Added
            <select
              aria-label="Added"
              value={filters.createdDays ?? ""}
              onChange={(e) => set({ createdDays: Number(e.target.value) || undefined })}
            >
              <option value="">Any time</option>
              {withCurrent(CREATED_DAYS, filters.createdDays).map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? "Today" : `Last ${d} days`}
                </option>
              ))}
            </select>
          </label>
          {extra.length > 0 && <p className={s.moreHead}>{"The business's fields"}</p>}
          {extra.map((def) => (
            <CustomFilter
              key={def.key}
              def={def}
              catalog={catalog}
              value={filters.custom?.[def.key]}
              onChange={(v) => {
                const next = { ...(filters.custom ?? {}) };
                if (v === undefined) delete next[def.key];
                else next[def.key] = v;
                set({ custom: Object.keys(next).length ? next : undefined });
              }}
            />
          ))}
        </div>
      </Popover>

      {quietChips(filters, catalog).map((c) => (
        <button
          key={c.label}
          type="button"
          className={s.sourceChip}
          aria-label={`Remove filter: ${c.label}`}
          onClick={() => set(c.clear)}
        >
          {c.label}
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      ))}

      {filters.source && (
        <button
          type="button"
          className={s.sourceChip}
          aria-label={`Remove filter: From ${catalog.sources.find((x) => x.id === filters.source)?.name ?? "an import"}`}
          onClick={() => set({ source: undefined })}
        >
          From {catalog.sources.find((x) => x.id === filters.source)?.name ?? "an import"}
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {filters.arrivedAfter && (
        <button
          type="button"
          className={s.sourceChip}
          aria-label="Remove filter: New since your last visit"
          onClick={() => set({ arrivedAfter: undefined })}
        >
          New since your last visit
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {count > 0 && (
        <button
          type="button"
          className={s.clear}
          aria-label="Clear all filters"
          onClick={() =>
            onChange({
              stageIds: hideStage ? filters.stageIds : [],
              sort: filters.sort,
              pipelineId: filters.pipelineId,
            })
          }
        >
          Clear · {count}
        </button>
      )}
      {trailing}
    </div>
  );
}

/** A menu's choices, with the value set now among them (a view or link may hold one the menu doesn't). */
const withCurrent = (choices: readonly number[], now: number | undefined) =>
  now && !choices.includes(now) ? [...choices, now].sort((a, b) => a - b) : [...choices];

/** Each of 4B's filters that's set, in words, with what removing it clears. */
function quietChips(f: ListFilters, cat: Catalog): { label: string; clear: Partial<ListFilters> }[] {
  const reason = cat.lostReasons.find((r) => r.id === f.lostReasonId)?.label;
  return [
    ...(f.noReplyDays
      ? [
          {
            label: `No reply ${f.noReplyDays}+ day${f.noReplyDays === 1 ? "" : "s"}`,
            clear: { noReplyDays: undefined },
          },
        ]
      : []),
    ...(f.lostDaysAgo
      ? [
          {
            label: `Lost ${f.lostDaysAgo}+ days ago${reason ? ` · ${reason}` : ""}`,
            clear: { lostDaysAgo: undefined, lostReasonId: undefined },
          },
        ]
      : reason
        ? // A reason on its own (a link, a view): its chip, which takes it off.
          [{ label: `Lost · ${reason}`, clear: { lostReasonId: undefined } }]
        : []),
    ...(f.followUpOverdue ? [{ label: "Overdue follow-up", clear: { followUpOverdue: undefined } }] : []),
    ...(f.createdDays
      ? [
          {
            label: f.createdDays === 1 ? "Added today" : `Added in the last ${f.createdDays} days`,
            clear: { createdDays: undefined },
          },
        ]
      : []),
  ];
}

function Select({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <label className={s.select} data-active={value ? true : undefined}>
      <span className={s.srOnly}>{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
      <Caret />
    </label>
  );
}

function CustomFilter({
  def,
  catalog,
  value,
  onChange,
}: {
  def: FieldDefView;
  catalog: Catalog;
  value: string | boolean | undefined;
  onChange: (v: string | boolean | undefined) => void;
}) {
  const current = value === undefined ? "" : String(value);
  const pick = (v: string) => onChange(v === "" ? undefined : def.type === "boolean" ? v === "true" : v);
  return (
    <label>
      {def.label}
      <select aria-label={def.label} value={current} onChange={(e) => pick(e.target.value)}>
        <option value="">Any</option>
        {def.type === "boolean" ? (
          <>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </>
        ) : def.type === "user" ? (
          catalog.people
            .filter((p) => p.active)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))
        ) : (
          def.options
            .filter((o) => !o.archived)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))
        )}
      </select>
    </label>
  );
}
