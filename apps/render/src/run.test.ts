import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RenderError, run } from "./run";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "lume-run-test-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a tool, run under its limits", () => {
  it("gives back what the tool printed", async () => {
    const out = await run("sh", ["-c", "printf 'Pages: 3\\n'"], { cwd: dir, seconds: 5 });
    expect(out.toString()).toBe("Pages: 3\n");
  });

  it("a tool that fails is a file it couldn't render (422), with what the tool said", async () => {
    const e = await run("sh", ["-c", "echo broken >&2; exit 3"], { cwd: dir, seconds: 5 }).catch((x) => x);
    expect(e).toBeInstanceOf(RenderError);
    expect(e.status).toBe(422);
    expect(e.message).toContain("broken");
  });

  it("a tool past its time is stopped, with everything it started", async () => {
    const started = Date.now();
    let child = 0;
    const e = await run("sh", ["-c", "sleep 30 & echo $!; wait"], {
      cwd: dir,
      seconds: 0.5,
      onStdout: (b) => (child = Number(b.toString().trim())),
    }).catch((x) => x);
    expect(e).toBeInstanceOf(RenderError);
    expect(e.status).toBe(422);
    expect(e.message).toMatch(/took longer than/);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(child).toBeGreaterThan(0);
    // The group is killed, so the sleep it started in the background goes too.
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(child)).toBe(false);
  });

  it("a tool that prints without end is stopped at the cap", async () => {
    const e = await run("sh", ["-c", "yes"], { cwd: dir, seconds: 10, maxOut: 64 * 1024 }).catch((x) => x);
    expect(e).toBeInstanceOf(RenderError);
    expect(e.message).toMatch(/too much/);
  });

  it("runs with only the environment it's given", async () => {
    const out = await run("sh", ["-c", "echo ${SECRET:-none} $HOME"], {
      cwd: dir,
      seconds: 5,
      env: { HOME: dir },
    });
    expect(out.toString().trim()).toBe(`none ${dir}`);
  });
});
