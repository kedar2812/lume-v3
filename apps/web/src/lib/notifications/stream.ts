"use client";
import { useEffect, useRef } from "react";
import type { NotificationView } from "./client";
import { unreachable } from "@/lib/network/monitor";

type Listener = (n: NotificationView) => void;
const listeners = new Set<Listener>();
/** Told when leads changed somewhere (4B): no data, each asks for what it needs under its own access. */
const leadListeners = new Set<() => void>();
/**
 * A change in a LUME AI run (Autopilot A2): its run, lead and kind; the screen reads the rest under its own access. Run
 * "*" (kind "reconnected"): the stream was away, so any run may have changed.
 */
export type AutopilotEvent = { run: string; lead: string | null; kind: string };
const autopilotListeners = new Set<(e: AutopilotEvent) => void>();
/**
 * A WhatsApp message on a lead's chat (2026-11-01): in (with whose lead it is, when known), out, or a tick from LUME's
 * queue. Lead "*": the stream was away, so any chat may have changed.
 */
export type WhatsAppEvent = { lead: string; kind: "in" | "out" | "status" | "reconnected"; owner?: string };
const whatsappListeners = new Set<(e: WhatsAppEvent) => void>();
/** Instagram messages on leads' conversations (plan 2026-11-25-instagram-screens D2): the same shape as WhatsApp's. */
const instagramListeners = new Set<(e: WhatsAppEvent) => void>();
/** A live sheet's progress or status (2026-11-14). Sheet "*": the stream was away, so any sheet may have moved on. */
export type LiveSheetEvent = { sheet: string; kind: "progress" | "status" | "reconnected" };
const liveSheetListeners = new Set<(e: LiveSheetEvent) => void>();
/**
 * The person's unread count, as the server says it (2026-11-15): as the stream opens, and whenever something of theirs
 * is read anywhere. The bell takes this number; it never counts on its own.
 */
const unreadListeners = new Set<(unread: number) => void>();
/**
 * Team Chat (plan 2026-11-24-team-chat-2a): a change in a conversation, as its id and kind (the screen reads the rest
 * under its own access), or someone online or gone. Conversation "*" (kind "reconnected"): the stream was away.
 */
export type ChatEvent = {
  c?: string;
  e: string;
  m?: number;
  u?: string;
  /** A thread's: the message it hangs on; `f`: it's one they follow. */
  t?: number;
  f?: true;
  /** A direct message; a lead's thread. */
  d?: true;
  l?: true;
  /** Many are listening: reads this far apart at least (ms), each tab at a moment of its own. */
  w?: number;
};
const chatListeners = new Set<(e: ChatEvent) => void>();
export type PresenceEvent = { u: string; on: boolean };
const presenceListeners = new Set<(e: PresenceEvent) => void>();
const anyone = () =>
  listeners.size +
    leadListeners.size +
    autopilotListeners.size +
    whatsappListeners.size +
    instagramListeners.size +
    liveSheetListeners.size +
    chatListeners.size +
    presenceListeners.size +
    unreadListeners.size >
  0;
let source: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
/** Connected once already: an open after that is a reconnection, and leads may have changed meanwhile. */
let connectedBefore = false;
/**
 * Back after a drop, each tab catches up at a moment of its own within this long (owner 2026-11-06: a thousand people
 * at once): an update restarts LUME for everyone together, and a thousand tabs re-reading in the same instant would
 * queue behind each other on an API that has only just started.
 */
export const CATCH_UP_SPREAD_MS = 5000;
let catchUp: ReturnType<typeof setTimeout> | undefined;
function catchUpSoon() {
  catchUp ??= setTimeout(
    () => {
      catchUp = undefined;
      for (const l of leadListeners) l();
      // A run may have moved on meanwhile too: "*" is every run.
      for (const l of autopilotListeners) l({ run: "*", lead: null, kind: "reconnected" });
      for (const l of whatsappListeners) l({ lead: "*", kind: "reconnected" });
      for (const l of instagramListeners) l({ lead: "*", kind: "reconnected" });
      for (const l of liveSheetListeners) l({ sheet: "*", kind: "reconnected" });
      for (const l of chatListeners) l({ c: "*", e: "reconnected" });
    },
    Math.floor(Math.random() * CATCH_UP_SPREAD_MS),
  );
}
/** The last id seen, to resume from; and the ids already passed on (a replay overlaps; 3A final review). */
let lastId = 0;
const seen = new Set<number>();
const SEEN_MAX = 500;

function open() {
  if (typeof EventSource === "undefined") return;
  const s = new EventSource(lastId ? `/api/v1/stream?after=${lastId}` : "/api/v1/stream");
  source = s;
  // Back after a drop (the browser's own retry, or LUME's): what changed meanwhile was never said.
  s.addEventListener("open", () => {
    if (connectedBefore) catchUpSoon();
    connectedBefore = true;
    failures = 0;
  });
  s.addEventListener("leads", () => {
    failures = 0;
    for (const l of leadListeners) l();
  });
  s.addEventListener("autopilot", (e) => {
    let ev: Partial<AutopilotEvent>;
    try {
      ev = JSON.parse((e as MessageEvent<string>).data) as Partial<AutopilotEvent>;
    } catch {
      return;
    }
    if (typeof ev.run !== "string" || typeof ev.kind !== "string") return;
    failures = 0;
    const said: AutopilotEvent = {
      run: ev.run,
      lead: typeof ev.lead === "string" ? ev.lead : null,
      kind: ev.kind,
    };
    for (const l of autopilotListeners) l(said);
  });
  s.addEventListener("whatsapp", (e) => {
    let ev: Partial<WhatsAppEvent>;
    try {
      ev = JSON.parse((e as MessageEvent<string>).data) as Partial<WhatsAppEvent>;
    } catch {
      return;
    }
    if (typeof ev.lead !== "string" || (ev.kind !== "in" && ev.kind !== "out" && ev.kind !== "status"))
      return;
    failures = 0;
    const said: WhatsAppEvent = {
      lead: ev.lead,
      kind: ev.kind,
      ...(typeof ev.owner === "string" ? { owner: ev.owner } : {}),
    };
    for (const l of whatsappListeners) l(said);
  });
  s.addEventListener("instagram", (e) => {
    let ev: Partial<WhatsAppEvent>;
    try {
      ev = JSON.parse((e as MessageEvent<string>).data) as Partial<WhatsAppEvent>;
    } catch {
      return;
    }
    if (typeof ev.lead !== "string" || (ev.kind !== "in" && ev.kind !== "out" && ev.kind !== "status"))
      return;
    failures = 0;
    const said: WhatsAppEvent = {
      lead: ev.lead,
      kind: ev.kind,
      ...(typeof ev.owner === "string" ? { owner: ev.owner } : {}),
    };
    for (const l of instagramListeners) l(said);
  });
  s.addEventListener("unread", (e) => {
    let ev: { unread?: unknown };
    try {
      ev = JSON.parse((e as MessageEvent<string>).data) as { unread?: unknown };
    } catch {
      return;
    }
    if (typeof ev.unread !== "number" || !Number.isInteger(ev.unread) || ev.unread < 0) return;
    failures = 0;
    for (const l of unreadListeners) l(ev.unread as number);
  });
  s.addEventListener("live_sheet", (e) => {
    let ev: Partial<LiveSheetEvent>;
    try {
      ev = JSON.parse((e as MessageEvent<string>).data) as Partial<LiveSheetEvent>;
    } catch {
      return;
    }
    if (typeof ev.sheet !== "string" || (ev.kind !== "progress" && ev.kind !== "status")) return;
    failures = 0;
    const said: LiveSheetEvent = { sheet: ev.sheet, kind: ev.kind };
    for (const l of liveSheetListeners) l(said);
  });
  s.addEventListener("chat", (e) => {
    let ev: Partial<ChatEvent>;
    try {
      ev = JSON.parse((e as MessageEvent<string>).data) as Partial<ChatEvent>;
    } catch {
      return;
    }
    if (typeof ev.e !== "string" || (ev.c !== undefined && typeof ev.c !== "string")) return;
    failures = 0;
    const said: ChatEvent = {
      e: ev.e,
      ...(typeof ev.c === "string" ? { c: ev.c } : {}),
      ...(typeof ev.m === "number" ? { m: ev.m } : {}),
      ...(typeof ev.u === "string" ? { u: ev.u } : {}),
      ...(typeof ev.t === "number" ? { t: ev.t } : {}),
      ...(ev.f === true ? { f: true } : {}),
      ...(ev.d === true ? { d: true } : {}),
      ...(ev.l === true ? { l: true } : {}),
      ...(typeof ev.w === "number" && ev.w > 0 ? { w: ev.w } : {}),
    };
    for (const l of chatListeners) l(said);
  });
  s.addEventListener("presence", (e) => {
    let ev: Partial<PresenceEvent>;
    try {
      ev = JSON.parse((e as MessageEvent<string>).data) as Partial<PresenceEvent>;
    } catch {
      return;
    }
    if (typeof ev.u !== "string" || typeof ev.on !== "boolean") return;
    for (const l of presenceListeners) l({ u: ev.u, on: ev.on });
  });
  s.addEventListener("notification", (e) => {
    let n: NotificationView;
    try {
      n = JSON.parse((e as MessageEvent<string>).data) as NotificationView;
    } catch {
      return;
    }
    failures = 0;
    lastId = Math.max(lastId, n.id);
    if (seen.has(n.id)) return;
    seen.add(n.id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
    for (const l of listeners) l(n);
  });
  // The browser retries a dropped connection itself, but gives up for good on an error answer (a 502 while
  // the API restarts). Then LUME opens a new one, from where it was, backing off to 30 s (Important 4): half the
  // back-off, plus a share of the rest, so the tabs a restart dropped together don't all come back together.
  s.onerror = () => {
    // Dropped: the connection notice checks whether it's this device's connection (a restart still answers).
    if (source === s) unreachable();
    if (s.readyState !== EventSource.CLOSED || source !== s || !anyone()) return;
    clearTimeout(retry);
    const backOff = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
    retry = setTimeout(
      () => {
        if (source === s && anyone()) open();
      },
      backOff / 2 + Math.floor((Math.random() * backOff) / 2),
    );
  };
}

/**
 * One live stream per tab (Phase 3 spec §3 Live updates), shared by everything listening. Nothing missed
 * while offline is lost (it resumes from the last id), and nothing reaches a listener twice.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!source) open();
  return () => {
    listeners.delete(listener);
    closeIfUnused();
  };
}
function closeIfUnused() {
  if (anyone()) return;
  clearTimeout(retry);
  clearTimeout(catchUp);
  catchUp = undefined;
  source?.close();
  source = null;
}

/** Leads changed somewhere (4B): on the tab's one stream, shared with notifications. */
export function subscribeLeads(listener: () => void): () => void {
  leadListeners.add(listener);
  if (!source) open();
  return () => {
    leadListeners.delete(listener);
    closeIfUnused();
  };
}

/**
 * Calls `on` when leads change, so counts stay true without polling (spec §3 View counts). A hidden tab
 * doesn't ask; it asks once when it's shown again.
 */
export function useLeadsChanged(on: () => void): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => {
    let stale = false;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const off = subscribeLeads(() => (hidden() ? (stale = true) : latest.current()));
    const shown = () => {
      if (!hidden() && stale) {
        stale = false;
        latest.current();
      }
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      off();
      document.removeEventListener("visibilitychange", shown);
    };
  }, []);
}

/** Calls `on` for every notification that arrives while the component is mounted. */
export function useStream(on: Listener): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => subscribe((n) => latest.current(n)), []);
}

/** LUME AI's runs changing (Autopilot A2), on the tab's one stream. */
export function subscribeAutopilot(listener: (e: AutopilotEvent) => void): () => void {
  autopilotListeners.add(listener);
  if (!source) open();
  return () => {
    autopilotListeners.delete(listener);
    closeIfUnused();
  };
}

/** Calls `on` for each change in a LUME AI run while the component is mounted (the Autopilot page, A3). */
export function useAutopilot(on: (e: AutopilotEvent) => void): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => subscribeAutopilot((e) => latest.current(e)), []);
}

/** WhatsApp messages on leads' chats (2026-11-01), on the tab's one stream. */
export function subscribeWhatsApp(listener: (e: WhatsAppEvent) => void): () => void {
  whatsappListeners.add(listener);
  if (!source) open();
  return () => {
    whatsappListeners.delete(listener);
    closeIfUnused();
  };
}

/** Calls `on` for each WhatsApp message in, out or tick while the component is mounted: the chat, the owner's notice. */
export function useWhatsApp(on: (e: WhatsAppEvent) => void): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => subscribeWhatsApp((e) => latest.current(e)), []);
}

/** Instagram messages on leads' conversations (plan 2026-11-25-instagram-screens D2), on the tab's one stream. */
export function subscribeInstagram(listener: (e: WhatsAppEvent) => void): () => void {
  instagramListeners.add(listener);
  if (!source) open();
  return () => {
    instagramListeners.delete(listener);
    closeIfUnused();
  };
}

/** Calls `on` for each Instagram message in, out or tick while the component is mounted. */
export function useInstagram(on: (e: WhatsAppEvent) => void): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => subscribeInstagram((e) => latest.current(e)), []);
}

/** Live sheets' progress and status (2026-11-14), on the tab's one stream. */
export function subscribeLiveSheets(listener: (e: LiveSheetEvent) => void): () => void {
  liveSheetListeners.add(listener);
  if (!source) open();
  return () => {
    liveSheetListeners.delete(listener);
    closeIfUnused();
  };
}

/** Calls `on` for each live sheet's progress or status while the component is mounted. */
export function useLiveSheets(on: (e: LiveSheetEvent) => void): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => subscribeLiveSheets((e) => latest.current(e)), []);
}

/** The person's unread count whenever the server says it (2026-11-15), on the tab's one stream. */
export function subscribeUnread(listener: (unread: number) => void): () => void {
  unreadListeners.add(listener);
  if (!source) open();
  return () => {
    unreadListeners.delete(listener);
    closeIfUnused();
  };
}

/** Calls `on` with the unread count each time the server says it, while the component is mounted. */
export function useUnread(on: (unread: number) => void): void {
  const latest = useRef(on);
  latest.current = on;
  useEffect(() => subscribeUnread((n) => latest.current(n)), []);
}

/** Team Chat's changes, on the tab's one stream. */
export function subscribeChat(listener: (e: ChatEvent) => void): () => void {
  chatListeners.add(listener);
  if (!source) open();
  return () => {
    chatListeners.delete(listener);
    closeIfUnused();
  };
}
/** Someone coming online or going, on the tab's one stream. */
export function subscribePresence(listener: (e: PresenceEvent) => void): () => void {
  presenceListeners.add(listener);
  if (!source) open();
  return () => {
    presenceListeners.delete(listener);
    closeIfUnused();
  };
}
