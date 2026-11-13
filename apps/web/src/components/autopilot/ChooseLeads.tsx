"use client";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { leadsClient } from "@/lib/leads/client";
import { EMPTY_FILTERS, type ListFilters } from "@/lib/leads/filters";
import type { Lead } from "@/lib/leads/types";
import s from "./choose.module.css";

type Show = "noreply" | "new" | "all";
const SHOWS: { value: Show; label: string; filters: Partial<ListFilters> }[] = [
  { value: "noreply", label: "No reply 3+ days", filters: { noReplyDays: 3 } },
  { value: "new", label: "New today", filters: { createdDays: 1 } },
  { value: "all", label: "All leads", filters: {} },
];
/** At most a page of matches; a narrower search finds the rest. */
export const CHOOSE_PAGE = 100;
/** Typing settles this long before LUME looks. */
const SETTLE_MS = 250;
const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * New run's first step (owner, 2026-11-01: no trip to Leads): choose the leads here, searched by name or number, from
 * those waiting on a reply, today's, or all; what's ticked stays ticked across searches. Continue hands them to the
 * start sheet.
 */
export function ChooseLeads({
  onClose,
  onContinue,
}: {
  onClose(): void;
  onContinue(leadIds: string[]): void;
}) {
  const [show, setShow] = useState<Show>("noreply");
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Map<string, string>>(new Map());
  const filters = useMemo(() => SHOWS.find((x) => x.value === show)!.filters, [show]);

  useEffect(() => {
    const t = setTimeout(() => setAsked(query.trim()), SETTLE_MS);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    let live = true;
    setLeads(null);
    void leadsClient
      .list({ ...EMPTY_FILTERS, ...filters, ...(asked ? { q: asked } : {}) }, undefined, CHOOSE_PAGE)
      .then((r) => {
        if (!live) return;
        if (!r.ok) return setProblem(r.message);
        setProblem(null);
        setLeads(r.data.items);
        setMore(!!r.data.nextCursor);
      });
    return () => {
      live = false;
    };
  }, [filters, asked]);

  const toggle = (l: Lead) =>
    setChosen((m) => {
      const next = new Map(m);
      if (next.has(l.id)) next.delete(l.id);
      else next.set(l.id, l.name ?? "Lead");
      return next;
    });
  const shown = leads ?? [];
  const allShown = shown.length > 0 && shown.every((l) => chosen.has(l.id));
  const toggleAll = () =>
    setChosen((m) => {
      const next = new Map(m);
      for (const l of shown) {
        if (allShown) next.delete(l.id);
        else next.set(l.id, l.name ?? "Lead");
      }
      return next;
    });
  const n = chosen.size;

  const footer = (
    <div className={s.foot}>
      <span className={s.count} aria-live="polite">
        {n ? `${fmt(n)} chosen` : "Tick the leads LUME AI should follow up"}
      </span>
      <Button variant="primary" disabled={!n} onClick={() => onContinue([...chosen.keys()])}>
        {n ? `Continue with ${fmt(n)}` : "Continue"}
      </Button>
    </div>
  );

  return (
    <Sheet label="Choose leads for LUME AI" onClose={onClose} footer={footer}>
      <header className={s.head}>
        <h2 className={s.title}>Choose leads for LUME AI</h2>
        <p className={s.lede}>
          LUME AI follows them up on WhatsApp and hands them to you when they&apos;re ready.
        </p>
      </header>
      <div className={s.tools}>
        <label className={s.search}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            aria-label="Search leads"
            placeholder="Search by name or number"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </label>
        <SegmentedControl
          label="Show"
          value={show}
          options={SHOWS.map((x) => ({ value: x.value, label: x.label }))}
          onChange={setShow}
        />
      </div>
      {problem ? (
        <p role="alert" className={s.problem}>
          {problem}
        </p>
      ) : !leads ? (
        <div className={s.loading} role="status" aria-busy aria-label="Getting the leads">
          <Skeleton height={44} radius={10} />
          <Skeleton height={44} radius={10} />
          <Skeleton height={44} radius={10} />
        </div>
      ) : leads.length === 0 ? (
        <p className={s.none}>{asked ? `No lead matches “${asked}” here.` : "No leads here."}</p>
      ) : (
        <>
          <label className={s.all}>
            <input type="checkbox" checked={allShown} onChange={toggleAll} />
            <span>
              {allShown ? "Untick" : "Tick"} all {fmt(shown.length)}
              {more ? " shown" : ""}
            </span>
          </label>
          <ul className={s.rows} aria-label="Leads to choose from">
            {shown.map((l) => (
              <li key={l.id}>
                <label className={s.row}>
                  <input type="checkbox" checked={chosen.has(l.id)} onChange={() => toggle(l)} />
                  <span className={s.name}>{l.name ?? "Unnamed lead"}</span>
                </label>
              </li>
            ))}
          </ul>
          {more && (
            <p className={s.more}>Showing the first {fmt(CHOOSE_PAGE)}. Search to find anyone else.</p>
          )}
        </>
      )}
    </Sheet>
  );
}
