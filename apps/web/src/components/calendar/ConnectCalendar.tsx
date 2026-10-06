"use client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Odometer } from "@/components/ui/Odometer";
import { GoogleDataNote, LUME_PRIVACY_URL } from "@/components/integrations/GoogleDataNote";
import { calendarClient } from "@/lib/calendar/client";
import { safeNext } from "@/lib/safe-next";
import s from "./connect.module.css";

/** Where connecting began (the Calendar page or Settings → Calendar), kept for the hand-back. */
export const RETURN_KEY = "lume:calendar:return";

/** wait: the Google tile lifts and the wire runs; linked: the wire is solid and the tiles click together. */
type Phase = "idle" | "wait" | "linked" | "reading" | "done";

const PROMISES = [
  {
    icon: "people",
    title: "Only meetings with your leads.",
    body: "An attendee who is a lead makes it a meeting.",
  },
  {
    icon: "eye-off",
    title: "Personal events are never kept.",
    body: "LUME reads them only to find meetings with leads.",
  },
  { icon: "lock", title: "Read-only.", body: "LUME never changes your calendar." },
] as const;

const ICONS: Record<(typeof PROMISES)[number]["icon"], string> = {
  people:
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3",
  "eye-off":
    "M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.7M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7c1.7 0 3.2-.5 4.5-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
};

function Tiles({ phase, reduce }: { phase: Phase; reduce: boolean }) {
  const linked = phase === "linked" || phase === "reading" || phase === "done";
  return (
    <div className={s.tiles} data-phase={phase} aria-hidden>
      <motion.span
        className={s.tile}
        animate={reduce ? {} : { y: phase === "wait" ? -6 : 0, x: linked ? 18 : 0 }}
        transition={{ type: "spring", bounce: linked ? 0.3 : 0, duration: 0.5 }}
      >
        <img src="/brand/google-calendar.png" alt="" width={32} height={32} />
      </motion.span>
      <span className={s.wire} data-running={phase === "wait" || undefined} data-solid={linked || undefined}>
        {phase === "reading" &&
          !reduce &&
          [0, 1, 2, 3].map((i) => <i key={i} className={s.glyph} style={{ ["--i" as string]: i }} />)}
      </span>
      <motion.span
        className={s.tile}
        animate={reduce ? {} : { x: linked ? -18 : 0 }}
        transition={{ type: "spring", bounce: 0.3, duration: 0.5 }}
      >
        <img src="/lume-mark.png" alt="" width={30} height={30} />
      </motion.span>
      <AnimatePresence>
        {linked && (
          <motion.span
            className={s.tick}
            initial={reduce ? { opacity: 0 } : { scale: 0.3, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", bounce: 0.4, duration: 0.5 }}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
              <path
                d="M5.5 12.5 10 17l8.5-9.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function GoogleButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button type="button" className={s.gbtn} aria-busy={busy || undefined} disabled={busy} onClick={onClick}>
      <img src="/brand/google-g.png" alt="" width={18} height={18} />
      Continue with Google
    </button>
  );
}

/**
 * Connecting a calendar (canvas CalendarEmpty, Connect): the Google Calendar tile, a wire and the LUME
 * tile; three plain promises; Continue with Google in Google's own button style. Off, or not this person's
 * to connect, it says so instead, and never offers a dead button.
 */
export function ConnectCalendar({
  state,
  admin,
  compact = false,
}: {
  state: "connect" | "off" | "unavailable" | "noPermission";
  /** Calendly is set up by an admin (integrations.manage). */
  admin: boolean;
  /** Above an agenda that already has meetings: one row, not the card. */
  compact?: boolean;
}) {
  const reduce = !!useReducedMotion();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  if (state === "noPermission")
    return (
      <p className={s.note}>
        Your role doesn&apos;t connect a calendar. Meetings others bring still show here.
      </p>
    );
  if (state === "off" || state === "unavailable")
    return (
      <p className={s.note}>
        {state === "off"
          ? "Google Calendar is off. An admin can switch Google Calendar on in Settings → Integrations."
          : "Google Calendar comes through Connect with Google, which isn't set up on this server yet."}
        {admin && state === "off" && (
          <>
            {" "}
            <Link href="/settings/integrations">Open Integrations</Link>
          </>
        )}
      </p>
    );

  const go = async () => {
    setError(null);
    setPhase("wait");
    try {
      sessionStorage.setItem(RETURN_KEY, window.location.pathname);
    } catch {
      // No storage (a private window): the hand-back returns to the Calendar.
    }
    const r = await calendarClient.connect();
    if (!r.ok) {
      setPhase("idle");
      return setError(r.message);
    }
    window.location.assign(r.data.url);
  };

  if (compact)
    return (
      <div className={s.row}>
        <span className={s.rowTile}>
          <img src="/brand/google-calendar.png" alt="" width={20} height={20} />
        </span>
        <span>
          <b>Bring your calls into LUME.</b> Only meetings with your leads; read-only.{" "}
          <a href={LUME_PRIVACY_URL} target="_blank" rel="noopener noreferrer">
            How LUME uses Google data
          </a>
        </span>
        {error && (
          <span role="alert" className={s.err}>
            {error}
          </span>
        )}
        <GoogleButton busy={phase === "wait"} onClick={() => void go()} />
      </div>
    );

  return (
    <div className={s.card}>
      <Tiles phase={phase} reduce={reduce} />
      <h2 className={s.title}>Bring your calls into LUME</h2>
      <ul className={s.promises}>
        {PROMISES.map((p) => (
          <li key={p.icon}>
            <span className={s.picon}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d={ICONS[p.icon]} />
              </svg>
            </span>
            <span>
              <b>{p.title}</b> {p.body}
            </span>
          </li>
        ))}
      </ul>
      {error ? (
        <div className={s.errBox}>
          <p role="alert">{error}</p>
          <button type="button" className={s.again} onClick={() => void go()}>
            Try again
          </button>
        </div>
      ) : (
        <GoogleButton busy={phase === "wait"} onClick={() => void go()} />
      )}
      <GoogleDataNote what="LUME asks Google to read events on calendars you own, read-only, and the list of your calendars so you can choose which ones." />
      {admin && (
        <div className={s.calendly}>
          <img src="/brand/calendly.svg" alt="" width={28} height={28} />
          <span>
            <b>Booking calls with Calendly?</b>
            <small>Bookings can arrive on their own, too.</small>
          </span>
          <Link href="/settings/integrations/calendly">Set up Calendly</Link>
        </div>
      )}
    </div>
  );
}

const POLL_MS = 1200;
const READ_FOR_MS = 20_000;

/**
 * Back from Google (`/calendar/connected?p=&s=`): the hand-back is completed once, the tiles click
 * together, LUME reads the calendar (the count climbs as it lands), then it returns to where connecting
 * began, a plain in-app path or the Calendar. A refusal is said on the card, with Try again.
 */
export function CalendarConnected() {
  const params = useSearchParams();
  const router = useRouter();
  const reduce = !!useReducedMotion();
  const [phase, setPhase] = useState<Phase>("wait");
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  // Alive for the page's life, not the effect's: a re-render mustn't cancel the hand-back halfway.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const p = params.get("p");
    const sig = params.get("s");
    let back = "/calendar";
    try {
      back = safeNext(sessionStorage.getItem(RETURN_KEY) ?? undefined);
      if (back === "/today") back = "/calendar";
      sessionStorage.removeItem(RETURN_KEY);
    } catch {
      // no storage: the Calendar
    }
    if (!p || !sig) return setError("This page is for coming back from Google. Start from the Calendar.");
    void (async () => {
      const r = await calendarClient.complete({ p, s: sig });
      // The hand-back is single-use: take it out of the address so a reload doesn't try to spend it again.
      window.history.replaceState?.(null, "", window.location.pathname);
      if (!r.ok) return setError(r.message);
      setPhase("linked");
      await new Promise((res) => setTimeout(res, reduce ? 0 : 700));
      setPhase("reading");
      const until = Date.now() + READ_FOR_MS;
      while (alive.current && Date.now() < until) {
        const c = await calendarClient.connection();
        // Nothing to wait for (a refusal, or no connection after all): go back now.
        if (!c.ok || !c.data.connected) break;
        if (c.data.lastSync) {
          setCount(c.data.lastSync.added);
          break;
        }
        await new Promise((res) => setTimeout(res, POLL_MS));
      }
      setPhase("done");
      await new Promise((res) => setTimeout(res, reduce ? 0 : 900));
      if (alive.current) router.replace(back);
    })();
  }, [params, router, reduce]);

  const again = async () => {
    const r = await calendarClient.connect();
    if (r.ok) window.location.assign(r.data.url);
    else setError(r.message);
  };

  return (
    <div className={s.card} data-done={phase === "done" || undefined}>
      <Tiles phase={error ? "idle" : phase} reduce={reduce} />
      {error ? (
        <>
          <h2 className={s.title}>LUME couldn&apos;t connect your calendar</h2>
          <div className={s.errBox}>
            <p role="alert">{error}</p>
            <button type="button" className={s.again} onClick={() => void again()}>
              Try again
            </button>
          </div>
        </>
      ) : (
        <>
          <h2 className={s.title}>
            {phase === "wait"
              ? "Connecting your calendar…"
              : phase === "linked"
                ? "Connected"
                : "Reading your calendar"}
          </h2>
          <p className={s.sub} role="status" aria-live="polite">
            {phase === "reading" || phase === "done" ? (
              <>
                <Odometer value={count} /> {count === 1 ? "meeting with a lead" : "meetings with leads"}
              </>
            ) : (
              "Only meetings with your leads come into LUME."
            )}
          </p>
        </>
      )}
    </div>
  );
}
