import { describe, expect, it } from "vitest";
import { checkFeedbackImage } from "../feedback/rules";
import { cleanImage } from "./clean";

describe("cleanImage", () => {
  const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const chunk = (id: string, body: number[]) => [
    ...ascii(id),
    ...le32(body.length),
    ...body,
    ...(body.length % 2 ? [0] : []),
  ];
  const riff = (...chunks: number[][]) => {
    const body = [...ascii("WEBP"), ...chunks.flat()];
    return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
  };
  const vp8x = (flags: number, w: number, h: number) =>
    chunk("VP8X", [flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
  const vp8 = (w: number, h: number) =>
    chunk("VP8 ", [
      0x10,
      0x02,
      0x00,
      0x9d,
      0x01,
      0x2a,
      w & 255,
      (w >> 8) & 0x3f,
      h & 255,
      (h >> 8) & 0x3f,
      1,
      2,
      3,
      4,
    ]);
  const ids = (b: Uint8Array) => {
    const out: string[] = [];
    for (let at = 12; at + 8 <= b.length;) {
      const len = b[at + 4]! | (b[at + 5]! << 8) | (b[at + 6]! << 16) | (b[at + 7]! << 24);
      out.push(String.fromCharCode(...b.subarray(at, at + 4)));
      at += 8 + len + (len % 2);
    }
    return out;
  };

  it("takes the colour profile Chrome puts in every canvas WebP out, so LUME's own check takes it", () => {
    // Chrome's canvas WebP, as made on the dev box: VP8X (colour profile flag) · ICCP · VP8.
    const chrome = riff(vp8x(0x20, 1600, 900), chunk("ICCP", [1, 2, 3, 4, 5]), vp8(1600, 900));
    expect(checkFeedbackImage(chrome).ok).toBe(false);
    const clean = cleanImage(chrome, "image/webp");
    expect(ids(clean)).toEqual(["VP8X", "VP8 "]);
    expect(checkFeedbackImage(clean)).toEqual({ ok: true, type: "image/webp", width: 1600, height: 900 });
  });

  it("keeps transparency, and drops metadata too", () => {
    const alpha = riff(
      vp8x(0x20 | 0x10 | 0x08 | 0x04, 40, 30),
      chunk("ICCP", [9, 9]),
      chunk("ALPH", [0, 7, 7]),
      vp8(40, 30),
      chunk("EXIF", [1]),
      chunk("XMP ", [2, 2]),
    );
    const clean = cleanImage(alpha, "image/webp");
    expect(ids(clean)).toEqual(["VP8X", "ALPH", "VP8 "]);
    expect(clean[20]).toBe(0x10);
    expect(checkFeedbackImage(clean)).toMatchObject({ ok: true, width: 40, height: 30 });
  });

  it("takes a JPEG's colour profile, EXIF and comments out, before its frame", () => {
    const seg = (m: number, body: number[]) => [
      0xff,
      m,
      (body.length + 2) >> 8,
      (body.length + 2) & 255,
      ...body,
    ];
    const jpeg = new Uint8Array([
      0xff,
      0xd8,
      ...seg(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
      ...seg(0xe1, [...ascii("Exif"), 0, 0, 1, 2]),
      ...seg(0xe2, [...ascii("ICC_PROFILE"), 0, 1, 1, 5, 5]),
      ...seg(0xfe, ascii("made somewhere")),
      ...seg(0xdb, [0x00, 0x01]),
      ...seg(0xc0, [0x08, 0, 30, 0, 40, 0x01, 0x01, 0x11, 0x00]),
      ...seg(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
      0x12,
      0x34,
      0xff,
      0xd9,
    ]);
    expect(checkFeedbackImage(jpeg).ok).toBe(false);
    const clean = cleanImage(jpeg, "image/jpeg");
    expect(checkFeedbackImage(clean)).toEqual({ ok: true, type: "image/jpeg", width: 40, height: 30 });
    expect(clean.length).toBe(jpeg.length - (4 + 8) - (4 + 16) - (4 + 14));
  });

  it("leaves a clean picture, or anything it can't read, exactly as it was", () => {
    const plain = riff(vp8(800, 600));
    expect(cleanImage(plain, "image/webp")).toEqual(plain);
    const junk = new Uint8Array([1, 2, 3]);
    expect(cleanImage(junk, "image/webp")).toEqual(junk);
    expect(cleanImage(junk, "image/jpeg")).toEqual(junk);
  });
});
