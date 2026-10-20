import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits";
import { pdfOf, thumbOf, OFFICE } from "../src/render";
import { RenderError, run } from "../src/run";
import { fodp, fods, fodt, withOrientation } from "./fixtures";

/*
 * The real tools, in the image they ship in (`docker build --target test -f infra/docker/render.Dockerfile .`).
 * Every fixture is made here by those same tools from text, so nothing binary lives in the repo.
 */

let dir: string;
const f: Record<string, Buffer> = {};
const tool = (cmd: string, args: string[]) => run(cmd, args, { cwd: dir, seconds: 120, env: { HOME: dir } });
const soffice = (name: string, to: string) =>
  tool("soffice", [
    `-env:UserInstallation=file://${dir}/lo`,
    "--headless",
    "--norestore",
    "--convert-to",
    to,
    "--outdir",
    dir,
    path.join(dir, name),
  ]);

/** Width and height of a WebP, read by vips (so the test trusts no code of ours to say it). */
async function sizeOf(webp: Buffer): Promise<{ format: string; width: number; height: number }> {
  const p = path.join(dir, `probe-${Math.random().toString(36).slice(2)}.webp`);
  await writeFile(p, webp);
  const out = (await tool("vipsheader", ["-a", p])).toString();
  const field = (k: string) => out.match(new RegExp(`^${k}: (.+)$`, "m"))?.[1] ?? "";
  return {
    format: webp.subarray(8, 12).toString("latin1"),
    width: Number(field("width")),
    height: Number(field("height")),
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "lume-render-itest-"));
  await tool("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x2A5BFF:s=2000x1000",
    "-frames:v",
    "1",
    "wide.png",
  ]);
  await tool("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xC9B8A3:s=2000x1000",
    "-frames:v",
    "1",
    "wide.jpg",
  ]);
  await tool("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=3:size=640x360:rate=25",
    "-pix_fmt",
    "yuv420p",
    "clip.mp4",
  ]);
  f.png = await readFile(path.join(dir, "wide.png"));
  // A phone photo taken upright: stored 2000×1000, its EXIF saying "turn me 90°".
  f.jpg = withOrientation(await readFile(path.join(dir, "wide.jpg")), 6);
  f.mp4 = await readFile(path.join(dir, "clip.mp4"));
  await writeFile(path.join(dir, "brochure.fodt"), fodt(["Brightpath Interiors", "Kitchens", "Wardrobes"]));
  await writeFile(
    path.join(dir, "prices.fods"),
    fods([
      ["Design consult", 2500],
      ["Home, 2 BHK", 380000],
    ]),
  );
  await writeFile(path.join(dir, "deck.fodp"), fodp(["Our work", "Our prices"]));
  await soffice("brochure.fodt", "pdf");
  await soffice("brochure.fodt", "docx");
  await soffice("prices.fods", "xlsx");
  await soffice("deck.fodp", "pptx");
  f.pdf = await readFile(path.join(dir, "brochure.pdf"));
  f.docx = await readFile(path.join(dir, "brochure.docx"));
  f.xlsx = await readFile(path.join(dir, "prices.xlsx"));
  f.pptx = await readFile(path.join(dir, "deck.pptx"));
}, 300_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("thumbnails, by the real tools", () => {
  it("a PNG: a WebP no bigger than 960 on its longest side, and its own size", async () => {
    const t = await thumbOf(f.png!, "image/png", LIMITS);
    expect(await sizeOf(t.webp)).toEqual({ format: "WEBP", width: 960, height: 480 });
    expect([t.width, t.height]).toEqual([2000, 1000]);
  });

  it("a phone photo stands the way it was taken", async () => {
    const t = await thumbOf(f.jpg!, "image/jpeg", LIMITS);
    expect(await sizeOf(t.webp)).toEqual({ format: "WEBP", width: 480, height: 960 });
    expect([t.width, t.height]).toEqual([1000, 2000]);
  });

  it("a small photo isn't made bigger", async () => {
    await tool("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=200x100",
      "-frames:v",
      "1",
      "small.png",
    ]);
    const t = await thumbOf(await readFile(path.join(dir, "small.png")), "image/png", LIMITS);
    expect(await sizeOf(t.webp)).toEqual({ format: "WEBP", width: 200, height: 100 });
  });

  it("a PDF: its first page, and how many pages it has", async () => {
    const t = await thumbOf(f.pdf!, "application/pdf", LIMITS);
    const s = await sizeOf(t.webp);
    expect(s.format).toBe("WEBP");
    expect(Math.max(s.width, s.height)).toBe(960);
    expect(s.height).toBeGreaterThan(s.width); // a portrait page
    expect(t.pages).toBe(3);
  });

  it("a video: a frame from it, its length and its size", async () => {
    const t = await thumbOf(f.mp4!, "video/mp4", LIMITS);
    expect(await sizeOf(t.webp)).toEqual({ format: "WEBP", width: 640, height: 360 });
    expect(t.durationMs).toBeGreaterThanOrEqual(2900);
    expect(t.durationMs).toBeLessThanOrEqual(3100);
    expect([t.width, t.height]).toEqual([640, 360]);
  });

  it("a PDF that isn't one is a file it couldn't render", async () => {
    const e = await thumbOf(Buffer.from("%PDF-1.7\nnot really"), "application/pdf", LIMITS).catch((x) => x);
    expect(e).toBeInstanceOf(RenderError);
    expect(e.status).toBe(422);
  });
});

describe("Office files as PDFs, by the real tools", () => {
  it("a .docx: its pages, its words kept", async () => {
    const pdf = await pdfOf(f.docx!, OFFICE.docx, LIMITS);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect((await thumbOf(pdf, "application/pdf", LIMITS)).pages).toBe(3);
    await writeFile(path.join(dir, "out.pdf"), pdf);
    expect((await tool("pdftotext", ["out.pdf", "-"])).toString()).toContain("Wardrobes");
  });

  it("a .pptx: one page per slide", async () => {
    const pdf = await pdfOf(f.pptx!, OFFICE.pptx, LIMITS);
    expect((await thumbOf(pdf, "application/pdf", LIMITS)).pages).toBe(2);
  });

  it("an .xlsx: its sheet, its figures kept", async () => {
    const pdf = await pdfOf(f.xlsx!, OFFICE.xlsx, LIMITS);
    await writeFile(path.join(dir, "sheet.pdf"), pdf);
    expect((await tool("pdftotext", ["sheet.pdf", "-"])).toString()).toContain("380000");
  });

  it("a text file in Hindi and Arabic keeps its letters", async () => {
    const pdf = await pdfOf(Buffer.from("नमस्ते\nمرحبا\nHello\n"), "text/plain", LIMITS);
    await writeFile(path.join(dir, "text.pdf"), pdf);
    const words = (await tool("pdftotext", ["text.pdf", "-"])).toString();
    expect(words).toContain("Hello");
    expect(words).toContain("नमस्ते");
  });

  it("limits: a conversion that runs past its time is stopped, and says so (422)", async () => {
    const e = await pdfOf(f.pptx!, OFFICE.pptx, { ...LIMITS, seconds: 0.05 }).catch((x) => x);
    expect(e).toBeInstanceOf(RenderError);
    expect(e.status).toBe(422);
    expect(e.message).toMatch(/took longer than/);
  });
});
