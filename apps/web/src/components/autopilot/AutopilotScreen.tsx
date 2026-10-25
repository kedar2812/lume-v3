"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { useToast } from "@/components/feedback/ToastProvider";
import { useZone } from "@/components/ZoneProvider";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { autopilotClient } from "@/lib/autopilot/client";
import { useLoadingSignal } from "@/lib/loading";
import type { RunDetail, RunsList } from "@/lib/autopilot/types";
import { useRun } from "@/lib/autopilot/use-run";
import { currentLead, runCounts, runStatus, whenWords } from "@/lib/autopilot/words";
import { SPRINGS, toMotion } from "@/lib/motion";
import { useAutopilot } from "@/lib/notifications/stream";
import { usePhone } from "@/lib/usePhone";
import { LeadList } from "./LeadList";
import { LiveConversation } from "./LiveConversation";
import { ReadyColumn } from "./ReadyColumn";
import { RunBar } from "./RunBar";
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

/**
 * Autopilot (spec 2026-10-19 §2): a window onto LUME AI's runs on the server. The run bar, the leads with the one LUME
 * AI is on, and the live conversation where it types; Esc pauses (and resumes what Esc paused), a click into a lead's
 * message takes it over. Everything follows the tab's stream; every control is checked again by the server.
 */
export function AutopilotScreen({
  initial,
  askedRun,
  canStart,
}: {
  initial: RunsList;
  askedRun: string | null;
  /** May start runs (shown in the empty page). */
  canStart: boolean;
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
  const [watched, setWatched] = useState<string | null>(null);
  const [frozenAt, setFrozenAt] = useState<Date | null>(null);
  const [takenOver, setTakenOver] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  // A phone (§2.3): one lead at a time, Live or Ready.
  const phone = usePhone();
  const [tab, setTab] = useState<"live" | "ready">("live");

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

  // Paused: the typing stops where it was, from the moment LUME knew (the button, Esc, or another device).
  const status = data?.run.status;
  useEffect(() => {
    if (status === "paused") setFrozenAt((f) => f ?? new Date());
    else if (status) setFrozenAt(null);
  }, [status]);

  const when = useCallback((iso: string) => whenWords(iso, tz, new Date()), [tz]);
  const words = useMemo(() => (data ? runStatus(data, now, when) : null), [data, now, when]);
  const counts = useMemo(() => (data ? runCounts(data) : null), [data]);
  const current = data ? currentLead(data) : null;
  const shownLead =
    data?.leads.find((l) => l.leadId === watched) ??
    current ??
    data?.leads.find((l) => l.state !== "skipped") ??
    null;
  const speaker = data?.run.speakerName ?? "";
  const readyCount = data
    ? data.leads.filter((l) => l.state === "ready" || l.state === "needs_you").length + data.asks.length
    : 0;

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

  const takeOver = async (leadId: string) => {
    if (!runId) return;
    setBusy(true);
    const r = await autopilotClient.takeOver(runId, leadId);
    setBusy(false);
    if (!r.ok) return toast({ tone: "warn", title: "LUME couldn't hand you this lead", detail: r.message });
    setTakenOver((t) => ({ ...t, [leadId]: r.data.draft ?? "" }));
    setWatched(leadId);
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

  const leadList = (d: RunDetail) => (
    <LeadList
      leads={d.leads}
      currentId={current?.leadId ?? null}
      watchedId={shownLead?.leadId ?? null}
      onWatch={(id) => setWatched(id === current?.leadId ? null : id)}
    />
  );
  const conversation = (d: RunDetail) => (
    <div className={s.convoWrap}>
      {shownLead ? (
        <LiveConversation
          key={shownLead.leadId}
          lead={shownLead}
          current={!current || shownLead.leadId === current.leadId}
          tz={tz}
          speaker={speaker}
          frozenAt={frozenAt}
          takenOverText={takenOver[shownLead.leadId] ?? null}
          onBack={() => setWatched(null)}
          onTakeOver={() => void takeOver(shownLead.leadId)}
          onHandBack={() => handBack(shownLead.leadId)}
          ended={d.run.status === "ended"}
          canDecide={d.run.canControl && d.run.status !== "ended"}
          onCarryOn={() => carryOn(d.run.id, shownLead.leadId)}
        />
      ) : (
        <p className={s.nobody}>No one in this run LUME AI can message.</p>
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
  const readyColumn = (d: RunDetail) => (
    <ReadyColumn
      leads={d.leads}
      asks={d.asks}
      canDecide={d.run.canControl && d.run.status !== "ended"}
      onTakeOver={(id) => void takeOver(id)}
      onCarryOn={(id) => carryOn(d.run.id, id)}
      onApprove={(id) => act(() => autopilotClient.approve(id), "LUME couldn't do that")}
      onDecline={(id) => act(() => autopilotClient.decline(id), "LUME couldn't hand it to you")}
    />
  );

  if (!runs.length)
    return (
      <div className={s.empty}>
        <AiGlyph size={44} />
        <h2>Let LUME AI work your leads</h2>
        <p className={s.emptyLede}>
          LUME AI messages your leads on WhatsApp for you, live, and you can step in any time.
        </p>
        <ul className={s.emptySteps}>
          <li>
            <span aria-hidden className={s.emptyIcon}>
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <path d="m8 12 3 3 5-6" />
              </svg>
            </span>
            Select leads on Leads, then choose Let LUME AI handle these.
          </li>
          <li>
            <span aria-hidden className={s.emptyIcon}>
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4l2.5 2" />
              </svg>
            </span>
            Pick the goal and what it may do. It works in your hours, at WhatsApp&apos;s pace.
          </li>
          <li>
            <span aria-hidden className={s.emptyIcon}>
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="6" y="5" width="4" height="14" rx="1.2" />
                <rect x="14" y="5" width="4" height="14" rx="1.2" />
              </svg>
            </span>
            Watch it here. Esc pauses everything; click into a message to take that lead over.
          </li>
        </ul>
        {canStart && (
          <Link href="/leads" className={s.emptyCta}>
            Choose leads
          </Link>
        )}
      </div>
    );

  return (
    <div className={s.screen}>
      {runs.length > 1 && (
        <label className={s.switcher}>
          <span>Run</span>
          <select
            value={runId ?? ""}
            onChange={(e) => {
              setWatched(null);
              router.replace(`/autopilot?run=${encodeURIComponent(e.target.value)}`);
            }}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
                {r.status === "running" ? " · going" : r.status === "paused" ? " · paused" : " · done"}
              </option>
            ))}
          </select>
        </label>
      )}
      {!data || !words || !counts ? (
        problem ? (
          <p role="alert" className={s.problem}>
            {problem}
          </p>
        ) : (
          <div className={s.loadingBar} aria-busy aria-label="Getting the run">
            <Skeleton height={64} radius={18} />
            <div className={s.cols}>
              <Skeleton height={320} radius={16} />
              <Skeleton height={320} radius={16} />
            </div>
          </div>
        )
      ) : (
        <>
          <RunBar
            detail={data}
            status={words}
            counts={counts}
            asks={data.asks.length}
            busy={busy}
            onPause={pause}
            onResume={resume}
            onEnd={() => void act(() => autopilotClient.end(runId!), "LUME couldn't end it")}
            onOpenAsks={() => {
              setTab("ready");
              requestAnimationFrame(() => document.getElementById("autopilot-asks")?.focus());
            }}
          />
          {phone ? (
            <div className={s.phone}>
              <SegmentedControl
                label="Show"
                value={tab}
                options={[
                  { value: "live", label: "Live" },
                  { value: "ready", label: readyCount ? `Ready · ${readyCount}` : "Ready" },
                ]}
                onChange={setTab}
              />
              {tab === "live" ? (
                <>
                  {conversation(data)}
                  <details className={s.allLeads}>
                    <summary>All leads in this run</summary>
                    {leadList(data)}
                  </details>
                </>
              ) : (
                readyColumn(data)
              )}
            </div>
          ) : (
            <div className={s.cols}>
              {leadList(data)}
              {conversation(data)}
              {readyColumn(data)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
