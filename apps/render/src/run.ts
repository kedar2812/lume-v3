import { spawn } from "node:child_process";

/** A file LUME's tools couldn't render within their limits (422), or a request they won't take. */
export class RenderError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

export type RunOptions = {
  cwd: string;
  seconds: number;
  /** The tool's whole environment: nothing of the service's own is passed on. */
  env?: Record<string, string>;
  /** The most it may print before it's stopped. */
  maxOut?: number;
  onStdout?: (chunk: Buffer) => void;
};

/**
 * One tool, run in its own process group so a time limit stops it and everything it started (LibreOffice starts a
 * second process; ffmpeg can start threads that outlive a plain kill). What it printed comes back; a non-zero exit,
 * a run past its time or too much output is a RenderError with the tool's last words.
 */
export function run(cmd: string, args: string[], o: RunOptions): Promise<Buffer> {
  const maxOut = o.maxOut ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", ...o.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let outSize = 0;
    let err = "";
    let why: string | null = null;
    const stop = (reason: string) => {
      if (why) return;
      why = reason;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => stop(`${cmd} took longer than ${o.seconds} s`), o.seconds * 1000);
    child.stdout.on("data", (b: Buffer) => {
      outSize += b.length;
      if (outSize > maxOut) return stop(`${cmd} printed too much`);
      out.push(b);
      o.onStdout?.(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      err = (err + b.toString()).slice(-2000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new RenderError(`${cmd} couldn't start: ${e.message}`, 500));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (why) return reject(new RenderError(why));
      if (code !== 0) return reject(new RenderError(`${cmd} failed (${code}): ${err.trim().slice(-400)}`));
      resolve(Buffer.concat(out));
    });
  });
}
