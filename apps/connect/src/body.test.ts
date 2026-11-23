import type http from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { READING_MAX, readBody } from "./body";

/** A request as the server hands it over: a stream with headers. */
const request = (headers: Record<string, string> = {}) => {
  const s = new PassThrough() as unknown as http.IncomingMessage & PassThrough;
  s.headers = headers;
  return s;
};

describe("the relay reads at most so much, from at most so many at once (security review 2026-11-23)", () => {
  it("a body within the limit, whole", async () => {
    const r = request();
    const got = readBody(r, 10);
    r.end(Buffer.from("0123456789"));
    expect(((await got) as Buffer).toString()).toBe("0123456789");
  });

  it("a declared length over the limit is refused before anything is kept", async () => {
    const r = request({ "content-length": "11" });
    expect(await readBody(r, 10)).toBe("too_large");
    expect(r.listenerCount("data")).toBe(0);
  });

  it("a body that grows past the limit is refused at once, its rest dropped as it comes", async () => {
    const r = request();
    const got = readBody(r, 10);
    r.write(Buffer.alloc(8));
    r.write(Buffer.alloc(8));
    expect(await got).toBe("too_large");
    expect(r.listenerCount("data")).toBe(0);
    r.end(Buffer.alloc(1024));
  });

  it("a body still coming after its deadline is cut off, and its place freed", async () => {
    const slow = request();
    const destroyed: boolean[] = [];
    (slow as unknown as { destroy(): void }).destroy = () => void destroyed.push(true);
    const got = readBody(slow, 10, 30);
    slow.write(Buffer.from("x"));
    expect(await got).toBe("slow");
    expect(destroyed).toEqual([true]);
    const open = Array.from({ length: READING_MAX }, () => request());
    const reads = open.map((r) => readBody(r, 10));
    for (const r of open) r.end();
    await Promise.all(reads);
  });

  it("past so many at once, the next is told to come back; room again once one ends", async () => {
    const open = Array.from({ length: READING_MAX }, () => request());
    const reads = open.map((r) => readBody(r, 10));
    expect(await readBody(request(), 10)).toBe("busy");
    open[0]!.end(Buffer.from("x"));
    await reads[0];
    const next = request();
    const got = readBody(next, 10);
    next.end(Buffer.from("y"));
    expect(((await got) as Buffer).toString()).toBe("y");
    for (const r of open.slice(1)) r.end();
    await Promise.all(reads);
  });
});
