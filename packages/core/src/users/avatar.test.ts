import { describe, expect, it } from "vitest";
import { AVATAR_COLORS, AVATAR_SIZE, checkAvatarImage } from "./avatar";

const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const chunk = (fourcc: string, payload: number[]) => [
  ...ascii(fourcc),
  ...le32(payload.length),
  ...payload,
  ...(payload.length % 2 ? [0] : []),
];
const riff = (...chunks: number[][]) => {
  const body = [...ascii("WEBP"), ...chunks.flat()];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
};
/** A lossy frame header: frame tag, start code, then 14-bit width and height. */
const vp8 = (w = 256, h = 256) =>
  chunk("VP8 ", [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, w & 255, w >> 8, h & 255, h >> 8, 1, 2, 3, 4]);
const vp8l = (w = 256, h = 256) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return chunk("VP8L", [0x2f, ...le32(bits), 9, 9, 9]);
};
const vp8x = (flags: number, w = 256, h = 256) =>
  chunk("VP8X", [flags, 0, 0, 0, (w - 1) & 255, (w - 1) >> 8, 0, (h - 1) & 255, (h - 1) >> 8, 0]);

const jpeg = (w = 256, h = 256, extra: number[][] = []) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...ascii("JFIF"),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    ...extra.flat(),
    0xff,
    0xdb,
    0x00,
    0x04,
    0x00,
    0x01,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    h >> 8,
    h & 255,
    w >> 8,
    w & 255,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xc4,
    0x00,
    0x03,
    0x00,
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    0x12,
    0x34,
    0xff,
    0x00,
    0x56,
    0xff,
    0xd9,
  ]);

describe("avatar images (7C)", () => {
  it("has six colours, each deep enough for white initials, and no violet", () => {
    expect(Object.keys(AVATAR_COLORS)).toEqual(["red", "amber", "blue", "green", "rose", "teal"]);
    expect(AVATAR_SIZE).toBe(256);
  });

  it("takes a 256 px square WebP the browser made: lossy, lossless, or extended with alpha", () => {
    expect(checkAvatarImage(riff(vp8()))).toEqual({ ok: true, type: "image/webp" });
    expect(checkAvatarImage(riff(vp8l()))).toEqual({ ok: true, type: "image/webp" });
    expect(checkAvatarImage(riff(vp8x(0x10), chunk("ALPH", [0, 1, 2]), vp8()))).toEqual({
      ok: true,
      type: "image/webp",
    });
  });

  it("takes a 256 px square JPEG with nothing but the picture", () => {
    expect(checkAvatarImage(jpeg())).toEqual({ ok: true, type: "image/jpeg" });
  });

  it("refuses anything else: other sizes, metadata, animation, extra or broken parts, other formats", () => {
    const bad = (bytes: Uint8Array) => checkAvatarImage(bytes).ok;
    expect(bad(riff(vp8(512, 512)))).toBe(false); // a big decode: the bomb guard
    expect(bad(riff(vp8(256, 200)))).toBe(false);
    expect(bad(riff(vp8l(4000, 4000)))).toBe(false);
    expect(bad(riff(vp8x(0x02), vp8()))).toBe(false); // animated
    expect(bad(riff(vp8x(0x08), vp8()))).toBe(false); // says it has EXIF
    expect(bad(riff(vp8(), chunk("EXIF", [1, 2, 3, 4])))).toBe(false); // where they took it, and with what
    expect(bad(riff(vp8(), vp8()))).toBe(false); // two pictures
    expect(bad(riff())).toBe(false);
    const truncated = riff(vp8()).slice(0, 20);
    expect(bad(truncated)).toBe(false);
    const lying = riff(vp8());
    lying[4] = 200; // the size says more than there is
    expect(bad(lying)).toBe(false);
    expect(bad(jpeg(256, 256, [[0xff, 0xe1, 0x00, 0x06, ...ascii("Exif")]]))).toBe(false);
    expect(bad(jpeg(1024, 1024))).toBe(false);
    expect(bad(jpeg().slice(0, 30))).toBe(false);
    expect(bad(new Uint8Array([0x89, ...ascii("PNG"), 13, 10, 26, 10]))).toBe(false);
    expect(bad(new Uint8Array(204_801))).toBe(false); // over 200 KB
  });
});
