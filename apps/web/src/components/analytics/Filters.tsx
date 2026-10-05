"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { analyticsClient } from "@/lib/analytics/client";
import { tokenColor } from "@/lib/leads/colors";
import type { Catalog } from "@/lib/leads/types";
import s from "./filters.module.css";

/** What narrows every board (8D-3 Filters artboard): kept in the address, so a link opens the same view. */
export type AnalyticsFilters = {
  pipeline?: string;
  owners?: string[];
  team?: string;
  sources?: string[];
  tags?: string[];
  fields?: Record<string, string[]>;
};
export const filterCount = (f: AnalyticsFilters) =>
  [
    f.pipeline,
    f.owners?.length || f.team,
    f.sources?.length,
    f.tags?.length,
    Object.keys(f.fields ?? {}).length,
  ].filter(Boolean).length;
const LIVE_DAYS = 92;

/** A list in words: "Riya and Dev", "Riya, Dev and 2 more". */
function listWords(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}
const toggle = (xs: string[] | undefined, x: string) =>
  xs?.includes(x) ? xs.filter((y) => y !== x) : [...(xs ?? []), x];

const Icon = () => (
  <svg viewBox="0 0 24 24" aria-hidden>
    <path d="M3 6h18M7 12h10M10 18h4" />
  </svg>
);

/**
 * Filters (the approved artboard): a glass panel from the Filters button, no scrim, every change counted at once.
 * Pipeline, people or a team, sources; tags and fields are counted from each lead ("counted live"), so they cover up to
 * 92 days. The footer says how much of the range the numbers now cover. Esc or a click away closes it.
 */
export function FiltersButton({
  filters,
  catalog,
  rangeDays,
  coverage,
  onChange,
}: {
  filters: AnalyticsFilters;
  catalog: Catalog;
  rangeDays: number;
  /** New leads under these filters, and without them, in the range: "These numbers cover 690 of 4,180 leads". */
  coverage: { shown: number | null; all: number | null };
  onChange(next: AnalyticsFilters): void;
}) {
  const reduce = !!useReducedMotion();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"people" | "teams">(filters.team ? "teams" : "people");
  const [find, setFind] = useState("");
  const [teams, setTeams] = useState<{ id: string; name: string; memberIds: string[] }[] | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const n = filterCount(filters);

  useEffect(() => {
    if (!open) return;
    if (teams === null) void analyticsClient.teams().then((r) => setTeams(r.ok ? r.data.teams : []));
    const away = (e: PointerEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, teams]);

  const teamOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of teams ?? []) for (const id of t.memberIds) if (!m.has(id)) m.set(id, t.name);
    return m;
  }, [teams]);
  const people = catalog.people.filter(
    (p) => p.active && p.name.toLowerCase().includes(find.trim().toLowerCase()),
  );
  const choiceFields = catalog.fields.filter(
    (f) => !f.archived && (f.type === "select" || f.type === "multi_select"),
  );
  const live = !!filters.tags?.length || Object.keys(filters.fields ?? {}).length > 0;
  const tooLong = live && rangeDays > LIVE_DAYS;
  const set = (patch: Partial<AnalyticsFilters>) => {
    const next: AnalyticsFilters = { ...filters, ...patch };
    for (const k of Object.keys(next) as (keyof AnalyticsFilters)[]) {
      const v = next[k];
      if (
        v === undefined ||
        (Array.isArray(v) && !v.length) ||
        (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)
      )
        delete next[k];
    }
    onChange(next);
  };

  return (
    <div className={s.wrap} ref={wrap}>
      <button
        type="button"
        className={s.button}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-on={n > 0 || undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon />
        Filters
        <span className={s.n} aria-label={`${n} on`}>
          {n}
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className={s.panel}
            role="dialog"
            aria-label="Filters"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -6, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4, filter: "blur(4px)" }}
            transition={reduce ? { duration: 0.15 } : { type: "spring", bounce: 0.15, duration: 0.5 }}
          >
            <div className={s.head}>
              <h2>Filters</h2>
              {n > 0 && (
                <button type="button" className={s.clear} onClick={() => onChange({})}>
                  Clear all
                </button>
              )}
            </div>
            <div className={s.body}>
              {catalog.pipelines.length > 1 && (
                <section className={s.sec}>
                  <h3>Pipeline</h3>
                  <SegmentedControl
                    label="Pipeline"
                    value={
                      filters.pipeline ??
                      catalog.pipelines.find((p) => p.isDefault)?.id ??
                      catalog.pipelines[0]!.id
                    }
                    options={catalog.pipelines.map((p) => ({ value: p.id, label: p.name }))}
                    onChange={(v) => set({ pipeline: v })}
                  />
                </section>
              )}
              <section className={s.sec}>
                <h3>
                  People <span>Whose leads, credited as Analytics credits them</span>
                </h3>
                {!!teams?.length && (
                  <SegmentedControl
                    label="People or teams"
                    value={mode}
                    options={[
                      { value: "people", label: "People" },
                      { value: "teams", label: "Teams" },
                    ]}
                    onChange={(v) => setMode(v as "people" | "teams")}
                  />
                )}
                {mode === "people" || !teams?.length ? (
                  <>
                    {catalog.people.length > 6 && (
                      <input
                        className={s.find}
                        type="search"
                        placeholder="Find a person"
                        aria-label="Find a person"
                        value={find}
                        onChange={(e) => setFind(e.target.value)}
                      />
                    )}
                    <ul className={s.people}>
                      {people.map((p) => (
                        <li key={p.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={!!filters.owners?.includes(p.id)}
                              onChange={() => set({ owners: toggle(filters.owners, p.id), team: undefined })}
                            />
                            <Avatar
                              name={p.name}
                              size={22}
                              {...(p.avatar?.color ? { color: p.avatar.color } : {})}
                            />
                            <span className={s.who}>{p.name}</span>
                            <span className={s.team}>{teamOf.get(p.id) ?? ""}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <ul className={s.people}>
                    {teams.map((t) => (
                      <li key={t.id}>
                        <label>
                          <input
                            type="radio"
                            name="analytics-team"
                            checked={filters.team === t.id}
                            onChange={() => set({ team: t.id, owners: undefined })}
                          />
                          <span className={s.who}>{t.name}</span>
                          <span className={s.team}>
                            {t.memberIds.length} {t.memberIds.length === 1 ? "person" : "people"}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {catalog.sources.length > 0 && (
                <section className={s.sec}>
                  <h3>Source</h3>
                  <div className={s.chips}>
                    {catalog.sources.map((x, i) => (
                      <button
                        key={x.id}
                        type="button"
                        aria-pressed={!!filters.sources?.includes(x.id)}
                        onClick={() => set({ sources: toggle(filters.sources, x.id) })}
                      >
                        <i style={{ background: CHIP_DOTS[i % CHIP_DOTS.length] }} />
                        {x.name}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {catalog.tags.length > 0 && (
                <section className={s.sec}>
                  <h3>
                    Tags <em>Counted live</em>
                  </h3>
                  <div className={s.chips}>
                    {catalog.tags.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        aria-pressed={!!filters.tags?.includes(t.id)}
                        onClick={() => set({ tags: toggle(filters.tags, t.id) })}
                      >
                        <i style={{ background: tokenColor(t.color) }} />
                        {t.label}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {choiceFields.length > 0 && (
                <section className={s.sec}>
                  <h3>
                    Fields <em>Counted live</em>
                  </h3>
                  {choiceFields.map((f) => (
                    <div key={f.id} className={s.field}>
                      <span>{f.label}</span>
                      <div className={s.chips}>
                        {f.options
                          .filter((o) => !o.archived)
                          .map((o) => (
                            <button
                              key={o.id}
                              type="button"
                              aria-pressed={!!filters.fields?.[f.key]?.includes(o.id)}
                              onClick={() =>
                                set({
                                  fields: {
                                    ...filters.fields,
                                    [f.key]: toggle(filters.fields?.[f.key], o.id),
                                  },
                                })
                              }
                            >
                              {o.label}
                            </button>
                          ))}
                      </div>
                    </div>
                  ))}
                </section>
              )}
              {live && (
                <p className={s.liveNote} data-warn={tooLong || undefined}>
                  {tooLong
                    ? "Tags and fields are counted from each lead, for up to 92 days. Pick a shorter range to see these numbers."
                    : "Tags and fields are counted from each lead, so they cover up to 92 days."}
                </p>
              )}
            </div>
            <div className={s.foot}>
              <span>
                {coverage.shown !== null && coverage.all !== null && n > 0 ? (
                  <>
                    These numbers cover <b>{coverage.shown.toLocaleString("en-US")}</b> of{" "}
                    {coverage.all.toLocaleString("en-US")} leads
                  </>
                ) : (
                  "Every lead in the range"
                )}
              </span>
              <button type="button" className={s.done} onClick={() => setOpen(false)}>
                Done
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
const CHIP_DOTS = ["#2a5bff", "#5ab8ff", "#18a566", "#f2a20c", "#e5484d", "#8a94a6"];

/** The "Showing" bar under the analytics bar: each filter in words, each one off with ×, and Clear. */
export function FilterChips({
  filters,
  catalog,
  teamName,
  onChange,
}: {
  filters: AnalyticsFilters;
  catalog: Catalog;
  teamName: string | null;
  onChange(next: AnalyticsFilters): void;
}) {
  if (!filterCount(filters)) return null;
  const name = (id: string) => catalog.people.find((p) => p.id === id)?.name.split(" ")[0] ?? "Someone";
  const chips: { key: string; k: string; v: string; live?: boolean; drop: AnalyticsFilters }[] = [];
  const without = (k: keyof AnalyticsFilters) => {
    const x = { ...filters };
    delete x[k];
    return x;
  };
  if (filters.pipeline)
    chips.push({
      key: "pipeline",
      k: "Pipeline",
      v: catalog.pipelines.find((p) => p.id === filters.pipeline)?.name ?? "—",
      drop: without("pipeline"),
    });
  if (filters.owners?.length)
    chips.push({
      key: "owners",
      k: "People",
      v: listWords(filters.owners.map(name)),
      drop: without("owners"),
    });
  if (filters.team) chips.push({ key: "team", k: "Team", v: teamName ?? "A team", drop: without("team") });
  if (filters.sources?.length)
    chips.push({
      key: "sources",
      k: "Source",
      v: listWords(filters.sources.map((id) => catalog.sources.find((x) => x.id === id)?.name ?? "A source")),
      drop: without("sources"),
    });
  if (filters.tags?.length)
    chips.push({
      key: "tags",
      k: "Tags",
      v: listWords(filters.tags.map((id) => catalog.tags.find((t) => t.id === id)?.label ?? "A tag")),
      live: true,
      drop: without("tags"),
    });
  for (const [key, ids] of Object.entries(filters.fields ?? {})) {
    const f = catalog.fields.find((x) => x.key === key);
    const fields = { ...filters.fields };
    delete fields[key];
    chips.push({
      key: `field-${key}`,
      k: f?.label ?? key,
      v: listWords(ids.map((id) => f?.options.find((o) => o.id === id)?.label ?? id)),
      live: true,
      drop: { ...filters, ...(Object.keys(fields).length ? { fields } : { fields: undefined }) },
    });
  }
  return (
    <div className={s.bar} role="group" aria-label="Filters on">
      <span className={s.showing}>Showing</span>
      {chips.map((c) => (
        <span key={c.key} className={s.chip}>
          {c.k} <b>{c.v}</b>
          {c.live && <em>Live</em>}
          <button type="button" aria-label={`Remove ${c.k}`} onClick={() => onChange(c.drop)}>
            ×
          </button>
        </span>
      ))}
      <button type="button" className={s.clear} onClick={() => onChange({})}>
        Clear
      </button>
    </div>
  );
}
