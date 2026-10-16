/**
 * Each person's look (7C, canvas Profile): their initials on a colour, or a photo they lined up. The browser crops
 * and encodes the photo (a 256 px square); the API takes it only if it's exactly that and nothing more — the size
 * read from the header before anything decodes it, and no metadata (where it was taken, and with what), animation
 * or extra parts. Pure byte checks: no image library on the server.
 */
import { readImage } from "../images/read";

/** Deep enough that white initials reach 4.5:1 on every one (WCAG AA). No violet (owner, 2026-10-01). */
export const AVATAR_COLORS = {
  red: "#C62A30",
  amber: "#A15C00",
  blue: "#2A5BFF",
  green: "#0F7F44",
  rose: "#B02E6B",
  teal: "#0B7285",
} as const;
export type AvatarColor = keyof typeof AVATAR_COLORS;
export const isAvatarColor = (v: unknown): v is AvatarColor =>
  typeof v === "string" && Object.hasOwn(AVATAR_COLORS, v);

export const AVATAR_SIZE = 256;
export const AVATAR_MAX_BYTES = 200 * 1024;

export type AvatarCheck = { ok: true; type: "image/webp" | "image/jpeg" } | { ok: false; reason: string };

export function checkAvatarImage(b: Uint8Array): AvatarCheck {
  if (b.length > AVATAR_MAX_BYTES) return { ok: false, reason: "over 200 KB" };
  const r = readImage(b, (w, h) => (w === AVATAR_SIZE && h === AVATAR_SIZE ? null : "not 256 × 256"));
  return r.ok ? { ok: true, type: r.type } : r;
}
