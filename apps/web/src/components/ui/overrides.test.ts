import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 9 Task 2: a screen's own class on a shared Button can't silently lose to the Button's own styles. A bare
 * `.submit { height: 46px }` and the Button's `.btn { height: 34px }` have the same specificity, so whichever
 * stylesheet loads later wins — and that changes as modules are added (the sign-in button rendered at 34 px for a
 * while). Every class a screen passes to Button or IconButton must either avoid the properties the Button sets, or
 * be qualified (`.card .submit`, `.btn.submit`…) so it wins on specificity, whatever the order.
 */
const SRC = resolve(import.meta.dirname, "../..");
const BUTTON_CSS = readFileSync(resolve(import.meta.dirname, "Button.module.css"), "utf8");

/** The properties the Button's own rule sets, for its base (`""`) and each state (`":hover"`, `":active"`…). */
const propsOf = (pseudo: string) => {
  // The button's own rules (the base, its size and each variant) for that state; not its inner parts (the spinner,
  // the label), whose sizes don't touch the button.
  const own = /^(btn|sm|lg|primary|secondary|whatsapp|danger|ghost)$/;
  const bodies = [...BUTTON_CSS.matchAll(new RegExp(String.raw`\.([a-zA-Z]+)${pseudo}\s*\{([^}]*)\}`, "g"))]
    .filter((b) => own.test(b[1]!))
    .map((b) => [b[0], b[2]] as const);
  return new Set(bodies.flatMap((b) => [...b[1]!.matchAll(/^\s*([a-z-]+)\s*:/gm)].map((m) => m[1]!)));
};
const buttonProps = propsOf("");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") && !p.endsWith(".test.tsx") ? [p] : [];
  });
}

type Finding = { at: string; cls: string; props: string[] };
function audit(): Finding[] {
  const out: Finding[] = [];
  for (const file of files(SRC)) {
    const src = readFileSync(file, "utf8");
    // Up to the next tag: an arrow function (`=>`) before className doesn't end the element.
    for (const m of src.matchAll(/<(?:Button|IconButton)\b[^<]*?className=\{(\w+)\.(\w+)\}/g)) {
      const [, mod, cls] = m;
      const imp = new RegExp(`import ${mod} from "([^"]+\\.module\\.css)"`).exec(src);
      if (!imp) continue;
      const path = imp[1]!;
      const css = readFileSync(
        path.startsWith("@/") ? join(SRC, path.slice(2)) : resolve(dirname(file), path),
        "utf8",
      );
      // Bare rules for this class: the selector is exactly `.cls` (with an optional pseudo-class), nothing before it.
      for (const rule of css.matchAll(new RegExp(`(^|\\})\\s*\\.${cls}(:[a-z-]+)?\\s*\\{([^}]*)\\}`, "g"))) {
        // A state rule (:hover…) ties with the Button's own rule for that state.
        const theirs = rule[2] ? propsOf(rule[2]) : buttonProps;
        const props = [...rule[3]!.matchAll(/^\s*([a-z-]+)\s*:/gm)]
          .map((p) => p[1]!)
          .filter((p) => theirs.has(p));
        if (props.length)
          out.push({ at: `${file.slice(SRC.length + 1)}`, cls: `${cls}${rule[2] ?? ""}`, props });
      }
    }
  }
  return out;
}

describe("a screen's class on a shared Button", () => {
  it("never overrides the Button's own properties at equal specificity", () => {
    expect(audit()).toEqual([]);
  });

  it("the audit finds a bare override", () => {
    expect(buttonProps.has("height")).toBe(true);
  });
});
