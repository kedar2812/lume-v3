"use client";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import { BodyPortal } from "@/components/ui/BodyPortal";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSound } from "@/components/feedback/SoundProvider";
import { Button } from "@/components/ui/Button";
import { SPRINGS, toMotion } from "@/lib/motion";
import {
  doneOf,
  queueChanged,
  queuesClient,
  type LumeChannel,
  type QueueItem,
  type QueueStep,
  type QueueView,
} from "@/lib/queues/client";
import { StartSheet } from "@/components/autopilot/StartSheet";
import { useWhatsApp } from "@/lib/notifications/stream";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaThreadMessage } from "@/lib/whatsapp/types";
import type { LumePhase } from "./LumeSend";
import { QueueCard, type CardPhase } from "./QueueCard";
import { QueueSummary } from "./QueueSummary";
import s from "./run.module.css";

/** How long a skipped-at-send lead's reason stays before the next lead comes. */
const NOTE_MS = 1200;
/** How long the tick (and a stage's move) shows after Yes. */
const TICK_MS = 700;
/** Sent from LUME: how long the card waits for WhatsApp's answer before moving on (it keeps trying meanwhile). */
const WAIT_MS = 10_000;
/** How often the card looks at the message while it waits, between the live stream's words. */
const LOOK_MS = 2_000;

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

/**
 * The leads this tab opened WhatsApp for (final review #1): per tab, and kept across a reload. Only this
 * tab's own open lead asks Sent? here; another tab's is left to it, unless nothing else is left to do.
 */
const claimsKey = (id: string) => `lume.queue.${id}.claimed`;
function readClaims(id: string): number[] {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(claimsKey(id)) ?? "[]");
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}
function writeClaims(id: string, claims: number[]) {
  try {
    sessionStorage.setItem(claimsKey(id), JSON.stringify(claims));
  } catch {
    // Private windows may refuse storage: this tab then just asks about every open lead.
  }
}
function pickCurrent(q: QueueView | null, claims: number[]): QueueItem | null {
  if (!q) return null;
  return (
    q.items.find((i) => i.status === "sending" && claims.includes(i.position)) ??
    q.items.find((i) => i.status === "pending") ??
    q.items.find((i) => i.status === "sending") ??
    null
  );
}

/**
 * The run (4C): a focused mode over the app, one lead at a time. Send opens WhatsApp (4A's hand-off);
 * back in LUME, Sent?; the answer moves on to the next lead, which slides in from the right. Pause keeps
 * the place; Esc leaves it paused. Finishing plays `cleared` and says how it went.
 */
export function QueueRun({ id, tz, canAi = false }: { id: string; tz?: string; canAi?: boolean }) {
  const router = useRouter();
  const sound = useSound();
  const reduce = useReducedMotion();
  const [q, setQ] = useState<QueueView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<CardPhase>("ready");
  const [note, setNote] = useState<string | null>(null);
  const [capNote, setCapNote] = useState<string | null>(null);
  const [finishedHere, setFinishedHere] = useState(false);
  const [outcome, setOutcome] = useState<{ moved?: string; refused?: string } | null>(null);
  const [skippedLeaving, setSkippedLeaving] = useState(false);
  /** How the current card is leaving: a skip goes its own way. */
  const [leaving, setLeaving] = useState<"skip" | null>(null);
  const [ending, setEnding] = useState(false);
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const claims = useRef<number[]>([]);
  const claim = (pos: number, on: boolean) => {
    claims.current = on ? [...new Set([...claims.current, pos])] : claims.current.filter((p) => p !== pos);
    writeClaims(id, claims.current);
  };

  const current = pickCurrent(q, claims.current);

  // Sent from inside LUME (spec 2026-11-26): how this lead goes, its conversation, and where its message has got to.
  const [channel, setChannel] = useState<{ pos: number; c: LumeChannel } | null>(null);
  const [thread, setThread] = useState<WaThreadMessage[] | null>(null);
  const [lumePhase, setLumePhase] = useState<LumePhase>("ready");
  const [problem, setProblem] = useState<string | null>(null);
  const [aiSheet, setAiSheet] = useState(false);
  const sentMsg = useRef<{ id: string; step: QueueStep; at: number } | null>(null);
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lume =
    channel && current && channel.pos === current.position && channel.c.via === "lume" ? channel.c : null;
  // How this lead goes isn't known yet: nothing can be sent either way until it is.
  const known = !!channel && !!current && channel.pos === current.position;
  const opensWhy =
    channel && current && channel.pos === current.position && channel.c.via === "whatsapp" && channel.c.why
      ? channel.c.why
      : null;
  // Answers about a lead no longer in front are dropped: never another lead's conversation or way under this name.
  const posNow = useRef<number | null>(null);
  const leadNow = useRef<string | null>(null);
  posNow.current = current?.position ?? null;
  leadNow.current = current?.leadId ?? null;
  const loadChannel = useCallback(
    async (pos: number) => {
      const r = await queuesClient.channel(id, pos);
      if (posNow.current !== pos) return;
      if (!r.ok) return setChannel({ pos, c: { via: "whatsapp", why: "" } });
      setChannel({ pos, c: r.data });
    },
    [id],
  );
  const loadThread = useCallback(async (leadId: string) => {
    const r = await whatsappClient.thread(leadId);
    if (r.ok && leadNow.current === leadId) setThread(r.data.messages);
  }, []);
  // A new lead in front: what it allows, and its conversation.
  const pos = current?.position ?? null;
  const leadId = current?.leadId ?? null;
  useEffect(() => {
    setLumePhase("ready");
    setProblem(null);
    setThread(null);
    sentMsg.current = null;
    if (pos === null) return;
    void loadChannel(pos);
  }, [pos, loadChannel]);
  useEffect(() => {
    if (lume && leadId) void loadThread(leadId);
  }, [lume, leadId, loadThread]);
  // Their reply, and the message's ticks, as they happen.
  useWhatsApp((e) => {
    if (leadId && (e.lead === leadId || e.lead === "*") && lume) void loadThread(leadId);
  });

  const load = useCallback(async () => {
    const r = await queuesClient.get(id);
    if (!r.ok) return setError(r.message);
    setError(null);
    setQ(r.data);
    setOutcome(null);
    // Back after a reload with WhatsApp already opened from this tab (or a lead nobody answered for,
    // once nothing else is left): Sent? first.
    setPhase(pickCurrent(r.data, claims.current)?.status === "sending" ? "asking" : "ready");
    return r.data;
  }, [id]);
  useEffect(() => {
    claims.current = readClaims(id);
    void load();
    return () => clearTimeout(timer.current);
  }, [id, load]);

  const after = async (step: QueueStep) => {
    if (step.finished) {
      setFinishedHere(true);
      sound.play("cleared");
    }
    queueChanged();
    await load();
  };

  const send = async (text: string | undefined) => {
    if (!q || !current || busy.current || q.status !== "active" || !known || lume) return;
    const tab = window.open("", "_blank");
    if (!tab) return setError("Your browser blocked the new tab. Allow pop-ups for LUME, then try again.");
    tab.opener = null;
    busy.current = true;
    setError(null);
    const r = await queuesClient.prepare(id, current.position, text);
    busy.current = false;
    if (!r.ok) {
      tab.close();
      if (r.code === "DAILY_CAP") {
        setCapNote(r.message);
        queueChanged();
        await load();
        return;
      }
      if (r.code === "ITEM_TAKEN") {
        setNote("Open in another tab");
        timer.current = setTimeout(() => {
          setNote(null);
          void load();
        }, NOTE_MS);
        return;
      }
      return setError(r.message);
    }
    if ("skipped" in r.data) {
      tab.close();
      const step = r.data;
      setNote(step.skipped);
      setSkippedLeaving(true);
      timer.current = setTimeout(() => {
        setNote(null);
        void after(step).then(() => setSkippedLeaving(false));
      }, NOTE_MS);
      return;
    }
    claim(current.position, true);
    tab.location.href = r.data.url;
    setPhase("away");
  };

  // "Sent?" rises the next time LUME has focus again after WhatsApp was opened (as 4A), or the page is
  // shown again (a phone handing WhatsApp to its app); Back from WhatsApp is there if neither comes.
  useEffect(() => {
    if (phase !== "away") return;
    const back = () => setPhase("asking");
    const shown = () => {
      if (document.visibilityState === "visible") back();
    };
    window.addEventListener("focus", back, { once: true });
    document.addEventListener("visibilitychange", shown);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [phase]);

  const answer = async (sent: boolean) => {
    if (!current || busy.current || phase !== "asking") return;
    busy.current = true;
    setPhase("answering");
    const r = sent
      ? await queuesClient.sent(id, current.position)
      : await queuesClient.notSent(id, current.position);
    busy.current = false;
    if (!r.ok) {
      // Answered elsewhere, or the run ended meanwhile: look again rather than ask about stale state.
      if (r.status === 409) {
        claim(current.position, false);
        await load();
        return;
      }
      setPhase("asking");
      return setError(r.message);
    }
    claim(current.position, false);
    if (!sent) return after(r.data);
    // Logged: the sound and the tick together; the stage's move says where the lead went.
    sound.play("sent");
    setOutcome({
      ...(r.data.moved ? { moved: r.data.moved.stageName } : {}),
      ...(r.data.notMoved ? { refused: r.data.notMoved.message } : {}),
    });
    setPhase("sent");
    const step = r.data;
    timer.current = setTimeout(() => void after(step), TICK_MS);
  };

  const skip = async () => {
    if (!current || busy.current || phase !== "ready") return;
    // Sent from LUME and refused: the lead is already Not sent; Skip moves on.
    if (lume && lumePhase === "failed") return void load();
    if (lume && lumePhase !== "ready") return;
    // Nothing can go to them (their choice stands): the run skips them with why, in its summary.
    if (lume?.blocked) return void sendLume({ mode: "template" });
    busy.current = true;
    // A skip leaves its own way (down and out of the way), not as a sent lead does.
    setLeaving("skip");
    const r = await queuesClient.skip(id, current.position);
    busy.current = false;
    if (!r.ok) {
      setLeaving(null);
      return setError(r.message);
    }
    await after(r.data);
    setLeaving(null);
  };

  /** A lead answered Not sent, tried again: the run opens on it. */
  const retry = async (position: number) => {
    const r = await queuesClient.retry(id, position);
    if (!r.ok) return setError(r.message);
    setFinishedHere(false);
    queueChanged();
    await load();
  };

  /** One lead sent from inside LUME: one key per press, so a retried request is the same message, never two. */
  const sendLume = async (body: { mode: "template" | "message"; text?: string }) => {
    if (!current || busy.current || lumePhase !== "ready" || q?.status !== "active") return;
    busy.current = true;
    setError(null);
    setLumePhase("sending");
    const r = await queuesClient.sendItem(id, current.position, { ...body, clientKey: crypto.randomUUID() });
    busy.current = false;
    if (!r.ok) {
      setLumePhase("ready");
      // What it allows changed (their 24 hours ended, WhatsApp switched off): look again. A pause: the run says so.
      void loadChannel(current.position);
      queueChanged();
      await load();
      // After the run is read again (which clears an old message), so this one stays.
      setError(r.message);
      return;
    }
    if ("skipped" in r.data) {
      const step = r.data;
      setLumePhase("ready");
      setNote(step.skipped);
      setSkippedLeaving(true);
      timer.current = setTimeout(() => {
        setNote(null);
        void after(step).then(() => setSkippedLeaving(false));
      }, NOTE_MS);
      return;
    }
    const { message, ...step } = r.data;
    sentMsg.current = { id: message.id, step, at: Date.now() };
    setThread((t) => [...(t ?? []).filter((m) => m.id !== message.id), message]);
  };
  // Waiting for WhatsApp's answer: Sent moves on, a refusal stays with its words, slow moves on after 10 seconds.
  useEffect(() => {
    const m = sentMsg.current;
    if (lumePhase !== "sending" || !m) return;
    const now = thread?.find((x) => x.id === m.id);
    if (now && (now.status === "sent" || now.status === "delivered" || now.status === "read")) {
      setLumePhase("sent");
      sound.play("sent");
      const step = m.step;
      timer.current = setTimeout(() => void after(step), TICK_MS);
      return;
    }
    if (now?.status === "failed") {
      setLumePhase("failed");
      setProblem(now.problem);
      return;
    }
    const look = setTimeout(() => leadId && void loadThread(leadId), LOOK_MS);
    const slow = setTimeout(
      () => {
        setLumePhase("slow");
        const step = m.step;
        timer.current = setTimeout(() => void after(step), NOTE_MS);
      },
      Math.max(0, WAIT_MS - (Date.now() - m.at)),
    );
    return () => {
      clearTimeout(look);
      clearTimeout(slow);
    };
  }, [lumePhase, thread, leadId, loadThread]);
  /** Refused by WhatsApp: the lead goes back in the run and can go again. */
  const retryLume = async () => {
    if (!current) return;
    const r = await queuesClient.retry(id, current.position);
    if (!r.ok) return setError(r.message);
    sentMsg.current = null;
    setProblem(null);
    setLumePhase("ready");
    queueChanged();
    await load();
    void loadChannel(current.position);
  };
  /**
   * Let LUME AI take the rest: the leads still waiting as the run has them now, never the one just messaged (it may
   * still be waiting for WhatsApp's answer here).
   */
  const [aiLeads, setAiLeads] = useState<string[]>([]);
  const openAi = async () => {
    const r = await queuesClient.get(id);
    if (!r.ok) return setError(r.message);
    const going = lumePhase !== "ready" && current ? current.leadId : null;
    const waiting = r.data.items
      .filter((i) => i.status === "pending" && i.leadId !== going)
      .map((i) => i.leadId);
    if (!waiting.length) return;
    setAiLeads(waiting);
    setAiSheet(true);
  };
  /** Let LUME AI take the rest: the leads it took leave this run. */
  const handOver = async (runId: string) => {
    setAiSheet(false);
    const r = await queuesClient.handed(id, runId);
    if (!r.ok) return setError(r.message);
    queueChanged();
    await load();
  };

  const pause = async () => {
    if (!q || q.status !== "active" || busy.current) return;
    const r = await queuesClient.pause(id);
    if (!r.ok) return setError(r.message);
    queueChanged();
    setQ(r.data);
  };
  const resume = async () => {
    const r = await queuesClient.resume(id);
    if (!r.ok) {
      if (r.code === "DAILY_CAP") setCapNote(r.message);
      return setError(r.code === "DAILY_CAP" ? null : r.message);
    }
    setCapNote(null);
    queueChanged();
    await load();
  };
  // End the run (final review #2): leads not sent yet stay as they are; the summary says how far it got.
  const end = async () => {
    clearTimeout(timer.current);
    const r = await queuesClient.cancel(id);
    setEnding(false);
    if (!r.ok) return setError(r.message);
    claims.current = [];
    writeClaims(id, []);
    queueChanged();
    await load();
  };
  const leave = async () => {
    clearTimeout(timer.current);
    if (q?.status === "active") {
      await queuesClient.pause(id);
      queueChanged();
    }
    router.push("/today");
  };

  // Keys (the plan's Interaction section): Enter sends, S skips, Y / N answer Sent?, P pauses, Esc leaves.
  const keys = useRef({ send, skip, answer, pause, resume, leave, phase, q, note, ending });
  keys.current = { send, skip, answer, pause, resume, leave, phase, q, note, ending };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      // Only keys meant for the run: pressed in it, or with nothing in particular focused (final review #5).
      const t = e.target as Node | null;
      if (t && t !== document.body && t !== document.documentElement && !root.current?.contains(t)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        // In the message box, Esc only leaves the box; with End run asked, it keeps going.
        if (isTyping(e.target)) return void (e.target as HTMLElement).blur();
        if (k.ending) return void setEnding(false);
        return void k.leave();
      }
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || k.note) return;
      if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) {
        if (e.key === "Enter" || e.key === " ") return; // the focused control answers for itself
      }
      const key = e.key.toLowerCase();
      if (k.q?.status === "paused") {
        if (key === "p") return void k.resume();
        return;
      }
      if (k.phase === "asking" && (key === "y" || key === "n")) return void k.answer(key === "y");
      if (k.phase === "ready" && e.key === "Enter") {
        e.preventDefault();
        return void document.querySelector<HTMLFormElement>("[data-queue-form]")?.requestSubmit();
      }
      if (k.phase === "ready" && key === "s") return void k.skip();
      if (key === "p") return void k.pause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const done = q ? doneOf(q) : 0;
  const over = q && (q.status === "finished" || q.status === "cancelled");
  const spring = reduce ? { duration: 0.15 } : toMotion(SPRINGS.default);
  return (
    <BodyPortal>
      <div className={s.scrim}>
        <motion.div
          ref={root}
          className={s.run}
          role="dialog"
          aria-modal="true"
          aria-label="Send queue"
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={spring}
        >
          <div className={s.head}>
            <div className={s.title}>
              <span className={s.kicker}>Send queue</span>
              <span className={s.template}>{q?.templateName ?? (q ? "Your own words" : "")}</span>
              {q?.number && <span className={s.from}>From {q.number.display}</span>}
            </div>
            <p className={s.progressText} aria-live="polite">
              <span className={s.num}>
                {done} of {q?.total ?? 0}
              </span>
            </p>
            <div className={s.tools}>
              <p className={s.today}>
                Today{" "}
                <span className={s.num}>
                  {q?.today.sent ?? 0} / {q?.today.cap ?? 0}
                </span>
              </p>
              {ending ? (
                <div role="group" aria-label="End this run?" className={s.endAsk}>
                  <span className={s.endWords}>End this run? Leads not sent yet stay as they are.</span>
                  <Button size="sm" variant="ghost" onClick={() => setEnding(false)}>
                    Keep going
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void end()}>
                    End it
                  </Button>
                </div>
              ) : (
                <>
                  {q?.status === "active" && (
                    <Button size="sm" variant="ghost" onClick={() => void pause()}>
                      Pause
                    </Button>
                  )}
                  {canAi && q?.status === "active" && q.items.some((i) => i.status === "pending") && (
                    <Button size="sm" variant="ghost" onClick={() => void openAi()}>
                      Let LUME AI take the rest
                    </Button>
                  )}
                  {q && !over && (
                    <Button size="sm" variant="ghost" onClick={() => setEnding(true)}>
                      End run
                    </Button>
                  )}
                </>
              )}
              <button
                type="button"
                className={s.close}
                aria-label="Leave the run"
                onClick={() => void leave()}
              >
                <UI_ICONS.close size={ICON_SIZE.sm} aria-hidden />
              </button>
            </div>
            <span className={s.bar} aria-hidden>
              <motion.span
                className={s.fill}
                initial={false}
                animate={{ scaleX: q && q.total ? done / q.total : 0 }}
                transition={reduce ? { duration: 0 } : toMotion(SPRINGS.soft)}
              />
            </span>
          </div>

          <div className={s.stage}>
            {error && (
              <p role="alert" className={s.error}>
                {error}
              </p>
            )}
            {!q ? null : over ? (
              <QueueSummary
                q={q}
                finishedHere={finishedHere}
                onDone={() => router.push("/today")}
                {...(q.status === "finished" ? { onRetry: (pos: number) => void retry(pos) } : {})}
              />
            ) : q.status === "paused" ? (
              <motion.section
                className={s.paused}
                aria-label="Paused"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={spring}
              >
                <p className={s.pausedTitle}>Paused</p>
                <p className={s.pausedLine}>
                  {capNote ??
                    (q.pausedReason === "daily_cap"
                      ? "Today's limit is reached; the run waits until tomorrow."
                      : q.pausedReason
                        ? `${q.pausedReason} LUME kept your place.`
                        : "LUME kept your place.")}
                </p>
                <Button variant="primary" onClick={() => void resume()}>
                  Resume
                </Button>
              </motion.section>
            ) : (
              current && (
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div
                    key={current.position}
                    data-testid="queue-card"
                    data-motion={reduce ? "fade" : "slide"}
                    data-leaving={leaving ?? undefined}
                    className={s.cardWrap}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, x: 64 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={
                      reduce
                        ? { opacity: 0 }
                        : leaving === "skip"
                          ? { opacity: 0, y: 24, x: 0 }
                          : { opacity: skippedLeaving ? 0 : 0.4, x: -64 }
                    }
                    transition={spring}
                  >
                    <QueueCard
                      runId={id}
                      item={current}
                      sourceName={q.sourceName}
                      phase={phase}
                      note={note}
                      outcome={outcome}
                      onSend={(text) => void send(text)}
                      onSkip={() => void skip()}
                      onAnswer={(sent) => void answer(sent)}
                      onBack={() => setPhase("asking")}
                      opensWhy={opensWhy}
                      waiting={!known}
                      {...(lume
                        ? {
                            lume: {
                              channel: lume,
                              thread,
                              phase: lumePhase,
                              problem,
                              tz: zone,
                              onSend: (b) => void sendLume(b),
                              onRetry: () => void retryLume(),
                            },
                          }
                        : {})}
                    />
                  </motion.div>
                </AnimatePresence>
              )
            )}
          </div>
        </motion.div>
      </div>
      {aiSheet && (
        <StartSheet
          target={{ leadIds: aiLeads }}
          count={aiLeads.length}
          onClose={() => setAiSheet(false)}
          onStarted={(r) => void handOver(r.run.id)}
        />
      )}
    </BodyPortal>
  );
}
