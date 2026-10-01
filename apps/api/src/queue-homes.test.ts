import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { QUEUE_NAMES } from "@lume/core";
import { describe, expect, it } from "vitest";

/** Every `boss.work("<name>"` in an app's sources (tests left out). */
function worked(dir: string): Set<string> {
  const out = new Set<string>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f))
        for (const m of readFileSync(p, "utf8").matchAll(/\.work(?:<[^>]*>)?\(\s*"([a-z.-]+)"/g))
          out.add(m[1]!);
    }
  };
  walk(dir);
  return out;
}

describe("pg-boss queues (2A note, checked in the minors sweep)", () => {
  const api = worked(path.resolve(import.meta.dirname, "."));
  const worker = worked(path.resolve(import.meta.dirname, "../../worker/src"));

  it("each queue is worked in one place only: the API (as lume_app) or the worker (as lume_worker)", () => {
    expect([...api].filter((q) => worker.has(q))).toEqual([]);
    expect(api.size).toBeGreaterThan(0);
    expect(worker.size).toBeGreaterThan(0);
  });

  it("every queue worked is one the migrate step creates", () => {
    const known = new Set<string>(QUEUE_NAMES);
    expect([...api, ...worker].filter((q) => !known.has(q))).toEqual([]);
  });
});
