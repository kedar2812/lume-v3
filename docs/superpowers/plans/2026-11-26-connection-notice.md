# Connection notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** LUME says when the person's own connection is down or slow, so they never mistake their network for LUME lagging.

**Design (approved by the owner 2026-11-26):** canvas https://claude.ai/artifact/9Ni3YZh6VX6wBXqaaFKNsJ v14: one message at
the bottom centre, in LUME's own toast (the dark HUD): Offline (stays, wifi-off, reconnect dots), Slow (warn circle,
Dismiss), Back online (green tick, 3 s). No top-bar pill.

**Architecture:** the API stamps every answer with `Server-Timing: app;dur=<ms>` (its own time). The browser reads each
API fetch's Resource Timing entry: the wait from sending to the first byte minus LUME's own time is the trip. A pure
state machine (`lib/network/watch.ts`) turns trips and online/offline signals into one state; a browser glue
(`lib/network/monitor.ts`) feeds it; `ConnectionNotice` shows it inside the toast region.

## Global Constraints

- Copy, as approved: "You’re offline" / "LUME reconnects by itself the moment it’s back."; "Your internet is slow" /
  "LUME is answering fast. Your connection is taking longer." + Dismiss; "Back online".
- Offline: at once, from the browser's own signal, or a request or LUME's live stream failing and a check of
  `/healthz` failing too. Stays until the connection is back, then Back online for 3 s.
- Slow: 3 of the last 5 API answers spent over 1.5 s on the way; goes after 5 quick ones in a row, or with Dismiss.
- Never counts: uploads (XMLHttpRequest), file downloads (not API fetches), the live stream, a tab in the background
  (or an answer that started while it was), the first answer after opening LUME, an answer without LUME's timing
  (an edge error page). A slow LUME never blames the network.
- Icons from the registry (`components/ui/icons.tsx`); no em dashes; speaks as LUME.

## Edge-case sheet

| Input / condition | Expected |
|---|---|
| LUME restarting (edge answers 502) while the stream drops | `/healthz` answers (any status): not offline |
| Wi-Fi off | browser `offline` event: Offline at once; no probe needed |
| Captive/half-dead network: fetch throws, `navigator.onLine` true | probe fails (8 s cap): Offline; re-checked every 5 s |
| Back after offline | Back online 3 s, then nothing; old trips forgotten |
| Offline then slow trips arrive late | ignored while offline |
| Slow, then offline | Offline replaces Slow |
| Dismissed Slow, still slow | stays away until 5 quick in a row (no nagging), or until an offline/online cycle |
| Server slow AND network fine | trip = total − server ≈ small: nothing |
| Server slow (≥1 s) AND network slow | that answer doesn't count as slow ("LUME is answering fast" must be true) |
| Tab hidden, answers throttled | skipped; also an answer that started before the tab came back |
| First answer after opening | skipped (cold start) |
| Answer with no Server-Timing | skipped |
| Many API calls at once | Resource Timing measures from `requestStart`, so the browser's own queue doesn't count |
| Big response bodies | measured to the first byte: size never counts |
| No PerformanceObserver (old browser, tests) | slow never shows; offline still works |
| Screen readers | inside the toast region (`role=status`, polite): heard once |
| Reduced motion | appears without moving; dots still |
| Phone width | the toast's own max-width (100vw − 32px) |

## Review Focus

1. A LUME restart or deploy must never say "You're offline".
2. A long main-thread render must never read as a slow network (Resource Timing, not promise timing).
3. Dismiss must not come back on the next slow answer.
4. Timers (Back online, re-probe) cleared on unmount and on state change.
5. Offline must clear by itself once the connection is back, even with no `online` event.

---

### Task 1: The API's own time on every answer

**Files:** Modify `apps/api/src/server.ts`; Test `apps/api/src/server.test.ts`.
- [ ] Test: "every answer says how long LUME spent on it": `GET /healthz` has `server-timing` matching
  `/^app;dur=\d+(\.\d)?$/`; a 404 has it too.
- [ ] Implement: `onRequest` keeps `performance.now()` per request, `onSend` sets `server-timing: app;dur=<1 dp>`.

### Task 2: The state machine

**Files:** Create `apps/web/src/lib/network/watch.ts`, test `watch.test.ts`.
**Interfaces:** `createNetWatch(onChange: (s: NetState) => void, opts?: { setTimer, clearTimer })` →
`{ trip(netMs: number, serverMs: number), offline(), online(), dismiss(), state(), stop() }`;
`type NetState = "fine" | "offline" | "back" | "slow"`; constants `SLOW_MS=1500`, `LAST=5`, `SLOW_OF=3`, `QUICK_RUN=5`,
`BACK_MS=3000`, `SERVER_FAST_MS=1000`.
- [ ] Tests: first trip skipped; 3 of 5 slow → slow; 2 of 5 → fine; 5 quick in a row clears; dismiss stays away until
  5 quick; offline at once and ignores trips; online → back → fine after 3 s; offline replaces slow; slow server trips
  don't count; online while not offline does nothing; stop clears timers.

### Task 3: The browser glue

**Files:** Create `apps/web/src/lib/network/monitor.ts`, test `monitor.test.ts`; Modify `apps/web/src/lib/api.ts` (a
failed fetch reports `unreachable()`), `apps/web/src/lib/notifications/stream.ts` (stream error reports it).
**Interfaces:** `startNetMonitor(watch)` → stop fn; `unreachable()`; `tripOf(entry, visibleSince)` → `{net, server} | null`.
- [ ] Tests: `tripOf` skips non-fetch, non-API, the stream, no timing, started before visible; computes
  responseStart − requestStart − dur. Probe: fetch throws → offline, any answer → online when offline; re-probe every 5 s
  while offline; browser offline/online events.

### Task 4: The notice

**Files:** Create `apps/web/src/components/feedback/ConnectionNotice.tsx`; Modify `ToastProvider.tsx` (first child
of the region), `Toast.module.css`, `components/ui/icons.tsx` (`offline: WifiOff`, `slowNetwork: WifiLow`).
- [ ] Tests (`ConnectionNotice.test.tsx`): each state's words; Dismiss hides slow; nothing when fine.
