import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apiSchema, loadConfig } from "./index";

/**
 * Postgres takes 100 connections (infra/postgres/postgresql.conf). Every pool LUME opens has to fit inside that at
 * once, or a busy hour (owner 2026-11-06: a thousand people at once) meets "too many clients" instead of an answer.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

/** Each `new PgBoss({ … })` in a file, as its options' text. */
function bossOptions(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found: string[] = [];
  for (let at = text.indexOf("new PgBoss("); at >= 0; at = text.indexOf("new PgBoss(", at + 1)) {
    let depth = 0;
    let end = at;
    for (let i = text.indexOf("(", at); i < text.length; i++) {
      if (text[i] === "(") depth++;
      if (text[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    found.push(text.slice(at, end + 1));
  }
  return found;
}

describe("LUME's connections fit inside Postgres's 100", () => {
  it("every job queue says how many connections it may hold (pg-boss would otherwise take 10)", () => {
    const queues = ["apps/api/src", "apps/worker/src"]
      .flatMap((d) => sources(path.join(ROOT, d)))
      .flatMap((f) => bossOptions(f).map((o) => ({ file: path.relative(ROOT, f), o })));
    expect(queues.length).toBeGreaterThan(5);
    const unbounded = queues.filter((q) => !/\bmax:\s*\S/.test(q.o)).map((q) => q.file);
    expect(unbounded).toEqual([]);
  });

  it("the requests' and the jobs' pools together stay within 44 (the rest is the queues, the worker and Postgres's own)", () => {
    const env = {
      LUME_PUBLIC_HOST: "lume.localhost",
      LUME_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
      DATABASE_URL_APP: "postgres://lume_app:k3yP4ssw0rdL0ngEnough9@db:5432/lume",
    };
    const fits = (pool: string, jobs: string) => () =>
      loadConfig(apiSchema, { ...env, DB_POOL_MAX: pool, DB_JOB_POOL_MAX: jobs });
    expect(fits("20", "14")).not.toThrow();
    expect(fits("30", "14")).not.toThrow();
    expect(fits("31", "14")).toThrow(/DB_POOL_MAX/);
    expect(fits("20", "30")).toThrow(/DB_POOL_MAX/);
  });
});
