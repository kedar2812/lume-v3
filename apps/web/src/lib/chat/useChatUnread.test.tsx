import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatClient } from "./client";
import { APART_MS, CHECK_MS, SOON_MS, useChatUnread } from "./useChatUnread";
import { setViewing, tellMuted } from "./viewing";

/** The sidebar's number (review 2, C1): counted here, asked for seldom, whatever a busy channel does. */
type E = { c?: string; e: string; m?: number; u?: string; l?: true };
const stream = vi.hoisted(() => ({ chat: new Set<(e: E) => void>() }));
vi.mock("@/lib/notifications/stream", () => ({
  subscribeChat: (l: never) => {
    stream.chat.add(l);
    return () => stream.chat.delete(l);
  },
}));
vi.mock("./client", () => ({ chatClient: { unread: vi.fn() } }));
const [ME, SANA, CH, QUIET] = ["me", "sana", "ch", "quiet"] as const;
const say = (e: E) => act(() => stream.chat.forEach((l) => l(e)));
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const server = (unread: number) =>
  vi
    .mocked(chatClient.unread)
    .mockResolvedValue({ ok: true, status: 200, data: { unread, muted: [QUIET] } } as never);
const start = async () => {
  const r = renderHook(() => useChatUnread(true, ME));
  await wait(0);
  return r.result;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setViewing(null);
  server(2);
});
afterEach(() => void vi.useRealTimers());

it("a hundred messages are counted without asking; muted, and the one on screen, aren't", async () => {
  const n = await start();
  expect(n.current).toBe(2);
  for (let i = 0; i < 100; i++) say({ c: CH, e: "message", m: i, u: SANA });
  expect(n.current).toBe(102);
  say({ c: QUIET, e: "message", m: 500, u: SANA });
  setViewing(CH);
  say({ c: CH, e: "message", m: 501, u: SANA });
  expect(n.current).toBe(102);
  await wait(CHECK_MS - 1000);
  expect(chatClient.unread).toHaveBeenCalledTimes(1);
  // Once in a while what was counted here is checked: nothing stays wrong.
  server(3);
  await wait(CHECK_MS + 1000);
  expect(n.current).toBe(3);
  expect(chatClient.unread).toHaveBeenCalledTimes(2);
});

it("what can't be counted here is asked for, soon and then seldom", async () => {
  const n = await start();
  await wait(APART_MS);
  server(7);
  // A lead's thread, which they may not follow, isn't counted: the server knows.
  say({ c: "lead", e: "message", m: 1, u: SANA, l: true });
  expect(n.current).toBe(2);
  await wait(SOON_MS);
  expect(n.current).toBe(7);
  for (let i = 0; i < 100; i++) {
    say({ c: CH, e: "read", m: i, u: ME });
    await wait(100);
  }
  expect(vi.mocked(chatClient.unread).mock.calls.length).toBeLessThanOrEqual(3);
  // Reactions, typing and other people's ticks ask nothing.
  await wait(60_000);
  vi.mocked(chatClient.unread).mockClear();
  for (const e of ["reaction", "typing", "delivered", "edited"]) say({ c: CH, e, m: 1, u: SANA });
  await wait(60_000);
  expect(chatClient.unread).not.toHaveBeenCalled();
  say({ c: CH, e: "message", m: 9, u: ME });
  await wait(SOON_MS);
  expect(chatClient.unread).toHaveBeenCalledTimes(1);
});

it("muting a conversation takes it out of the number soon", async () => {
  const n = await start();
  await wait(APART_MS);
  server(0);
  act(() => tellMuted());
  await wait(SOON_MS);
  expect(n.current).toBe(0);
});

it("a read that fails is tried again", async () => {
  vi.mocked(chatClient.unread).mockResolvedValueOnce({ ok: false, status: 503, message: "down" } as never);
  const n = await start();
  expect(n.current).toBe(0);
  await wait(CHECK_MS);
  expect(n.current).toBe(2);
});

it("a channel that never goes quiet still has its count checked", async () => {
  await start();
  for (let i = 0; i < 40; i++) {
    say({ c: CH, e: "message", m: i, u: SANA });
    await wait(CHECK_MS / 10);
  }
  // Four minutes of it: checked every one to two.
  expect(vi.mocked(chatClient.unread).mock.calls.length).toBeGreaterThanOrEqual(3);
});
