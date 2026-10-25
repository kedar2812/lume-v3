import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Limits } from "./limits";
import { REGISTRY } from "./profile";
import { RenderError, run } from "./run";

/*
 * What LUME shows of a file before it's opened: a thumbnail of its content (a photo's picture, a PDF's first page, a
 * frame of a video), and for Word, Excel and PowerPoint a PDF to page through. Each job in a folder of its own on the
 * tmpfs, removed after; each tool under the job's time limit.
 */

export type Thumb = { webp: Buffer; pages?: number; durationMs?: number; width?: number; height?: number };

export const OFFICE = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
} as const;

/** What a thumbnail is made from, by its type, with the name the tools are given it under. */
export const THUMB_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};
/** What becomes a PDF: Office files, and plain text (whose thumbnail is its first page). */
export const PDF_TYPES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(OFFICE).map(([ext, mime]) => [mime, ext])),
  "text/plain": "txt",
};

const starts = (b: Buffer, sig: string | number[], at = 0) => {
  const s = typeof sig === "string" ? Buffer.from(sig, "latin1") : Buffer.from(sig);
  return b.length >= at + s.length && b.subarray(at, at + s.length).equals(s);
};
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * Whether the bytes are what they're called. The API has already read them (sniff.ts); this is the service's own
 * check, so nothing it's sent can choose which of the tools' many readers opens it.
 */
export function looksLike(bytes: Buffer, mime: string): boolean {
  switch (mime) {
    case "image/jpeg":
      return starts(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "video/mp4":
    case "video/3gpp":
      return starts(bytes, "ftyp", 4);
    case "application/pdf":
      return starts(bytes, "%PDF-");
    case OFFICE.docx:
    case OFFICE.xlsx:
    case OFFICE.pptx:
      return starts(bytes, "PK\x03\x04");
    case OFFICE.doc:
    case OFFICE.xls:
    case OFFICE.ppt:
      return starts(bytes, OLE);
    case "text/plain":
      return !bytes.includes(0);
    default:
      return false;
  }
}

async function withJob<T>(fn: (dir: string, env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "job-"));
  const env = { HOME: dir, TMPDIR: dir, XDG_CACHE_HOME: path.join(dir, ".cache"), VIPS_BLOCK_UNTRUSTED: "1" };
  try {
    return await fn(dir, env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fields = (out: Buffer) =>
  Object.fromEntries(
    out
      .toString()
      .split("\n")
      .map((l) => l.match(/^([\w ]+?):\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => [m[1]!.trim().toLowerCase(), m[2]!.trim()]),
  );
const num = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Any picture the tools made, as a WebP at most `longest` on its longer side, never made bigger. */
async function webpOf(input: string, dir: string, env: Record<string, string>, l: Limits): Promise<Buffer> {
  const out = path.join(dir, "thumb.webp");
  await run("vipsthumbnail", [input, "-s", `${l.longest}x${l.longest}>`, "-o", `${out}[Q=82,strip]`], {
    cwd: dir,
    seconds: l.seconds,
    env,
  });
  return readFile(out);
}

async function imageThumb(
  input: string,
  dir: string,
  env: Record<string, string>,
  l: Limits,
): Promise<Thumb> {
  const h = fields(
    await run("vipsheader", ["-a", input], { cwd: dir, seconds: l.seconds, env, maxOut: l.maxOut }),
  );
  const [w, hgt] = [num(h.width), num(h.height)];
  // EXIF orientations 5–8 turn the picture a quarter: it stands the other way round.
  const turned = Number(h.orientation) >= 5;
  return { webp: await webpOf(input, dir, env, l), width: turned ? hgt : w, height: turned ? w : hgt };
}

async function videoThumb(
  input: string,
  dir: string,
  env: Record<string, string>,
  l: Limits,
): Promise<Thumb> {
  const probe = JSON.parse(
    (
      await run(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height:stream_side_data=rotation:stream_tags=rotate:format=duration",
          "-of",
          "json",
          input,
        ],
        { cwd: dir, seconds: l.seconds, env, maxOut: l.maxOut },
      )
    ).toString(),
  ) as {
    streams?: {
      width?: number;
      height?: number;
      tags?: { rotate?: string };
      side_data_list?: { rotation?: number }[];
    }[];
    format?: { duration?: string };
  };
  const stream = probe.streams?.[0];
  if (!stream?.width || !stream.height) throw new RenderError("This video has no picture");
  const seconds = num(probe.format?.duration);
  const rotation = Math.abs(
    Number(
      stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0,
    ),
  );
  const turned = rotation % 180 === 90;
  // A tenth of the way in: past a fade from black, early enough to be what it's about.
  const at = seconds ? Math.max(0, Math.min(seconds * 0.1, seconds - 0.1)) : 0;
  const frame = path.join(dir, "frame.png");
  await run(
    "ffmpeg",
    ["-v", "error", "-ss", at.toFixed(3), "-i", input, "-frames:v", "1", "-an", "-y", frame],
    {
      cwd: dir,
      seconds: l.seconds,
      env,
    },
  );
  return {
    webp: await webpOf(frame, dir, env, l),
    durationMs: seconds ? Math.round(seconds * 1000) : undefined,
    width: turned ? stream.height : stream.width,
    height: turned ? stream.width : stream.height,
  };
}

async function pdfThumb(input: string, dir: string, env: Record<string, string>, l: Limits): Promise<Thumb> {
  const info = fields(await run("pdfinfo", [input], { cwd: dir, seconds: l.seconds, env, maxOut: l.maxOut }));
  const pages = num(info.pages);
  if (!pages) throw new RenderError("This PDF has no pages");
  const size = info["page size"]?.match(/([\d.]+) x ([\d.]+)/);
  const turned = Number(info["page rot"]) % 180 === 90;
  const [w, h] = size ? [Math.round(Number(size[1])), Math.round(Number(size[2]))] : [undefined, undefined];
  const page = path.join(dir, "page");
  await run(
    "pdftoppm",
    ["-f", "1", "-l", "1", "-singlefile", "-png", "-scale-to", String(l.longest), input, page],
    {
      cwd: dir,
      seconds: l.seconds,
      env,
    },
  );
  return {
    webp: await webpOf(`${page}.png`, dir, env, l),
    pages,
    width: turned ? h : w,
    height: turned ? w : h,
  };
}

/** A thumbnail of a photo, a video or a PDF. */
export async function thumbOf(bytes: Buffer, mime: string, l: Limits): Promise<Thumb> {
  const ext = THUMB_TYPES[mime];
  if (!ext || !looksLike(bytes, mime)) throw new RenderError("LUME can't make a thumbnail of this", 415);
  return withJob(async (dir, env) => {
    const input = path.join(dir, `in.${ext}`);
    await writeFile(input, bytes);
    if (mime.startsWith("image/")) return imageThumb(input, dir, env, l);
    if (mime.startsWith("video/")) return videoThumb(input, dir, env, l);
    return pdfThumb(input, dir, env, l);
  });
}

/** What a photo for WhatsApp is made from. */
export const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png" };

/**
 * A photo too big for WhatsApp (5 MB) as a JPEG that fits (owner, 2026-10-25): turned the way it was taken, its
 * longest side at most 2560, then smaller and plainer until it fits.
 */
export async function photoOf(bytes: Buffer, mime: string, l: Limits): Promise<Buffer> {
  const ext = PHOTO_TYPES[mime];
  if (!ext || !looksLike(bytes, mime)) throw new RenderError("LUME can't make a photo of this", 415);
  return withJob(async (dir, env) => {
    const input = path.join(dir, `in.${ext}`);
    await writeFile(input, bytes);
    const out = path.join(dir, "photo.jpg");
    for (const [scale, q] of [
      [1, 85],
      [0.75, 80],
      [0.6, 75],
      [0.45, 70],
    ] as const) {
      const side = Math.round(l.photoLongest * scale);
      await run("vipsthumbnail", [input, "-s", `${side}x${side}>`, "-o", `${out}[Q=${q},strip]`], {
        cwd: dir,
        seconds: l.seconds,
        env,
      });
      const made = await readFile(out);
      if (made.length <= l.photoBytes) return made;
    }
    throw new RenderError("This photo won't fit WhatsApp's 5 MB");
  });
}

/** An Office file or a text file as a PDF, by LibreOffice in a profile of its own (profile.ts). */
export async function pdfOf(bytes: Buffer, mime: string, l: Limits): Promise<Buffer> {
  const ext = PDF_TYPES[mime];
  if (!ext || !looksLike(bytes, mime)) throw new RenderError("LUME can't make a PDF of this", 415);
  return withJob(async (dir, env) => {
    const input = path.join(dir, `in.${ext}`);
    const outDir = path.join(dir, "out");
    await writeFile(input, bytes);
    await mkdir(path.join(dir, "lo", "user"), { recursive: true });
    await mkdir(outDir);
    await writeFile(path.join(dir, "lo", "user", "registrymodifications.xcu"), REGISTRY);
    await run(
      "soffice",
      [
        `-env:UserInstallation=file://${path.join(dir, "lo")}`,
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        "--nologo",
        ...(ext === "txt" ? ["--infilter=Text (encoded):UTF8"] : []),
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        input,
      ],
      { cwd: dir, seconds: l.seconds, env },
    );
    // LibreOffice says nothing and exits 0 when it can't read a file: what it made is the answer.
    const out = path.join(outDir, "in.pdf");
    const made = await stat(out).catch(() => null);
    if (!made?.isFile() || made.size === 0) throw new RenderError("LibreOffice couldn't read this file");
    if (made.size > l.pdfBytes) throw new RenderError("This file makes a PDF too big to keep");
    return readFile(out);
  });
}
