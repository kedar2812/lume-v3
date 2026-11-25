"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  chatClient,
  type ConvRow,
  type MemberMark,
  type MessagePage,
  type MessageView,
  type ThreadPage,
} from "@/lib/chat/client";
import { onLanded } from "@/lib/chat/outbox";
import { subscribeChat, type ChatEvent } from "@/lib/notifications/stream";
import { setViewing, threadKey } from "@/lib/chat/viewing";

const merge = (a: MessageView[], b: MessageView[]) => {
  const by = new Map(a.map((m) => [m.id, m]));
  for (const m of b) {
    // Whom it names who wasn't told is said once, to its sender: kept as it's read again.
    const told = m.notTold ?? by.get(m.id)?.notTold;
    by.set(m.id, told ? { ...m, notTold: told } : m);
  }
  return [...by.values()].sort((x, y) => x.id - y.id);
};
/** A quote of a deleted message says no words: not from a message already on screen either. */
const unquote = (ms: MessageView[], id: number) =>
  ms.map((m) => (m.replyTo?.id === id ? { ...m, replyTo: { ...m.replyTo, body: null } } : m));
/** At most this many pages to catch up with, or to reach the first unread: past it, the newest is shown afresh. */
const PAGES = 10;
/** Reads no closer together than this, however fast messages come; the stream asks for more room when many listen. */
export const CATCH_UP_MS = 1000;
/** A read mark is said at once, then at most this often: a direct message's sooner, as someone is watching for Seen. */
export const READ_MS = 3000;
const READ_DIRECT_MS = 1000;
const RETRY_MAX_MS = 30_000;
const hidden = () => document.visibilityState === "hidden";

/**
 * A conversation's messages as the server has them (plan 2026-11-24-team-chat-2a): the newest page, older ones as asked
 * for, and whatever lands or changes after. Events only say that something did; what did is read in one paced queue, so
 * a channel where messages pour in costs each tab about one read a second, and a tab nobody is looking at costs none.
 * With `root`, the thread on that message (2B) in just the same way: its first message and the replies to it.
 */
export function useMessages(
  conv: ConvRow,
  me: string,
  atBottom: RefObject<boolean>,
  root: number | null = null,
  /** Something lies over it: nothing in it is being looked at. */
  covered = false,
) {
  const { id, kind } = conv;
  /** What this is called in the tab: what it's sending, and that it's being looked at. */
  const key = root === null ? id : threadKey(root);
  /** A thread they follow or not; null until it's here, and in a conversation. */
  const [following, setFollowing] = useState<boolean | null>(null);
  const [msgs, show] = useState<MessageView[] | null>(null);
  const [older, setOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [members, setMembers] = useState<MemberMark[]>([]);
  const [readAt, setReadAt] = useState<number | null>(null);
  /** Why something pressed here couldn't be done. */
  const [said, setSaid] = useState<string | null>(null);
  /** Why the conversation isn't here (yet). */
  const [problem, setProblem] = useState<string | null>(null);
  /** The truth between renders; null until the first page is here. */
  const list = useRef<MessageView[] | null>(null);
  const live = useRef(true);
  const apply = useCallback((f: (ms: MessageView[]) => MessageView[]) => {
    if (!live.current || list.current === null) return;
    list.current = f(list.current);
    show(list.current);
  }, []);

  // ── What has been read ──────────────────────────────────────────────────────────────────────────────────────────
  const mark = useRef({ said: 0, seen: 0, at: 0, every: kind === "direct" ? READ_DIRECT_MS : READ_MS });
  const markTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sayRead = useCallback(() => {
    clearTimeout(markTimer.current);
    markTimer.current = undefined;
    const k = mark.current;
    if (k.seen <= k.said) return;
    const [upTo, before] = [k.seen, k.said];
    k.said = upTo;
    k.at = Date.now();
    void (root === null ? chatClient.read(id, upTo) : chatClient.readThread(root, upTo)).then((r) => {
      if (r.ok || k.said !== upTo) return;
      // Not said: again in a while, or as the next is seen.
      k.said = before;
      if (live.current) markTimer.current ??= setTimeout(sayRead, RETRY_MAX_MS / 3);
    });
  }, [id, root]);
  const over = useRef(covered);
  over.current = covered;
  /** What's on screen, at its newest, in a tab being looked at, is read. */
  const seen = useCallback(() => {
    const k = mark.current;
    const n = list.current?.at(-1)?.id ?? 0;
    if (!n || !atBottom.current || hidden() || over.current) return;
    k.seen = Math.max(k.seen, n);
    if (k.seen <= k.said || markTimer.current) return;
    const wait = k.at + k.every - Date.now();
    if (wait <= 0) sayRead();
    else markTimer.current = setTimeout(sayRead, wait);
  }, [atBottom, sayRead]);

  // ── Reading what landed or changed ──────────────────────────────────────────────────────────────────────────────
  /** Up to here nothing is missing: one's own message lands ahead of it, and so never counts. */
  const joined = useRef(0);
  /** The list was shown afresh: whatever was on its way for the one before is dropped. */
  const gen = useRef(0);
  const want = useRef<{ behind: boolean; changed: Set<number>; afresh: boolean }>({
    behind: false,
    changed: new Set(),
    afresh: false,
  });
  /** Pages on their way; what changes meanwhile may be in them as it was before, so it's read again after. */
  const coming = useRef(0);
  const late = useRef<{ changed: Set<number>; deleted: Set<number> }>({
    changed: new Set(),
    deleted: new Set(),
  });
  const pace = useRef({ last: 0, every: CATCH_UP_MS, spread: 0, fails: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const running = useRef(false);
  const loading = useRef(false);
  const missed = useRef(false);

  /** A page as asked for: null when it couldn't be had (said in words when it's worth saying). */
  const ask = useCallback(
    async (q?: { before?: number; after?: number }): Promise<{ page: MessagePage } | { why: string }> => {
      coming.current++;
      try {
        const r =
          root !== null
            ? await chatClient.thread(root, q ?? {})
            : q
              ? await chatClient.page(id, q)
              : await chatClient.page(id);
        if (!r.ok) return { why: r.message };
        // An answer that isn't one (a proxy's page): the same as none.
        if (!Array.isArray(r.data?.messages))
          return { why: "LUME couldn't read this conversation just now." };
        return { page: r.data };
      } catch {
        return { why: "LUME couldn't read this conversation just now." };
      } finally {
        coming.current--;
      }
    },
    [id, root],
  );
  /** A page has gone in: what changed while it was on its way is read again, and no quote keeps a deleted one's words. */
  const settle = useCallback(() => {
    for (const d of late.current.deleted) apply((ms) => unquote(ms, d));
    for (const n of late.current.changed) want.current.changed.add(n);
    if (coming.current === 0) late.current = { changed: new Set(), deleted: new Set() };
  }, [apply]);

  const namesMe = useCallback(
    (m: MessageView) =>
      m.authorId !== me && !!m.body && /<@(?:team:|channel>)/.test(m.body.replace(`<@${me}>`, "<@channel>")),
    [me],
  );
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  const pump = useCallback(() => {
    const w = want.current;
    if (timer.current || running.current || !live.current || list.current === null || hidden()) return;
    if (w.afresh) {
      w.afresh = false;
      void loadRef.current();
      return;
    }
    if (!w.behind && !w.changed.size) return;
    const p = pace.current;
    const wait = Math.max(0, p.last + p.every - Date.now()) + Math.floor(Math.random() * p.spread);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      running.current = true;
      p.last = Date.now();
      void (async () => {
        const behind = w.behind;
        const changed = [...w.changed].filter((n) => list.current?.some((m) => m.id === n));
        w.behind = false;
        w.changed.clear();
        const a = await readChanged(changed);
        const b = !behind || (await readAfter());
        running.current = false;
        if (a && b) p.fails = 0;
        else {
          if (!b) w.behind = true;
          if (!a) for (const n of changed) w.changed.add(n);
          p.fails++;
          p.last = Date.now() + Math.min(RETRY_MAX_MS, 1000 * 2 ** p.fails);
        }
        pump();
      })();
    }, wait);

    /** Those on screen that changed, read again where they are; one not on screen comes as it is when it's reached. */
    async function readChanged(ids: number[]): Promise<boolean> {
      const left = new Set(ids);
      let after = Math.min(...ids) - 1;
      for (let i = 0; left.size && i < PAGES; i++) {
        const r = await ask({ after });
        if (!live.current) return true;
        if ("why" in r) return false;
        const got = r.page.messages;
        // From one on screen up: never beside a gap.
        apply((ms) => merge(ms, got));
        // One that names me now (an edit): seen, and said again.
        if (got.some((m) => ids.includes(m.id) && namesMe(m)))
          mark.current.said = Math.min(mark.current.said, joined.current - 1);
        settle();
        if (!got.length || !r.page.more) return true;
        after = got.at(-1)!.id;
        for (const n of left) if (n <= after) left.delete(n);
        // Far apart: straight to the next of them.
        if (left.size) after = Math.max(after, Math.min(...left) - 1);
      }
      // Too many for one go: the rest in the next.
      for (const n of left) want.current.changed.add(n);
      return true;
    }
    /** Everything after what's whole, page by page; past ten pages, the newest afresh. */
    async function readAfter(): Promise<boolean> {
      const g = gen.current;
      let after = joined.current;
      for (let i = 0; i < PAGES; i++) {
        const r = await ask({ after });
        if (!live.current) return true;
        if ("why" in r) return false;
        if (g !== gen.current) {
          want.current.behind = true;
          return true;
        }
        const got = r.page.messages;
        // It names me, and I'm looking: said at once, so the bell never tells me of it.
        if (got.some(namesMe)) mark.current.at = 0;
        apply((ms) => merge(ms, got));
        settle();
        after = got.at(-1)?.id ?? after;
        joined.current = Math.max(joined.current, after);
        if (!r.page.more || !got.length) return true;
      }
      await loadRef.current();
      return true;
    }
  }, [apply, ask, settle, namesMe]);

  const again = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const loadFails = useRef(0);
  const load = useCallback(async () => {
    // One at a time; asked for meanwhile (a message landed), once more after.
    if (loading.current) {
      missed.current = true;
      return;
    }
    loading.current = true;
    clearTimeout(again.current);
    const r = await ask();
    loading.current = false;
    if (!live.current) return;
    if ("why" in r) {
      setProblem(r.why);
      // Tried again by itself, less often each time: nothing to press.
      again.current = setTimeout(
        () => void loadRef.current(),
        Math.min(RETRY_MAX_MS, 2000 * 2 ** loadFails.current++),
      );
      return;
    }
    loadFails.current = 0;
    const cur = list.current;
    const page = r.page.messages;
    // Back after a while: if the newest page doesn't reach what's whole on screen, it is shown afresh (never a gap).
    const joins = !!cur?.length && (page[0]?.id ?? 0) <= joined.current;
    if (joins) {
      // Further up, what changed while away is read again too.
      for (const m of cur) if (m.id < (page[0]?.id ?? 0)) want.current.changed.add(m.id);
      list.current = merge(cur, page);
    } else {
      gen.current++;
      list.current = page;
      joined.current = 0;
      setOlder(r.page.more);
    }
    joined.current = Math.max(joined.current, page.at(-1)?.id ?? 0);
    show(list.current);
    settle();
    setMembers(r.page.members);
    if (root !== null) setFollowing((r.page as ThreadPage).following);
    // Someone who keeps no place here (a lead's thread they only look at): nothing in it is "new".
    const at = r.page.lastReadId ?? Infinity;
    setReadAt((was) => was ?? at);
    // Looked at: said once even where nothing is new, for what the bell may still hold of it.
    mark.current.said = Math.max(mark.current.said, (r.page.lastReadId ?? 0) - 1);
    setProblem(null);
    if (missed.current) {
      missed.current = false;
      want.current.behind = true;
    }
    pump();
  }, [ask, settle, pump, root]);
  loadRef.current = load;

  useEffect(() => {
    live.current = true;
    void load();
    const k = mark;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
      timer.current = undefined;
      clearTimeout(again.current);
      // Seen and not said yet: said now.
      if (k.current.seen > k.current.said) sayRead();
      clearTimeout(markTimer.current);
      markTimer.current = undefined;
    };
  }, [load, sayRead]);

  /** Something landed after what's whole here: read when its turn comes. */
  const catchUp = useCallback(() => {
    if (list.current === null) missed.current = true;
    else {
      want.current.behind = true;
      pump();
    }
  }, [pump]);

  // One of this person's own, as the server kept it. Before the first page, that page is asked for instead.
  useEffect(
    () =>
      onLanded(key, (m) => {
        if (list.current === null) return void load();
        apply((ms) => merge(ms, [m]));
        // Anyone's that landed before it and wasn't heard yet.
        catchUp();
      }),
    [key, apply, catchUp, load],
  );

  /** One of them as it will be, at once (one's own reaction, edit or delete). */
  const change = useCallback(
    (mid: number, f: (m: MessageView) => MessageView) =>
      apply((ms) => ms.map((m) => (m.id === mid ? f(m) : m))),
    [apply],
  );
  /** One of them as the server has it, when its turn comes. */
  const recheck = useCallback(
    (mid: number) => {
      want.current.changed.add(mid);
      pump();
    },
    [pump],
  );

  /** One that may be on screen has changed, or a page on its way may have it as it was. */
  const changed = useCallback(
    (mid: number) => {
      if (coming.current > 0) late.current.changed.add(mid);
      if (list.current?.some((m) => m.id === mid)) recheck(mid);
    },
    [recheck],
  );

  /** A page further up; whether there's more above it. */
  const loadOlder = useCallback(
    async (about: () => void): Promise<boolean> => {
      const first = list.current?.[0]?.id;
      if (!first) return false;
      setLoadingOlder(true);
      setSaid(null);
      const r = await ask({ before: first });
      if (!live.current) return false;
      setLoadingOlder(false);
      // Shown afresh meanwhile: these no longer join up with what's on screen.
      if (list.current?.[0]?.id !== first) return false;
      if ("why" in r) {
        setSaid(r.why);
        return false;
      }
      about();
      apply((ms) => merge(r.page.messages, ms));
      settle();
      setOlder(r.page.more);
      pump();
      return r.page.more;
    },
    [ask, apply, settle, pump],
  );

  // Live: messages arrive, change, are received and read.
  useEffect(
    () =>
      subscribeChat((e: ChatEvent) => {
        if (e.c === "*") {
          // A tab nobody is looking at reads nothing: afresh when it's looked at.
          if (hidden() && list.current !== null) want.current.afresh = true;
          else void load();
          return;
        }
        if (e.c !== id) return;
        // A thread's: only what is said or read in it lands here. The conversation's: what isn't a thread's alone.
        const lands =
          root === null ? e.e === "message" : (e.e === "reply" || e.e === "message") && e.t === root;
        if (lands || e.w !== undefined) {
          const w = e.w ?? 0;
          pace.current.every = Math.max(CATCH_UP_MS, w);
          pace.current.spread = w / 2;
          mark.current.every = kind === "direct" ? READ_DIRECT_MS : Math.max(READ_MS, 3 * w);
        }
        if (e.e === "read" || e.e === "delivered") {
          if (root !== null || e.t !== undefined || !e.u || e.u === me || e.m === undefined) return;
          const upTo = e.m;
          const readToo = e.e === "read";
          setMembers((ms) =>
            ms.map((x) =>
              x.userId === e.u
                ? {
                    ...x,
                    lastReadId: readToo ? Math.max(x.lastReadId, upTo) : x.lastReadId,
                    lastDeliveredId: Math.max(x.lastDeliveredId, upTo),
                  }
                : x,
            ),
          );
          return;
        }
        // The message a thread hangs on says how many replies it has.
        if (root === null && e.t !== undefined) changed(e.t);
        if (lands && e.m) {
          if (list.current === null || e.m > joined.current) catchUp();
        } else if ((e.e === "edited" || e.e === "deleted" || e.e === "reaction") && e.m) {
          const mid = e.m;
          if (e.e === "deleted") {
            apply((ms) => unquote(ms, mid));
            if (coming.current > 0) late.current.deleted.add(mid);
          }
          changed(mid);
        }
      }),
    [id, kind, me, root, load, catchUp, apply, changed],
  );

  // Looked at again: what waited is read, and what's seen is said. Looked away: what was seen is said now.
  useEffect(() => {
    const on = () => {
      setViewing(key, !hidden() && !covered);
      if (hidden()) return sayRead();
      pump();
      seen();
    };
    on();
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    window.addEventListener("pagehide", sayRead);
    return () => {
      setViewing(key, false);
      document.removeEventListener("visibilitychange", on);
      window.removeEventListener("focus", on);
      window.removeEventListener("pagehide", sayRead);
    };
  }, [key, covered, pump, seen, sayRead]);
  useEffect(seen, [seen, msgs]);

  return {
    msgs,
    older,
    loadingOlder,
    members,
    readAt,
    following,
    setFollowing,
    said: said ?? problem,
    setSaid,
    seen,
    loadOlder,
    change,
    recheck,
    list,
    PAGES,
  };
}
