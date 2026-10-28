"use client";
import { AUTOPILOT_ACTION_TITLES, firstNameOf, type AutopilotAction } from "@lume/core/shared";
import { AnimatePresence } from "motion/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { autopilotClient } from "@/lib/autopilot/client";
import type { AutopilotSetup, StartResult } from "@/lib/autopilot/types";
import { leadsClient } from "@/lib/leads/client";
import { EMPTY_FILTERS, type ListFilters } from "@/lib/leads/filters";
import type { Lead } from "@/lib/leads/types";
import { pipelinesClient } from "@/lib/settings/pipelines";
import { whatsappClient } from "@/lib/whatsapp/client";
import { StartSheet } from "./StartSheet";
import w from "./waiting.module.css";

type Show = "noreply" | "new" | "all";
const fmt = (n: number) => n.toLocaleString("en-US");
const SHOWS: {
  value: Show;
  label: string;
  filters: Partial<ListFilters>;
  title(n: string, one: boolean): string;
}[] = [
  {
    value: "noreply",
    label: "No reply 3+ days",
    filters: { noReplyDays: 3 },
    title: (n, one) => `${n} ${one ? "lead hasn't" : "leads haven't"} heard from you in 3 days or more`,
  },
  {
    value: "new",
    label: "New today",
    filters: { createdDays: 1 },
    title: (n, one) => `${n} ${one ? "lead" : "leads"} came in today`,
  },
  { value: "all", label: "All leads", filters: {}, title: (n, one) => `${n} ${one ? "lead" : "leads"}` },
];
/** The choices a person meets first, in the start sheet's order (the rest are a tap away in it). */
const SHOWN_CHOICES: AutopilotAction[] = [
  "first_messages",
  "replies",
  "answer_prices",
  "book_meetings",
  "mark_lost",
];
const ALLOW_WORDS = { go: "Go ahead", ask: "Ask me", never: "Never" } as const;
/** Rows shown before "N more". */
const ROWS = 8;
/** A run started from here takes at most a page of leads; a bigger one starts from Leads. */
const PAGE = 100;

/** "Today", "Yesterday", "5 days ago": when the lead was last heard from, or last messaged. */
function heard(l: Lead, now: Date): string {
  const at = l.lastReplyAt ?? l.lastMessageAt ?? l.createdAt;
  const days = Math.floor((now.getTime() - new Date(at).getTime()) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : `${fmt(days)} days ago`;
}

/**
 * LUME AI's first visit (plan 2026-10-28, artboard 4): the work that's waiting, never a pitch. Which leads (No reply 3+
 * days, New today, All), the first of them with their stage and when they were last heard from, each ticked and
 * untickable; a first message filled in for the first of them; what LUME AI may do, as the business set it; and one
 * button that opens the start sheet with exactly those leads. When LUME AI can't start yet it says why, with the fix.
 */
export function WaitingWork({ canStart, onStarted }: { canStart: boolean; onStarted(r: StartResult): void }) {
  const [show, setShow] = useState<Show>("noreply");
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [left, setLeft] = useState<Set<string>>(new Set());
  const [stages, setStages] = useState<Map<string, string>>(new Map());
  const [setup, setSetup] = useState<AutopilotSetup | null>(null);
  const [preview, setPreview] = useState<{ who: string; text: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const now = useMemo(() => new Date(), []);
  const choice = SHOWS.find((x) => x.value === show)!;

  useEffect(() => {
    void pipelinesClient.list().then((r) => {
      if (r.ok) setStages(new Map(r.data.pipelines.flatMap((p) => p.stages.map((st) => [st.id, st.name]))));
    });
    void autopilotClient.setup().then((r) => r.ok && setSetup(r.data));
  }, []);
  useEffect(() => {
    let live = true;
    setLeads(null);
    setLeft(new Set());
    void leadsClient.list({ ...EMPTY_FILTERS, ...choice.filters }, undefined, PAGE).then((r) => {
      if (!live) return;
      if (!r.ok) return setProblem(r.message);
      setProblem(null);
      setLeads(r.data.items);
      setMore(!!r.data.nextCursor);
    });
    return () => {
      live = false;
    };
  }, [choice]);

  const chosen = (leads ?? []).filter((l) => !left.has(l.id));
  const firstId = chosen[0]?.id ?? null;
  const firstName = chosen[0]?.name ?? "";
  useEffect(() => {
    setPreview(null);
    if (!firstId) return;
    let live = true;
    void whatsappClient.templateState(firstId).then((r) => {
      const fits = r.ok ? r.data?.options.find((o) => o.missing.length === 0) : undefined;
      if (live && fits) setPreview({ who: firstNameOf(firstName) || firstName, text: fits.preview });
    });
    return () => {
      live = false;
    };
  }, [firstId, firstName]);

  const toggle = (id: string) =>
    setLeft((l) => {
      const next = new Set(l);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const n = leads?.length ?? 0;
  const ready = setup?.ready;

  return (
    <div className={w.page}>
      <header className={w.head}>
        <h2 className={w.lockup}>
          <AiGlyph size={28} draw="loop" />
          <span className={w.lume}>LUME</span>
          <span className={w.ai}>AI</span>
        </h2>
        <p className={w.lede}>
          Follows up with your leads on WhatsApp and hands them to you when they&apos;re ready.
        </p>
      </header>

      <div className={w.body}>
        <section className={w.card} aria-labelledby="waiting-h">
          <div className={w.cardHead}>
            <div className={w.cardWords}>
              {leads && n > 0 ? (
                <h3 id="waiting-h">{choice.title(`${fmt(n)}${more ? " or more" : ""}`, n === 1 && !more)}</h3>
              ) : (
                // Loading, or nobody: never "0 leads haven't heard from you".
                <h3 id="waiting-h">Leads waiting on you</h3>
              )}
              {n > 0 && <span>Untick anyone you&apos;d rather call yourself.</span>}
            </div>
            <label className={w.show}>
              <span>Show</span>
              <select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as Show)}>
                {SHOWS.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {problem ? (
            <p role="alert" className={w.problem}>
              {problem}
            </p>
          ) : !leads ? (
            <div className={w.loading} aria-busy aria-label="Getting the leads">
              <Skeleton height={40} radius={10} />
              <Skeleton height={40} radius={10} />
              <Skeleton height={40} radius={10} />
            </div>
          ) : leads.length === 0 ? (
            <div className={w.none}>
              <p>Nobody here is waiting on a follow-up.</p>
              <Link href="/leads">Choose leads on Leads</Link>
            </div>
          ) : (
            <div className={w.scroll}>
              <table className={w.table} aria-label="Leads waiting">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className={w.srOnly}>Follow up</span>
                    </th>
                    <th scope="col">Lead</th>
                    <th scope="col">Stage</th>
                    <th scope="col">Last heard</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.slice(0, ROWS).map((l) => (
                    <tr key={l.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={l.name ?? "Lead"}
                          checked={!left.has(l.id)}
                          onChange={() => toggle(l.id)}
                        />
                      </td>
                      <th scope="row">{l.name ?? "Unnamed lead"}</th>
                      <td>{(l.stageId && stages.get(l.stageId)) ?? ""}</td>
                      <td>{heard(l, now)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {leads.length > ROWS && (
                <p className={w.moreLine}>
                  {fmt(leads.length - ROWS)} more {more ? "here, and more on Leads" : "below the ones shown"}
                </p>
              )}
            </div>
          )}
        </section>

        <aside className={w.side}>
          {preview && (
            <section className={w.card} aria-label="A first message">
              <h3 className={w.sideTitle}>A first message, filled in for {preview.who}</h3>
              <p className={w.bubble}>{preview.text}</p>
              <span className={w.caption}>One of your approved WhatsApp templates</span>
            </section>
          )}
          {setup && (
            <section className={w.card} aria-label="What it may do">
              <h3 className={w.sideTitle}>What it may do</h3>
              <dl className={w.rules}>
                {SHOWN_CHOICES.map((a) => (
                  <div key={a}>
                    <dt>{AUTOPILOT_ACTION_TITLES[a]}</dt>
                    <dd data-allow={setup.standing.permissions[a]}>
                      {ALLOW_WORDS[setup.standing.permissions[a]]}
                    </dd>
                  </div>
                ))}
              </dl>
              <span className={w.caption}>You can change any of these for the run.</span>
            </section>
          )}
          {ready && !ready.ok ? (
            <div className={w.notReady} role="status">
              <p>{ready.message}</p>
              {ready.fixHref && <Link href={ready.fixHref}>Fix it</Link>}
            </div>
          ) : canStart ? (
            chosen.length > 0 && (
              <Button variant="primary" className={w.go} onClick={() => setStarting(true)} disabled={!setup}>
                Follow up with {chosen.length === 1 ? "this 1" : `these ${fmt(chosen.length)}`}
              </Button>
            )
          ) : (
            <p className={w.caption}>Someone who may message leads in bulk can start it.</p>
          )}
        </aside>
      </div>

      <AnimatePresence>
        {starting && (
          <StartSheet
            target={{ leadIds: chosen.map((l) => l.id) }}
            count={chosen.length}
            onClose={() => setStarting(false)}
            onStarted={(r) => {
              setStarting(false);
              onStarted(r);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
