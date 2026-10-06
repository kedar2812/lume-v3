// @vitest-environment node
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { toWebp } from "./capture";

describe("the website's captures as WebP", () => {
  it("keeps the size and writes a WebP", async () => {
    const png = await sharp({ create: { width: 2880, height: 1800, channels: 3, background: "#07080b" } })
      .png()
      .toBuffer();
    const out = path.join(mkdtempSync(path.join(tmpdir(), "cap-")), "x.webp");
    const r = await toWebp(png, out);
    expect([r.width, r.height]).toEqual([2880, 1800]);
    expect(readFileSync(out).subarray(8, 12).toString()).toBe("WEBP");
  });
});
