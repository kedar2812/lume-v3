import type http from "node:http";

/** Bodies being read at once across the relay: past this, a sender is told to try again (Meta retries a 5xx). */
export const READING_MAX = 64;
/** A body still arriving after this long is cut off: a sender trickling bytes can't hold a place for minutes. */
export const BODY_DEADLINE_MS = 15_000;
let reading = 0;

/**
 * A request's body, at most `max` bytes (security review 2026-11-23): a declared length over it is refused before a
 * byte is kept; a body that grows past it is refused at once and the rest thrown away as it arrives (never held); and
 * at most READING_MAX bodies are held at a time, each for at most BODY_DEADLINE_MS, so a flood of large or slow
 * posts can't take the relay's memory or its places.
 */
export function readBody(
  req: http.IncomingMessage,
  max: number,
  deadlineMs = BODY_DEADLINE_MS,
): Promise<Buffer | "too_large" | "busy" | "slow"> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) {
    req.resume(); // read and dropped, so the refusal can still be said
    return Promise.resolve("too_large");
  }
  if (reading >= READING_MAX) return Promise.resolve("busy");
  reading++;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (v: Buffer | "too_large" | "slow") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reading--;
      resolve(v);
    };
    const timer = setTimeout(() => {
      chunks.length = 0;
      done("slow");
      req.destroy();
    }, deadlineMs);
    const take = (c: Buffer) => {
      size += c.length;
      if (size <= max) return void chunks.push(c);
      req.off("data", take);
      chunks.length = 0;
      req.resume(); // the rest is dropped as it arrives
      done("too_large");
    };
    req.on("data", take);
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", () => done("too_large"));
    req.on("close", () => done("too_large"));
  });
}

/** Says why a body wasn't taken: too big (413), too many at once (503, Meta tries again), too slow (408). */
export function refuseBody(res: http.ServerResponse, why: "too_large" | "busy" | "slow") {
  if (res.headersSent || res.destroyed) return;
  const [status, words] =
    why === "busy" ? [503, "Busy, try again"] : why === "slow" ? [408, "Too slow"] : [413, "Too large"];
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(words);
}
