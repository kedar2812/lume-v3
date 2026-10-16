/**
 * The smallest files the reader takes, for tests (never shipped to a browser): a lossy WebP frame header and a JFIF
 * JPEG with one frame and one scan, at any size. They are structurally whole, not pictures anyone could view.
 */
const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function testWebp(w: number, h: number): Uint8Array {
  const payload = [0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, w & 255, (w >> 8) & 0x3f, h & 255, (h >> 8) & 0x3f, 1, 2, 3, 4];
  const chunk = [...ascii("VP8 "), ...le32(payload.length), ...payload];
  const body = [...ascii("WEBP"), ...chunk];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
}

export function testJpeg(w: number, h: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const tables = [0xff, 0xdb, 0x00, 0x04, 0x00, 0x01];
  const frame = [0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00];
  const scan = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34];
  return new Uint8Array([0xff, 0xd8, ...app0, ...tables, ...frame, ...scan, 0xff, 0xd9]);
}
