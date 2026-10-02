import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COLOURS } from "@/components/settings/ColourPicker";

/** Every stylesheet and component under src/ (tests aside). */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(css|tsx?)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

/** A colour's hue in degrees and its saturation, from #rgb or #rrggbb. */
function hueSat(hex: string): { h: number; s: number } {
  const v = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  const l = (max + min) / 2;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s };
}

/**
 * The owner's rule (2026-10-01): no violet anywhere. LUME's blue (#2A5BFF, hue 227) and the sky touch stay
 * below 245°; a colour from 245° to 300° with real saturation reads as violet or purple.
 */
describe("no violet anywhere", () => {
  const root = path.join(__dirname, "..");
  const colours = sources(root).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)].map((m) => ({
      file: path.relative(root, file),
      hex: m[0],
    })),
  );

  it("finds the colours it guards", () => {
    expect(colours.length).toBeGreaterThan(50);
  });

  it("no stylesheet or component uses a violet or purple", () => {
    const violet = colours.filter(({ hex }) => {
      const { h, s } = hueSat(hex);
      return s > 0.25 && h >= 245 && h <= 300;
    });
    expect(violet).toEqual([]);
  });

  it("no colour is offered by the name Violet", () => {
    expect(COLOURS.map(([, name]) => name)).not.toContain("Violet");
  });
});
