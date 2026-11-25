"use client";
import { useEffect, useState } from "react";
import { subscribeChat } from "@/lib/notifications/stream";
import { chatClient } from "./client";
import { isViewing, onMuted } from "./viewing";

/** What can change one's own count in a way only the server can say. */
const ASKS = new Set(["deleted", "read", "members", "changed", "reconnected"]);
/** Soon after the first such change; then no closer together than this, at a moment of each tab's own. */
export const SOON_MS = 1500;
export const APART_MS = 10_000;
const SPREAD_MS = 5000;
/** What was counted here is checked with the server this long after (read up the page, or said twice). */
export const CHECK_MS = 60_000;

/**
 * Chat's unread count for the sidebar (spec: "Chat" with its unread count). A message is counted here as it's heard, so
 * a busy channel asks the server nothing; what can't be counted here (read in another tab, a lead's thread one may not
 * follow) is asked for, seldom. Muted conversations aren't in it, nor the one on screen.
 */
export function useChatUnread(on: boolean, me: string | undefined): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    let live = true;
    let timer: { t: ReturnType<typeof setTimeout>; at: number } | undefined;
    let last = 0;
    let muted: ReadonlySet<string> = new Set();
    const read = () => {
      last = Date.now();
      void chatClient.unread().then((r) => {
        if (!live) return;
        if (!r.ok) return later(CHECK_MS);
        muted = new Set(r.data.muted);
        setN(r.data.unread);
      });
    };
    /** In this long, unless it's sooner already. */
    const later = (ms: number) => {
      const at = Date.now() + ms;
      if (timer) {
        if (timer.at <= at) return;
        clearTimeout(timer.t);
      }
      const t = setTimeout(() => {
        timer = undefined;
        read();
      }, ms);
      timer = { t, at };
    };
    const ask = (away: boolean) => {
      const apart = last + APART_MS - Date.now();
      later(
        away || apart > SOON_MS ? Math.max(SOON_MS, apart) + Math.floor(Math.random() * SPREAD_MS) : SOON_MS,
      );
    };
    read();
    const offMuted = onMuted(() => ask(false));
    const off = subscribeChat((e) => {
      if (e.e === "message" && e.c && !e.l) {
        // One's own (from another tab) has read what came before it: the server says how much is left.
        if (e.u === me) return ask(false);
        if (!isViewing(e.c) && !muted.has(e.c)) setN((x) => x + 1);
        later(CHECK_MS + Math.floor(Math.random() * CHECK_MS));
      } else if (e.e === "message" || ASKS.has(e.e)) ask(e.c === "*");
    });
    return () => {
      live = false;
      clearTimeout(timer?.t);
      off();
      offMuted();
    };
  }, [on, me]);
  return n;
}
