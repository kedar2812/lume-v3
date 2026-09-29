"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSound } from "@/components/feedback/SoundProvider";
import { Button } from "@/components/ui/Button";
import { SPRINGS, toMotion } from "@/lib/motion";
import { doneOf, queueChanged, queuesClient, type QueueStep, type QueueView } from "@/lib/queues/client";
import { QueueCard, type CardPhase } from "./QueueCard";
import { QueueSummary } from "./QueueSummary";
import s from "./run.module.css";

/** How long a skipped-at-send lead's reason stays before the next lead comes. */
const NOTE_MS = 1200;
/** How long the tick (and a stage's move) shows after Yes. */
const TICK_MS = 700;

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

/**
 * The run (4C): a focused mode over the app, one lead at a time. Send opens WhatsApp (4A's hand-off);
 * back in LUME, Sent?; the answer moves on to the next lead, which slides in from the right. Pause keeps
 * the place; Esc leaves it paused. Finishing plays `cleared` and says how it went.
 */
export function QueueRun({ id }: { id: string }) {
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
  const busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const current =
    q?.items.find((i) => i.status === "sending") ?? q?.items.find((i) => i.status === "pending") ?? null;

  const load = useCallback(async () => {
    const r = await queuesClient.get(id);
    if (!r.ok) return setError(r.message);
    setError(null);
    setQ(r.data);
    setOutcome(null);
    // Back after a reload (or from another tab) with WhatsApp already opened: Sent? first.
    setPhase(r.data.items.some((i) => i.status === "sending") ? "asking" : "ready");
    return r.data;
  }, [id]);
  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, [load]);

  const after = async (step: QueueStep) => {
    if (step.finished) {
      setFinishedHere(true);
      sound.play("cleared");
    }
    queueChanged();
    await load();
  };

  const send = async (text: string | undefined) => {
    if (!q || !current || busy.current || q.status !== "active") return;
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
    tab.location.href = r.data.url;
    setPhase("away");
  };

  // "Sent?" rises the next time LUME has focus again after WhatsApp was opened (as 4A).
  useEffect(() => {
    if (phase !== "away") return;
    const back = () => setPhase("asking");
    window.addEventListener("focus", back, { once: true });
    return () => window.removeEventListener("focus", back);
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
      setPhase("asking");
      return setError(r.message);
    }
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
    busy.current = true;
    const r = await queuesClient.skip(id, current.position);
    busy.current = false;
    if (!r.ok) return setError(r.message);
    await after(r.data);
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
  const leave = async () => {
    clearTimeout(timer.current);
    if (q?.status === "active") {
      await queuesClient.pause(id);
      queueChanged();
    }
    router.push("/today");
  };

  // Keys (the plan's Interaction section): Enter sends, S skips, Y / N answer Sent?, P pauses, Esc leaves.
  const keys = useRef({ send, skip, answer, pause, resume, leave, phase, q });
  keys.current = { send, skip, answer, pause, resume, leave, phase, q };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (e.key === "Escape") {
        e.preventDefault();
        return void k.leave();
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
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
    <div className={s.scrim}>
      <motion.div
        className={s.run}
        role="dialog"
        aria-modal="true"
        aria-label="Send queue"
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={spring}
      >
        <header className={s.head}>
          <div className={s.title}>
            <span className={s.kicker}>Send queue</span>
            <span className={s.template}>{q?.templateName ?? (q ? "Your own words" : "")}</span>
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
            {q?.status === "active" && (
              <Button size="sm" variant="ghost" onClick={() => void pause()}>
                Pause
              </Button>
            )}
            <button type="button" className={s.close} aria-label="Leave the run" onClick={() => void leave()}>
              <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden>
                <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
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
        </header>

        <div className={s.stage}>
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          {!q ? null : over ? (
            <QueueSummary q={q} finishedHere={finishedHere} onDone={() => router.push("/today")} />
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
                  className={s.cardWrap}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, x: 64 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: skippedLeaving ? 0 : 0.4, x: -64 }}
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
                  />
                </motion.div>
              </AnimatePresence>
            )
          )}
        </div>
      </motion.div>
    </div>
  );
}
