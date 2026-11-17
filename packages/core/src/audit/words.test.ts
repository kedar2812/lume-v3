import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "./words";

/** Every .ts file under a folder, tests left out. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith(".ts") && !/\.test\.ts$/.test(p) ? [p] : [];
  });
}

describe("every action the API writes to the audit log has its words (bug hunt 2026-11-17)", () => {
  it("found in the API's own code, so a new one can't ship as its key", () => {
    const api = fileURLToPath(new URL("../../../../apps/api/src", import.meta.url));
    const written = new Set<string>();
    for (const file of sources(api)) {
      const text = readFileSync(file, "utf8");
      // audit(req, { action: "x.y", … }) and its multi-line form.
      for (const m of text.matchAll(/audit\([^)]*?action:\s*"([a-z_]+\.[a-z_.]+)"/gs)) written.add(m[1]!);
    }
    expect(written.size).toBeGreaterThan(50);
    const missing = [...written].filter((a) => !AUDIT_ACTIONS[a]).sort();
    expect(missing).toEqual([]);
  });
});
