import { describe, expect, it } from "vitest";
import { PHOTO_FORMATS, VIDEO_FORMATS, formatProblem, formatProblemOf } from "./formats";

const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("a video or photo WhatsApp won't take, said in words (owner 2026-11-18)", () => {
  it("as it's chosen: a QuickTime, AVI, MKV or WebM video is MP4 only; MP4, 3GP and M4V pass", () => {
    for (const [name, type] of [
      ["clip.mov", "video/quicktime"],
      ["clip.MOV", ""],
      ["clip.avi", "video/x-msvideo"],
      ["clip.mkv", "video/x-matroska"],
      ["clip.webm", "video/webm"],
    ] as const)
      expect([name, formatProblem({ name, type })]).toEqual([name, VIDEO_FORMATS]);
    for (const [name, type] of [
      ["clip.mp4", "video/mp4"],
      ["clip.3gp", "video/3gpp"],
      ["clip.m4v", "video/x-m4v"],
    ] as const)
      expect([name, formatProblem({ name, type })]).toEqual([name, null]);
  });

  it("as it's chosen: a HEIC, WebP or GIF photo is JPEG or PNG only; a document is none of this", () => {
    for (const [name, type] of [
      ["IMG_0001.HEIC", "image/heic"],
      ["IMG_0001.heic", ""],
      ["photo.webp", "image/webp"],
      ["smile.gif", "image/gif"],
    ] as const)
      expect([name, formatProblem({ name, type })]).toEqual([name, PHOTO_FORMATS]);
    for (const [name, type] of [
      ["photo.jpg", "image/jpeg"],
      ["logo.png", "image/png"],
      ["Price list.pdf", "application/pdf"],
      ["notes", ""],
    ] as const)
      expect([name, formatProblem({ name, type })]).toEqual([name, null]);
  });

  it("from its bytes, whatever its name: QuickTime, AVI, Matroska; HEIC, AVIF, WebP, GIF", () => {
    expect(formatProblemOf(bytes([0, 0, 0, 20], "ftypqt  "), "x.mp4")).toBe(VIDEO_FORMATS);
    expect(formatProblemOf(bytes([0, 0, 0, 8], "moov"), "x")).toBe(VIDEO_FORMATS);
    expect(formatProblemOf(bytes("RIFF", [0, 0, 0, 0], "AVI LIST"), "x")).toBe(VIDEO_FORMATS);
    expect(formatProblemOf(bytes([0x1a, 0x45, 0xdf, 0xa3], "webm"), "x")).toBe(VIDEO_FORMATS);
    expect(formatProblemOf(bytes([0, 0, 0, 24], "ftypheic"), "x.jpg")).toBe(PHOTO_FORMATS);
    expect(formatProblemOf(bytes([0, 0, 0, 24], "ftypavif"), "x")).toBe(PHOTO_FORMATS);
    expect(formatProblemOf(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "), "x")).toBe(PHOTO_FORMATS);
    expect(formatProblemOf(bytes("GIF89a"), "x")).toBe(PHOTO_FORMATS);
  });

  it("from its bytes: anything else (a program, a page) isn't called a video or a photo, even named like one", () => {
    expect(formatProblemOf(bytes("MZ", [0x90, 0]), "photo.jpg")).toBeNull();
    expect(formatProblemOf(bytes("<svg onload=alert(1)>"), "logo.png")).toBeNull();
    expect(formatProblemOf(bytes("<html>"), "film.mov")).toBe(VIDEO_FORMATS); // named a video: the video words help
  });
});
