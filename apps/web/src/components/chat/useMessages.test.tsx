import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatClient, type MessageView } from "@/lib/chat/client";
import { sendInto } from "@/lib/chat/outbox";
import { useMessages } from "./useMessages";

/** A conversation's messages, with more of them than a screen's test would draw (review 3). */
type E = { c?: string; e: string; m?: number; u?: string };
const stream = vi.hoisted(() => ({ chat: new Set<(e: E) => void>() }));
vi.mock("@/lib/notifications/stream", () => ({
  subscribeChat: (l: never) => {
    stream.chat.add(l);
    return () => stream.chat.delete(l);
  },
}));
vi.mock("@/lib/chat/client", () => ({ chatClient: { page: vi.fn(), read: vi.fn(), send: vi.fn() } }));
const conv = {
  id: "c",
  kind: "channel",
  name: "x",
  topic: null,
  unread: 0,
  muted: false,
  lastAt: null,
} as const;
const say = (e: E) => act(() => stream.chat.forEach((l) => l(e)));
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

/** Every message from 1 to `last`, fifty at a time; `gone` ones say nothing. */
const o = { last: 0, gone: new Set<number>(), asked: 0, slow: 0, fail: 0 };
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(o, { last: 1200, gone: new Set<number>(), asked: 0, slow: 0, fail: 0 });
  vi.mocked(chatClient.read).mockResolvedValue({ ok: true, status: 204, data: undefined } as never);
  vi.mocked(chatClient.page).mockImplementation(async (_c, q) => {
    o.asked++;
    if (o.slow) await new Promise((r) => setTimeout(r, o.slow));
    if (o.fail > 0) {
      o.fail--;
      return { ok: false, status: 503, message: "down" } as never;
    }
    const all = Array.from({ length: o.last }, (_, i) => i + 1);
    const got =
      q?.after !== undefined
        ? all.filter((n) => n > q.after!)
        : all.filter((n) => n < (q?.before ?? Infinity));
    const ids = q?.after !== undefined ? got.slice(0, 50) : got.slice(-50);
    return {
      ok: true,
      status: 200,
      data: {
        messages: ids.map(
          (n) =>
            ({
              id: n,
              authorId: "a",
              clientId: null,
              body: o.gone.has(n) ? null : `n${n}`,
              replyTo: null,
            }) as MessageView,
        ),
        more: got.length > 50,
        lastReadId: 0,
        members: [],
      },
    } as never;
  });
});
afterEach(() => void vi.useRealTimers());

it("changes far apart are all read, however many pages are between, and after a drop every one is", async () => {
  const { result } = renderHook(() => useMessages(conv as never, "me", { current: true }));
  await wait(10);
  for (let i = 0; i < 23; i++) await act(async () => void (await result.current.loadOlder(() => undefined)));
  const ids = result.current.msgs!.map((m) => m.id);
  expect(ids).toEqual(Array.from({ length: 1200 }, (_, i) => i + 1));
  const words = (n: number) => result.current.msgs![n - 1]!.body;
  for (const n of [3, 640, 1199]) {
    o.gone.add(n);
    say({ c: "c", e: "deleted", m: n });
  }
  o.asked = 0;
  await wait(10_000);
  expect([3, 640, 1199].map(words)).toEqual([null, null, null]);
  // Straight to each of them, not through everything between.
  expect(o.asked).toBeLessThanOrEqual(4);
  o.gone.add(500).add(900);
  say({ c: "*", e: "reconnected" });
  await wait(30_000);
  expect([500, 900].map(words)).toEqual([null, null]);
});

it("more than ten pages missed while catching up: the newest afresh, whole, with the rest above it", async () => {
  o.last = 10;
  const { result } = renderHook(() => useMessages(conv as never, "me", { current: true }));
  await wait(10);
  o.last = 2000;
  say({ c: "c", e: "message", m: 2000, u: "a" });
  await wait(30_000);
  const ids = result.current.msgs!.map((m) => m.id);
  expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => ids[0]! + i));
  expect(ids.at(-1)).toBe(2000);
  expect(result.current.older).toBe(true);
});

const whole = (ms: MessageView[] | null) => {
  const ids = ms!.map((m) => m.id);
  expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => ids[0]! + i));
  return ids;
};
/** One's own message, as the server keeps it: the newest. */
const send = () => {
  vi.mocked(chatClient.send).mockImplementation(async () => {
    const id = ++o.last;
    return {
      ok: true,
      status: 201,
      data: { id, authorId: "me", clientId: null, body: `n${id}`, replyTo: null },
    } as never;
  });
  act(() => sendInto({ conv: "c" }, "me", { body: "x", replyTo: null, files: [] }));
};

it("a send in the middle of catching up with more than ten pages leaves no hole", async () => {
  o.last = 10;
  const { result } = renderHook(() => useMessages(conv as never, "me", { current: true }));
  await wait(10);
  o.last = 1000;
  o.slow = 50;
  say({ c: "c", e: "message", m: 1000, u: "a" });
  await wait(130);
  send();
  await wait(20);
  expect(result.current.msgs!.at(-1)!.id).toBe(1001);
  await wait(30_000);
  expect(whole(result.current.msgs).at(-1)).toBe(1001);
});

it("shown afresh while a catch-up is on its way: what it brings is dropped, and no hole", async () => {
  o.last = 10;
  const { result } = renderHook(() => useMessages(conv as never, "me", { current: true }));
  await wait(10);
  o.last = 1000;
  o.slow = 100;
  say({ c: "c", e: "message", m: 1000, u: "a" });
  await wait(50);
  say({ c: "*", e: "reconnected" });
  await wait(30_000);
  expect(whole(result.current.msgs).at(-1)).toBe(1000);
});

it("one's own message brings anyone's that landed before it and was never heard", async () => {
  o.last = 10;
  const { result } = renderHook(() => useMessages(conv as never, "me", { current: true }));
  await wait(10);
  o.last = 14;
  send();
  await wait(5000);
  expect(whole(result.current.msgs).at(-1)).toBe(15);
});

it("a change that couldn't be read is read later", async () => {
  o.last = 10;
  const { result } = renderHook(() => useMessages(conv as never, "me", { current: true }));
  await wait(10);
  o.gone.add(5);
  o.fail = 1;
  say({ c: "c", e: "deleted", m: 5 });
  await wait(6000);
  expect(result.current.msgs!.find((m) => m.id === 5)!.body).toBeNull();
});
