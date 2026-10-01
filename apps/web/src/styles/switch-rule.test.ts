import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Every stylesheet under src/. */
function sheets(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? sheets(p) : p.endsWith(".css") ? [p] : [];
  });
}

/**
 * The owner's switch rule (2026-10-01): a switch is green when on, everywhere. Blue is never a state, it's
 * the action and where you are. So any rule styling an on switch ([aria-checked="true"] or :checked) with a
 * background must use the green tokens.
 */
describe("the switch rule", () => {
  const root = path.join(__dirname, "..");
  const onRules = sheets(root).flatMap((file) => {
    const css = readFileSync(file, "utf8");
    return (
      [...css.matchAll(/([^{}]*(?:\[aria-checked="true"\]|:checked)[^{}]*)\{([^{}]*)\}/g)]
        // Switches and toggles only: a picked menu item, segment or card is a selection, and selections are blue.
        .filter((m) => /switch|toggle/i.test(m[1]!) && /background(-color)?\s*:/.test(m[2]!))
        .map((m) => ({ file: path.relative(root, file), selector: m[1]!.trim(), body: m[2]! }))
    );
  });

  it("finds the switches it guards", () => {
    expect(onRules.length).toBeGreaterThan(0);
  });

  it.each(onRules.map((r) => [`${r.file} ${r.selector}`, r] as const))("%s is green when on", (_label, r) => {
    const bg = r.body.match(/background(?:-color)?\s*:\s*([^;]+)/)![1]!;
    expect(bg).toMatch(/var\(--ok(-fill)?[,)]/);
  });
});
