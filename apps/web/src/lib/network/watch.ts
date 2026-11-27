/**
 * Whether the person's own connection is down or slow (the connection notice, canvas v14 approved 2026-11-26), from
 * each API answer's trip (the wait less LUME's own time) and the browser's online and offline signals. Pure: the
 * browser glue (monitor.ts) feeds it, ConnectionNotice shows it.
 */
export type NetState = "fine" | "offline" | "back" | "slow";

/** Over this long on the way, an answer was slow. */
export const SLOW_MS = 1500;
/** Slow when SLOW_OF of the last LAST answers were. */
export const LAST = 5;
export const SLOW_OF = 3;
/** Quick answers in a row that end a slow spell. */
export const QUICK_RUN = 5;
/** How long Back online shows. */
export const BACK_MS = 3000;
/** An answer LUME itself took this long on never counts: "LUME is answering fast" must be true. */
export const SERVER_FAST_MS = 1000;

export function createNetWatch(onChange?: (s: NetState) => void) {
  let state: NetState = "fine";
  let seenFirst = false;
  let last: boolean[] = [];
  let quick = 0;
  /** Put away while still slow: it stays away until the connection has been quick again. */
  let dismissed = false;
  let backTimer: ReturnType<typeof setTimeout> | undefined;
  const subs = new Set<(s: NetState) => void>();

  const set = (s: NetState) => {
    if (s === state) return;
    state = s;
    onChange?.(s);
    for (const f of subs) f(s);
  };
  const forget = () => {
    last = [];
    quick = 0;
    dismissed = false;
  };
  const clearBack = () => {
    clearTimeout(backTimer);
    backTimer = undefined;
  };

  return {
    /** One answer: how long it spent on the way, and how long LUME itself spent on it. */
    trip(netMs: number, serverMs: number) {
      // The first answer after opening LUME carries the cold start, whatever the connection.
      if (!seenFirst) return void (seenFirst = true);
      if (state === "offline") return;
      if (serverMs >= SERVER_FAST_MS) return;
      const slow = netMs > SLOW_MS;
      last = [...last, slow].slice(-LAST);
      quick = slow ? 0 : quick + 1;
      if (quick >= QUICK_RUN) {
        dismissed = false;
        last = [];
        if (state === "slow") set("fine");
        return;
      }
      if (state === "fine" && !dismissed && last.filter(Boolean).length >= SLOW_OF) set("slow");
    },
    offline() {
      clearBack();
      forget();
      set("offline");
    },
    online() {
      if (state !== "offline") return;
      set("back");
      // Cleared by a drop (offline), the only way out of Back online before it ends.
      backTimer = setTimeout(() => {
        backTimer = undefined;
        set("fine");
      }, BACK_MS);
    },
    dismiss() {
      if (state !== "slow") return;
      dismissed = true;
      set("fine");
    },
    state: () => state,
    subscribe(f: (s: NetState) => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    stop() {
      clearBack();
    },
  };
}

export type NetWatch = ReturnType<typeof createNetWatch>;
