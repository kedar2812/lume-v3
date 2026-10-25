import { describe, expect, it, vi } from "vitest";
import type { LibraryFile } from "@/lib/files/client";
import { DONE_SHOW_MS, batchOf, createUploads, type Send } from "./uploads";

/**
 * Files on their way into Media (owner, 2026-10-25): kept by LUME, not by the Media screen, so leaving it doesn't stop
 * them; the whole batch's progress counted by bytes, for the tray's bar and the sidebar's ring.
 */
const file = (name: string, size = 100) => new File([new Uint8Array(size)], name);
const lib = (name: string) => ({ id: `id-${name}`, name }) as LibraryFile;

/** A send whose every file waits until the test says how it went. */
function held() {
  const calls: { name: string; progress(s: number): void; ok(): void; refuse(m: string): void }[] = [];
  const send: Send = (f, onProgress) =>
    new Promise((resolve) =>
      calls.push({
        name: f.name,
        progress: onProgress,
        ok: () => resolve({ ok: true, data: { file: lib(f.name) } }),
        refuse: (message) => resolve({ ok: false, message }),
      }),
    );
  return { calls, send };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the uploads", () => {
  it("go up three at a time, in the order they were given", async () => {
    const h = held();
    const u = createUploads(h.send);
    u.add(["a", "b", "c", "d", "e"].map((n) => file(n)));
    expect(h.calls.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(u.snapshot().uploads.map((x) => x.state)).toEqual([
      "uploading",
      "uploading",
      "uploading",
      "waiting",
      "waiting",
    ]);
    h.calls[1]!.ok();
    await flush();
    expect(h.calls.map((c) => c.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("an added file reaches whoever listens, and is kept for a screen that opens later", async () => {
    const h = held();
    const u = createUploads(h.send);
    const heard = vi.fn();
    const stop = u.onAdded(heard);
    u.add([file("a"), file("b")]);
    h.calls[0]!.ok();
    await flush();
    expect(heard).toHaveBeenCalledWith(lib("a"));
    stop();
    // Media closed: the other file still goes up, and Media opening again finds it, once (a file archived since
    // must not come back on the next visit).
    h.calls[1]!.ok();
    await flush();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(u.take().map((f) => f.name)).toEqual(["b"]);
    expect(u.take()).toEqual([]);
  });

  it("a refused file keeps LUME's reason until it's dismissed; the rest carry on", async () => {
    const h = held();
    const u = createUploads(h.send);
    u.add([file("a"), file("b")]);
    h.calls[0]!.refuse("Photos can be up to 20 MB.");
    h.calls[1]!.ok();
    await flush();
    const a = u.snapshot().uploads.find((x) => x.name === "a")!;
    expect(a).toMatchObject({ state: "refused", problem: "Photos can be up to 20 MB." });
    u.dismiss(a.key);
    expect(u.snapshot().uploads.find((x) => x.name === "a")).toBeUndefined();
  });

  it("says when something is still going up, so closing the tab can ask first", async () => {
    const h = held();
    const u = createUploads(h.send);
    expect(u.busy()).toBe(false);
    u.add([file("a")]);
    expect(u.busy()).toBe(true);
    h.calls[0]!.ok();
    await flush();
    expect(u.busy()).toBe(false);
  });
});

describe("the batch", () => {
  it("is counted by bytes: a big file half up is most of the way", async () => {
    const h = held();
    const u = createUploads(h.send);
    u.add([file("big", 900), file("small", 100)]);
    h.calls[0]!.progress(0.5);
    h.calls[1]!.progress(1);
    expect(batchOf(u.snapshot())).toMatchObject({ total: 2, added: 0, share: 0.55, done: false });
  });

  it("leaves a refused file out, so the bar never waits at 99% for it", async () => {
    const h = held();
    const u = createUploads(h.send);
    u.add([file("a", 100), file("b", 100)]);
    h.calls[0]!.refuse("No");
    h.calls[1]!.ok();
    await flush();
    expect(batchOf(u.snapshot())).toMatchObject({ total: 1, added: 1, share: 1, done: true });
  });

  it("keeps files that have left the tray, until a new batch starts", async () => {
    vi.useFakeTimers();
    try {
      const h = held();
      const u = createUploads(h.send);
      u.add([file("a"), file("b")]);
      h.calls[0]!.ok();
      await vi.advanceTimersByTimeAsync(5000);
      // a's tick has gone from the tray, but it is still one of the batch's two.
      expect(u.snapshot().uploads.map((x) => x.name)).toEqual(["b"]);
      expect(batchOf(u.snapshot())).toMatchObject({ total: 2, added: 1, done: false });
      h.calls[1]!.ok();
      await vi.advanceTimersByTimeAsync(0);
      expect(batchOf(u.snapshot())).toMatchObject({ total: 2, added: 2, share: 1, done: true });
      // Done, then more files: a new batch, counted from nothing.
      u.add([file("c")]);
      expect(batchOf(u.snapshot())).toMatchObject({ total: 1, added: 0, done: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("done, it stays long enough for the tick and the blinks, then goes", async () => {
    vi.useFakeTimers();
    try {
      const h = held();
      const u = createUploads(h.send);
      u.add([file("a")]);
      h.calls[0]!.ok();
      await vi.advanceTimersByTimeAsync(DONE_SHOW_MS - 100);
      expect(batchOf(u.snapshot())).toMatchObject({ done: true });
      await vi.advanceTimersByTimeAsync(200);
      expect(batchOf(u.snapshot())).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is nothing when nothing has been given, or everything given was refused", async () => {
    const h = held();
    const u = createUploads(h.send);
    expect(batchOf(u.snapshot())).toBeNull();
    u.add([file("a")]);
    h.calls[0]!.refuse("No");
    await flush();
    expect(batchOf(u.snapshot())).toBeNull();
  });
});
