"use client";
import { firstNameOf } from "@lume/core/shared";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { useToast } from "@/components/feedback/ToastProvider";
import { useZone } from "@/components/ZoneProvider";
import { Skeleton } from "@/components/ui/Skeleton";
import { autopilotClient } from "@/lib/autopilot/client";
import { useLoadingSignal } from "@/lib/loading";
import type { RunDetail, RunLead, RunsList } from "@/lib/autopilot/types";
import { useRun } from "@/lib/autopilot/use-run";
import {
  currentLead,
  defaultFilter,
  leadsIn,
  runLine,
  whenWords,
  type LeadFilter,
} from "@/lib/autopilot/words";
import { SPRINGS, toMotion } from "@/lib/motion";
import { useAutopilot } from "@/lib/notifications/stream";
import { usePhone } from "@/lib/usePhone";
import { LeadPane } from "./LeadPane";
import { LiveConversation } from "./LiveConversation";
import { RunHeader } from "./RunHeader";
import { WaitingWork } from "./WaitingWork";
import s from "./live.module.css";

/** The run the page opens on: the one asked for, else the newest going, else the newest. */
export function runToShow(list: RunsList["runs"], asked: string | null): string | null {
  if (asked && list.some((r) => r.id === asked)) return asked;
  return (list.find((r) => r.status === "running") ?? list[0])?.id ?? null;
}

/** Typing in a box, or a dialog open: Esc there isn't Pause. */
function escBelongsElsewhere(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (e.defaultPrevented) return true;
  if (t && (t.closest("input, textarea, select, [contenteditable='true']") || t.isContentEditable))
    return true;
  return !!document.querySelector('[aria-modal="true"]');
}

/** What LUME says when a lead arrives ready for, or needing, a person (§2): from its own words, never invented. */
function arrival(l: RunLead): string {
  const who = firstNameOf(l.name) || l.name;
  const head = l.card?.headline ?? "";
  if (l.state === "ready" && /^Reached /.test(head))
    return `${who} reached ${head.slice(8)}. Want to take over?`;
  if (l.state === "ready") return `${who} is ready for you. Want to take over?`;
  return `${who} needs you${l.reason ? `: ${l.reason.replace(/\.$/, "")}` : ""}.`;
}

/**
 * A lead that arrives ready for, or needing, a person while the page is open: LUME says so once, with Take over. The
 * ones there when the page opened aren't news; one that leaves (carried on) and comes back later is news again. A lead
 * reaching the goal is an achievement: the one moment LUME makes a sound here.
 */
function useArrivals(leads: RunLead[] | null, onTakeOver: (leadId: string) => void) {
  const { toast } = useToast();
  const seen = useRef<Set<string> | null>(null);
  const here = (leads ?? []).filter((l) => l.state === "ready" || l.state === "needs_you");
  const key = leads ? here.map((l) => `${l.leadId}:${l.state}`).join(",") : null;
  const latest = useRef({ here, toast, onTakeOver });
  latest.current = { here, toast, onTakeOver };
  useEffect(() => {
    if (key === null) return;
    const { here: now, toast: say, onTakeOver: take } = latest.current;
    if (!seen.current) {
      seen.current = new Set(now.map((l) => l.leadId));
      return;
    }
    const arrived = now.filter((l) => !seen.current!.has(l.leadId));
    seen.current = new Set(now.map((l) => l.leadId));
    for (const l of arrived)
      say({
        tone: l.state === "ready" ? "ok" : "warn",
        title: arrival(l),
        action: { label: "Take over", onClick: () => take(l.leadId) },
        ...(l.state === "ready" ? { sound: "won" as const } : {}),
      });
  }, [key]);
}

/**
 * LUME AI (spec 2026-10-19 §2; the approved redesign, plan 2026-10-28): a window onto LUME AI's runs on the server.
 * The header says where the run stands in one line; below it, two panes as Mail: the leads, filtered Needs you, Ready or
 * All, and the conversation of the one chosen (LUME AI's own lead until someone picks another). Esc pauses (and
 * resumes what Esc paused); a click into LUME AI's message takes the lead over. On a phone the list comes first and a
 * lead opens on its own, with Back. Everything follows the tab's stream; every control is checked again by the server.
 */
export function AutopilotScreen({
  initial,
  askedRun,
  canStart,
  off,
}: {
  initial: RunsList;
  askedRun: string | null;
  /** May start runs (New run, and the first visit's start). */
  canStart: boolean;
  /** LUME AI is off for this person: the page says so, and an admin (integrations.manage) gets the switch. */
  off?: { canSwitch: boolean };
}) {
  const tz = useZone();
  const router = useRouter();
  const reduce = useReducedMotion();
  const { toast } = useToast();
  const [runs, setRuns] = useState(initial.runs);
  const runId = runToShow(runs, askedRun);
  const { data, loading, problem, refresh } = useRun(runId);
  // The bar under the top bar while the run is read.
  useLoadingSignal(loading);
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState<LeadFilter | null>(null);
  const [frozenAt, setFrozenAt] = useState<Date | null>(null);
  const [takenOver, setTakenOver] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  // A phone (plan 2026-10-28, artboard 3): the list, or one lead's conversation with Back.
  const phone = usePhone();
  const [phoneLead, setPhoneLead] = useState<string | null>(null);

  // The runs list follows the stream too (a new run, one ended), once things settle.
  const listTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useAutopilot((e) => {
    // A run started, paused, resumed or ended (no lead); a lead's own changes leave the list as it is.
    if (e.lead !== null) return;
    clearTimeout(listTimer.current);
    listTimer.current = setTimeout(() => {
      void autopilotClient.runs().then((r) => r.ok && setRuns(r.data.runs));
    }, 800);
  });
  useEffect(() => () => clearTimeout(listTimer.current), []);
  // "Next one at 10:00 am" stays true as time passes.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  // Another run: its own filter and lead.
  useEffect(() => {
    setFilter(null);
    setPicked(null);
    setPhoneLead(null);
  }, [runId]);

  // Paused: the typing stops where it was, from the moment LUME knew (the button, Esc, or another device).
  const status = data?.run.status;
  useEffect(() => {
    if (status === "paused") setFrozenAt((f) => f ?? new Date());
    else if (status) setFrozenAt(null);
  }, [status]);

  const when = useCallback((iso: string) => whenWords(iso, tz, new Date()), [tz]);
  const line = useMemo(() => (data ? runLine(data, now, when) : null), [data, now, when]);
  const current = data ? currentLead(data) : null;
  // The filter the page opened on (Needs you when someone needs you), until someone chooses one.
  const shownFilter: LeadFilter = filter ?? (data ? defaultFilter(data.leads) : "all");
  const listed = data ? leadsIn(data.leads, shownFilter) : [];
  // The lead shown: the one picked, else LUME AI's own when it's in the list, else the list's first.
  const shownLead =
    data?.leads.find((l) => l.leadId === picked) ??
    (current && listed.some((l) => l.leadId === current.leadId) ? current : null) ??
    listed[0] ??
    null;
  const speaker = data?.run.speakerName ?? "";

  const act = useCallback(
    async (what: () => Promise<{ ok: boolean; message?: string }>, failure: string) => {
      setBusy(true);
      const r = await what();
      setBusy(false);
      if (!r.ok) toast({ tone: "warn", title: failure, detail: r.message ?? "" });
      refresh();
      return r.ok;
    },
    [refresh, toast],
  );
  const pause = useCallback(() => {
    if (!runId) return;
    // Frozen at once, so nothing more seems to be typed; if the Pause didn't reach LUME, the run still goes: unfrozen.
    setFrozenAt(new Date());
    void act(() => autopilotClient.pause(runId), "LUME couldn't pause it").then((ok) => {
      if (!ok) setFrozenAt(null);
    });
  }, [act, runId]);
  const resume = useCallback(() => {
    if (!runId) return;
    void act(() => autopilotClient.resume(runId), "LUME couldn't resume it");
  }, [act, runId]);

  // Esc pauses everything; Esc again resumes what Esc paused (the mockup's veil). Not while typing or in a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !data?.run.canControl || escBelongsElsewhere(e)) return;
      if (data.run.status === "running") {
        e.preventDefault();
        pause();
      } else if (data.run.status === "paused" && data.run.pauseReason === "person") {
        e.preventDefault();
        resume();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [data, pause, resume]);

  const show = (leadId: string) => {
    setPicked(leadId);
    if (phone) setPhoneLead(leadId);
  };
  const takeOver = async (leadId: string) => {
    if (!runId) return;
    setBusy(true);
    const r = await autopilotClient.takeOver(runId, leadId);
    setBusy(false);
    if (!r.ok) return toast({ tone: "warn", title: "LUME couldn't hand you this lead", detail: r.message });
    setTakenOver((t) => ({ ...t, [leadId]: r.data.draft ?? "" }));
    show(leadId);
    refresh();
  };
  const carryOn = (run: string, leadId: string) =>
    void act(() => autopilotClient.carryOn(run, leadId), "LUME AI couldn't carry on");
  const handBack = (leadId: string) =>
    void act(() => autopilotClient.handBack(runId!, leadId), "LUME couldn't hand it back").then(
      (ok) =>
        ok &&
        setTakenOver((t) => {
          const rest = { ...t };
          delete rest[leadId];
          return rest;
        }),
    );
  useArrivals(data?.leads ?? null, (id) => void takeOver(id));

  const pane = (d: RunDetail) => (
    <LeadPane
      leads={d.leads}
      asks={d.asks}
      filter={shownFilter}
      onFilter={(f) => {
        setFilter(f);
        setPicked(null);
      }}
      currentId={current?.leadId ?? null}
      selectedId={phone ? null : (shownLead?.leadId ?? null)}
      onSelect={show}
      tz={tz}
      now={now}
    />
  );
  const conversation = (d: RunDetail, l: RunLead | null) => (
    <div className={s.convoWrap}>
      {l ? (
        <LiveConversation
          key={l.leadId}
          lead={l}
          tz={tz}
          speaker={speaker}
          frozenAt={frozenAt}
          takenOverText={takenOver[l.leadId] ?? null}
          onTakeOver={() => void takeOver(l.leadId)}
          onHandBack={() => handBack(l.leadId)}
          ended={d.run.status === "ended"}
          canDecide={d.run.canControl && d.run.status !== "ended"}
          onCarryOn={() => carryOn(d.run.id, l.leadId)}
          ask={d.asks.find((a) => a.leadId === l.leadId) ?? null}
          onApprove={(id) => act(() => autopilotClient.approve(id), "LUME couldn't do that")}
          onDecline={(id) => act(() => autopilotClient.decline(id), "LUME couldn't hand it to you")}
        />
      ) : (
        <p className={s.nobody}>Choose a lead to see the conversation.</p>
      )}
      <AnimatePresence>
        {d.run.status === "paused" && d.run.pauseReason === "person" && (
          <motion.div
            className={s.veil}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduce ? { duration: 0 } : toMotion(SPRINGS.default)}
          >
            <div className={s.veilCard} role="status">
              <b>Paused</b>
              <span>Nothing is sent until you resume.</span>
              {d.run.canControl && <span className={s.veilHint}>Press Esc or Resume.</span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  if (off && !runs.length)
    return (
      <div className={s.off}>
        <section className={s.offCard} aria-labelledby="lumeai-off">
          <span className={s.offMark}>
            <AiGlyph size={46} draw="loop" tone="muted" />
            <span className={s.offBadge} aria-hidden>
              Off
            </span>
          </span>
          <h2 id="lumeai-off">LUME AI is off</h2>
          {off.canSwitch ? (
            <>
              <p>
                Switch it on to let LUME AI follow up with your leads on WhatsApp. It only does what you
                allow, and every message sits on the lead.
              </p>
              <div className={s.offActions}>
                <Link href="/settings/integrations" className={s.offPrimary}>
                  Switch LUME AI on
                </Link>
                <Link href="/settings/ai" className={s.offSecondary}>
                  What LUME AI does
                </Link>
              </div>
              <p className={s.offNote}>
                Settings → Integrations → LUME AI. It uses your plan&apos;s monthly allowance.
              </p>
            </>
          ) : (
            <>
              <p>An admin can switch it on in Settings → Integrations.</p>
              <p className={s.offNote}>Until then, your leads and follow-ups work as they always do.</p>
            </>
          )}
        </section>
      </div>
    );

  if (!runs.length)
    return (
      <WaitingWork
        canStart={canStart}
        onStarted={(r) => {
          void autopilotClient.runs().then((x) => x.ok && setRuns(x.data.runs));
          router.replace(`/autopilot?run=${encodeURIComponent(r.run.id)}`);
        }}
      />
    );

  const phoneShown = phone && phoneLead ? (data?.leads.find((l) => l.leadId === phoneLead) ?? null) : null;
  return (
    <div className={s.screen}>
      {!data || !line ? (
        problem ? (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        ) : (
          <div className={s.loadingBar} aria-busy aria-label="Getting the run">
            <Skeleton height={56} radius={14} />
            <Skeleton height={420} radius={16} />
          </div>
        )
      ) : (
        <>
          <RunHeader
            run={data.run}
            line={line}
            busy={busy}
            canStart={canStart}
            runs={runs}
            onRun={(id) => router.replace(`/autopilot?run=${encodeURIComponent(id)}`)}
            onPause={pause}
            onResume={resume}
            onEnd={() => void act(() => autopilotClient.end(runId!), "LUME couldn't end it")}
          />
          {phone ? (
            <div className={s.panes} data-phone="">
              {phoneShown ? (
                <div className={s.phoneLead}>
                  <button type="button" className={s.back} onClick={() => setPhoneLead(null)}>
                    <span aria-hidden>‹</span> Back to the leads
                  </button>
                  {conversation(data, phoneShown)}
                </div>
              ) : (
                pane(data)
              )}
            </div>
          ) : (
            <div className={s.panes}>
              {pane(data)}
              {conversation(data, shownLead)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
